// test/kernel.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"
import { GuardError, InvalidTransitionError } from "@/errors"
import { MultimanKernel } from "@/kernel"

function fakeOrchestrator() {
  const calls: { adopt: number; create: number } = { adopt: 0, create: 0 }
  const adoptInputs: { repo: string; worktreePath: string; branch: string; title?: string }[] = []
  return {
    calls,
    adoptInputs,
    async adoptWorktree(input: { repo: string; worktreePath: string; branch: string; title?: string }) {
      calls.adopt++
      adoptInputs.push(input)
      return { id: `kobe-${input.branch}`, worktreePath: input.worktreePath }
    },
    async createTask() {
      calls.create++
      throw new Error("createTask must not be used")
    },
  }
}

function makeKernel(now = () => "2026-06-05T00:00:00.000Z") {
  const db = openDb(":memory:")
  runMigrations(db)
  let n = 0
  const dao = new Dao(db, now, () => `id-${++n}`)
  const events: { kind: string; payload: unknown }[] = []
  const orch = fakeOrchestrator()
  const kernel = new MultimanKernel({
    dao,
    orchestrator: orch,
    now,
    publish: (kind, payload) => events.push({ kind, payload }),
    recoveryWindowMs: 90_000,
    leaseWindowMs: 60_000,
    maxRetry: 2,
  })
  return { kernel, dao, events, orch }
}

describe("kernel basic + guards", () => {
  it("createTask lands pending and emits event", () => {
    const { kernel, events } = makeKernel()
    const t = kernel.createTask({ title: "x" })
    expect(t.status).toBe("pending")
    expect(events.some((e) => e.kind === "task.created")).toBe(true)
  })
  it("assigning to a disabled role throws GuardError", async () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    dao.raw().query("UPDATE role SET status='disabled' WHERE id=?").run(role.id)
    const t = kernel.createTask({ title: "x" })
    await expect(kernel.transition(t.id, "assigned", "assign", { roleId: role.id })).rejects.toThrow(GuardError)
  })
  it("illegal shape transition throws", async () => {
    const { kernel } = makeKernel()
    const t = kernel.createTask({ title: "x" })
    await expect(kernel.transition(t.id, "done", "skip")).rejects.toThrow(InvalidTransitionError)
  })
})

describe("claimNextTask", () => {
  it("claims highest priority then oldest, and never double-claims", async () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const lo = kernel.createTask({ title: "lo", role_id: role.id, priority: 1 })
    const hi = kernel.createTask({ title: "hi", role_id: role.id, priority: 5 })
    await kernel.transition(lo.id, "assigned", "a", { roleId: role.id })
    await kernel.transition(hi.id, "assigned", "a", { roleId: role.id })

    const first = kernel.claimNextTask(role.id)
    const second = kernel.claimNextTask(role.id)
    const third = kernel.claimNextTask(role.id)
    expect(first?.id).toBe(hi.id) // priority wins
    expect(second?.id).toBe(lo.id)
    expect(third).toBeNull() // nothing left
    expect(first?.status).toBe("claimed")
    expect(first?.claimed_by).toBe(role.id)
  })
})

describe("materialize (Finding 1 idempotency)", () => {
  it("transition->running adopts (not creates) a deterministic worktree and is idempotent", async () => {
    const { kernel, dao, orch } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)

    const running = await kernel.transition(t.id, "running", "start")
    expect(running.status).toBe("running")
    expect(running.kobe_task_id).toBe(`kobe-multiman/${t.id}`)
    expect(orch.calls.adopt).toBe(1)
    expect(orch.calls.create).toBe(0)
    // title must be threaded through so kobe TUI shows the human title
    expect(orch.adoptInputs[0]?.title).toBe("x")

    // simulate crash retry: re-materialize must reuse, not duplicate
    const again = await kernel.materialize(t.id)
    expect(again.kobeTaskId).toBe(`kobe-multiman/${t.id}`)
    expect(orch.calls.adopt).toBe(1) // fast path: already materialized
  })

  it("materialize failure leaves no half-state (task stays claimed)", async () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    // monkeypatch orchestrator to throw
    ;(kernel as any).orch.adoptWorktree = async () => {
      throw new Error("git boom")
    }
    await expect(kernel.transition(t.id, "running", "start")).rejects.toThrow("git boom")
    expect(dao.getTask(t.id)?.status).toBe("claimed") // no half-state
  })
})

describe("DAG gating", () => {
  it("createDag rejects a cycle (no tasks created)", () => {
    const { kernel, dao } = makeKernel()
    expect(() =>
      kernel.createDag(
        { title: "g" },
        [
          { key: "a", title: "A" },
          { key: "b", title: "B" },
        ],
        [
          ["a", "b"],
          ["b", "a"],
        ],
      ),
    ).toThrow("cycle")
    expect(dao.listTasks().length).toBe(0) // transaction rolled back / never started
  })
  it("blocks successors until predecessor done, then unblocks", async () => {
    const { kernel, dao } = makeKernel()
    const dag = kernel.createDag(
      { title: "g" },
      [
        { key: "a", title: "A" },
        { key: "b", title: "B" },
      ],
      [["a", "b"]],
    )
    const a = dag.tasks.a!
    const b = dag.tasks.b!
    expect(dao.getTask(a)?.status).toBe("pending")
    expect(dao.getTask(b)?.status).toBe("blocked")
    // drive A to done (materialize needs a repo)
    dao.updateTask(a, { repo: "/repo" })
    const role = dao.createRole({ name: "r", kind: "worker" })
    await kernel.transition(a, "assigned", "x", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(a, "running", "x")
    await kernel.transition(a, "done", "x")
    expect(dao.getTask(b)?.status).toBe("pending") // unblocked
  })
  it("onTaskFailed marks dag failed and keeps successors blocked", async () => {
    const { kernel, dao } = makeKernel()
    const dag = kernel.createDag(
      { title: "g" },
      [
        { key: "a", title: "A" },
        { key: "b", title: "B" },
      ],
      [["a", "b"]],
    )
    const a = dag.tasks.a!
    const b = dag.tasks.b!
    dao.updateTask(a, { repo: "/repo" })
    const role = dao.createRole({ name: "r", kind: "worker" })
    await kernel.transition(a, "assigned", "x", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(a, "running", "x")
    await kernel.transition(a, "failed", "x")
    expect(dao.getTask(b)?.status).toBe("blocked")
    expect(dao.raw().query("SELECT status FROM dag WHERE id=?").get(dag.dag.id)).toMatchObject({ status: "failed" })
  })
})

describe("heartbeat + report", () => {
  it("heartbeat renews last_heartbeat_at for a running task", async () => {
    let clock = "2026-06-05T00:00:00.000Z"
    const { kernel, dao } = makeKernel(() => clock)
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x")
    clock = "2026-06-05T00:05:00.000Z"
    kernel.heartbeat(t.id, role.id)
    expect(dao.getTask(t.id)?.last_heartbeat_at).toBe(clock)
  })
  it("heartbeat rejects when caller is not the claimer", async () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x")
    expect(() => kernel.heartbeat(t.id, "someone-else")).toThrow()
  })
  it("reportTask sets terminal status + result", async () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x")
    await kernel.reportTask(t.id, { status: "in_review", result: "done-ish" })
    expect(dao.getTask(t.id)?.status).toBe("in_review")
    expect(dao.getTask(t.id)?.result).toBe("done-ish")
  })
})

describe("sweep", () => {
  it("reclaims a stale claimed task back to assigned", async () => {
    let clock = "2026-06-05T00:00:00.000Z"
    const { kernel, dao } = makeKernel(() => clock)
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id) // claimed_at = 00:00
    clock = "2026-06-05T00:10:00.000Z" // +10min > 90s recovery
    kernel.sweep()
    expect(dao.getTask(t.id)?.status).toBe("assigned")
  })
  it("reclaims a lease-expired running task to assigned and increments retry", async () => {
    let clock = "2026-06-05T00:00:00.000Z"
    const { kernel, dao } = makeKernel(() => clock)
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x") // heartbeat = 00:00
    clock = "2026-06-05T00:10:00.000Z" // +10min > 60s lease
    kernel.sweep()
    const after = dao.getTask(t.id)
    expect(after?.status).toBe("assigned")
    expect(after?.retry_count).toBe(1)
  })
  it("fails a running task after maxRetry exhausted", async () => {
    let clock = "2026-06-05T00:00:00.000Z"
    const { kernel, dao } = makeKernel(() => clock)
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    dao.updateTask(t.id, { retry_count: 2 }) // already at maxRetry
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x")
    clock = "2026-06-05T00:10:00.000Z"
    kernel.sweep()
    expect(dao.getTask(t.id)?.status).toBe("failed")
  })
})
