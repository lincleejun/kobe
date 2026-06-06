// src/kernel.ts
import type { Dao } from "@/db/dao"
import type { Task, TaskStatus } from "@/types"
import { assertTransition } from "@/state-machine"
import { GuardError } from "@/errors"

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

  // Filled in the next task (DAG gating). No-ops here.
  private onTaskDone(_id: string): void {}
  private onTaskFailed(_id: string): void {}
}
