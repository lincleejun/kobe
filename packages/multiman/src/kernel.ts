// src/kernel.ts
import type { Dao } from "@/db/dao"
import type { Dag, Task, TaskStatus } from "@/types"
import { assertTransition } from "@/state-machine"
import { hasCycle } from "@/dag"
import { CyclicDagError, GuardError } from "@/errors"

export interface KobeOrchestratorPort {
  adoptWorktree(input: {
    repo: string; worktreePath: string; branch: string; ifExists: "return"
  }): Promise<{ id: string; worktreePath: string }>
}

export interface KernelDeps {
  dao: Dao
  orchestrator: KobeOrchestratorPort
  now: () => string
  publish: (kind: string, payload: unknown) => void
  recoveryWindowMs?: number
  leaseWindowMs?: number
  maxRetry?: number
}

export class MultimanKernel {
  private dao: Dao
  private orch: KobeOrchestratorPort
  private now: () => string
  private publish: (kind: string, payload: unknown) => void
  private recoveryWindowMs: number
  private leaseWindowMs: number
  private maxRetry: number

  constructor(d: KernelDeps) {
    this.dao = d.dao
    this.orch = d.orchestrator
    this.now = d.now
    this.publish = d.publish
    this.recoveryWindowMs = d.recoveryWindowMs ?? 90_000
    this.leaseWindowMs = d.leaseWindowMs ?? 60_000
    this.maxRetry = d.maxRetry ?? 2
  }

  // INVARIANT: the kobe daemon is the SOLE writer of multiman.db. claimNextTask
  // atomicity depends on this. Never add a second writer process.

  createTask(i: Parameters<Dao["createTask"]>[0]): Task {
    const t = this.dao.createTask(i)
    this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.create", target_kind: "task", target_id: t.id, details: "{}" })
    this.publish("task.created", t)
    return t
  }
  getTask(id: string): Task | undefined { return this.dao.getTask(id) }
  listTasks(f?: Parameters<Dao["listTasks"]>[0]): Task[] { return this.dao.listTasks(f) }

  async transition(id: string, to: TaskStatus, reason: string, opts: { roleId?: string } = {}): Promise<Task> {
    const t = this.dao.getTask(id)
    if (!t) throw new GuardError(`task not found: ${id}`)
    assertTransition(t.status, to)

    // role guard for assignment
    if (to === "assigned") {
      const roleId = opts.roleId ?? t.role_id
      if (!roleId) throw new GuardError("assign requires a role")
      const role = this.dao.getRole(roleId)
      if (!role || role.status !== "active") throw new GuardError(`role not active: ${roleId}`)
    }

    // Hard materialization: running requires a kobe worktree. Materialize FIRST;
    // if it throws, the transition fails and the task keeps its prior status
    // (no half-state — the status write below is never reached).
    if (to === "running" && !t.kobe_task_id) {
      await this.materialize(id)
    }

    const patch: Partial<Task> = { status: to }
    if (to === "assigned" && opts.roleId) patch.role_id = opts.roleId
    if (to === "running") patch.last_heartbeat_at = this.now()
    const updated = this.dao.updateTask(id, patch)
    this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.transition", target_kind: "task", target_id: id, details: JSON.stringify({ from: t.status, to, reason }) })
    this.publish("task.transitioned", updated)

    if (to === "done") this.onTaskDone(id)
    if (to === "failed") this.onTaskFailed(id)
    return updated
  }

  claimNextTask(roleId: string): Task | null {
    const ts = this.now()
    // Single statement; atomicity relies on the single-writer invariant above.
    // RETURNING needs SQLite >= 3.35 (bun bundles a recent build).
    const row = this.dao.raw().query(
      `UPDATE task SET status='claimed', claimed_by=?, claimed_at=?, updated_at=?
         WHERE id = (
           SELECT id FROM task
            WHERE status='assigned' AND role_id=?
            ORDER BY priority DESC, created_at ASC LIMIT 1)
       RETURNING *`
    ).get(roleId, ts, ts, roleId) as Task | undefined
    if (!row) return null
    this.dao.logEvent({ actor_kind: "role", actor_id: roleId, action: "task.claim", target_kind: "task", target_id: row.id, details: "{}" })
    this.publish("task.claimed", row)
    return row
  }

  async materialize(taskId: string): Promise<{ kobeTaskId: string; worktreePath: string }> {
    const t = this.dao.getTask(taskId)
    if (!t) throw new GuardError(`task not found: ${taskId}`)
    if (t.kobe_task_id && t.work_dir) return { kobeTaskId: t.kobe_task_id, worktreePath: t.work_dir }
    if (!t.repo) throw new GuardError(`task ${taskId} has no repo to materialize`)
    const branch = `multiman/${t.id}`
    const worktreePath = `${t.repo}/.claude/worktrees/${t.id}`
    const res = await this.orch.adoptWorktree({ repo: t.repo, worktreePath, branch, ifExists: "return" })
    this.dao.updateTask(taskId, { kobe_task_id: res.id, work_dir: res.worktreePath })
    return { kobeTaskId: res.id, worktreePath: res.worktreePath }
  }

  createDag(
    info: { title?: string; source_inbox_item_id?: string | null; orchestrator_role_id?: string | null },
    tasks: { key: string; title: string; body?: string; role_id?: string | null; repo?: string | null; priority?: number }[],
    edges: [string, string][], // [fromKey, toKey]
  ): { dag: Dag; tasks: Record<string, string> } {
    const keys = tasks.map((t) => t.key)
    // Cycle check happens BEFORE any DB write — never start a transaction on a cyclic graph.
    if (hasCycle(keys, edges)) throw new CyclicDagError()
    return this.dao.transaction(() => {
      const dag = this.dao.createDagRow(info)
      const keyToId: Record<string, string> = {}
      const hasPred = new Set(edges.map(([, to]) => to))
      for (const spec of tasks) {
        const created = this.dao.createTask({
          title: spec.title, body: spec.body, role_id: spec.role_id ?? null,
          repo: spec.repo ?? null, priority: spec.priority ?? 0, dag_id: dag.id,
          source_kind: "orchestrator", source_ref: dag.id,
          status: hasPred.has(spec.key) ? "blocked" : "pending",
        })
        keyToId[spec.key] = created.id
      }
      for (const [from, to] of edges) {
        const fromId = keyToId[from], toId = keyToId[to]
        if (!fromId || !toId) throw new GuardError(`edge references unknown task key: ${from} -> ${to}`)
        this.dao.addEdge(dag.id, fromId, toId)
      }
      return { dag, tasks: keyToId }
    })
  }

  heartbeat(taskId: string, roleId: string): void {
    const t = this.dao.getTask(taskId)
    if (!t) throw new GuardError(`task not found: ${taskId}`)
    if (t.status !== "running") throw new GuardError(`task not running: ${taskId}`)
    if (t.claimed_by !== roleId) throw new GuardError(`heartbeat from non-claimer: ${roleId}`)
    this.dao.updateTask(taskId, { last_heartbeat_at: this.now() })
  }

  async reportTask(
    id: string,
    r: { status: TaskStatus; result?: string; error?: string; sessionId?: string },
  ): Promise<Task> {
    if (r.result !== undefined || r.error !== undefined || r.sessionId !== undefined) {
      this.dao.updateTask(id, {
        ...(r.result !== undefined ? { result: r.result } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.sessionId !== undefined ? { session_id: r.sessionId } : {}),
      })
    }
    return this.transition(id, r.status, "report")
  }

  // System-initiated recoveries. These bypass the role guard (no transition()) but
  // still respect the state graph: claimed->assigned, running->assigned|failed are
  // all legal edges. Uses the injected clock (this.now), never real timers.
  sweep(): void {
    const nowMs = Date.parse(this.now())
    // claimed timeout -> assigned
    for (const t of this.dao.listTasks({ status: "claimed" })) {
      if (t.claimed_at && nowMs - Date.parse(t.claimed_at) > this.recoveryWindowMs) {
        this.dao.updateTask(t.id, { status: "assigned" })
        this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.sweep.claim_timeout", target_kind: "task", target_id: t.id, details: "{}" })
        this.publish("task.transitioned", this.dao.getTask(t.id))
      }
    }
    // running lease expiry -> assigned (retry) or failed
    for (const t of this.dao.listTasks({ status: "running" })) {
      const hb = t.last_heartbeat_at ?? t.claimed_at
      if (hb && nowMs - Date.parse(hb) > this.leaseWindowMs) {
        if (t.retry_count < this.maxRetry) {
          this.dao.updateTask(t.id, { status: "assigned", retry_count: t.retry_count + 1, last_heartbeat_at: null })
          this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.sweep.lease_retry", target_kind: "task", target_id: t.id, details: JSON.stringify({ retry: t.retry_count + 1 }) })
        } else {
          this.dao.updateTask(t.id, { status: "failed", error: "lease expired, max retries" })
          this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.sweep.lease_failed", target_kind: "task", target_id: t.id, details: "{}" })
          this.onTaskFailed(t.id)
        }
        this.publish("task.transitioned", this.dao.getTask(t.id))
      }
    }
  }

  // Unblock successors whose ALL predecessors are done -> assigned (if it has a
  // role) or pending. Only blocked successors are eligible.
  private onTaskDone(taskId: string): void {
    for (const succ of this.dao.successorsOf(taskId)) {
      const s = this.dao.getTask(succ)
      if (!s || s.status !== "blocked") continue
      const allDone = this.dao.predecessorsOf(succ)
        .every((p) => this.dao.getTask(p)?.status === "done")
      if (allDone) {
        const to = s.role_id ? "assigned" : "pending"
        this.dao.updateTask(succ, { status: to })
        this.publish("task.transitioned", this.dao.getTask(succ))
      }
    }
  }

  // A failed task marks its dag failed; successors intentionally stay blocked for
  // human/orchestrator triage.
  private onTaskFailed(taskId: string): void {
    const t = this.dao.getTask(taskId)
    if (t?.dag_id) this.dao.setDagStatus(t.dag_id, "failed")
  }
}
