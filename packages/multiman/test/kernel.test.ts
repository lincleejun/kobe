// test/kernel.test.ts
import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"
import { runMigrations } from "@/db/migrate"
import { Dao } from "@/db/dao"
import { MultimanKernel } from "@/kernel"
import { GuardError, InvalidTransitionError } from "@/errors"

function fakeOrchestrator() {
  const calls: { adopt: number; create: number } = { adopt: 0, create: 0 }
  return {
    calls,
    async adoptWorktree(input: { repo: string; worktreePath: string; branch: string }) {
      calls.adopt++
      return { id: `kobe-${input.branch}`, worktreePath: input.worktreePath }
    },
    async createTask() { calls.create++; throw new Error("createTask must not be used") },
  }
}

function makeKernel(now = () => "2026-06-05T00:00:00.000Z") {
  const db = openDb(":memory:"); runMigrations(db)
  let n = 0
  const dao = new Dao(db, now, () => `id-${++n}`)
  const events: { kind: string; payload: unknown }[] = []
  const orch = fakeOrchestrator()
  const kernel = new MultimanKernel({
    dao, orchestrator: orch, now,
    publish: (kind, payload) => events.push({ kind, payload }),
    recoveryWindowMs: 90_000, leaseWindowMs: 60_000, maxRetry: 2,
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
    expect(first?.id).toBe(hi.id)   // priority wins
    expect(second?.id).toBe(lo.id)
    expect(third).toBeNull()        // nothing left
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
    ;(kernel as any).orch.adoptWorktree = async () => { throw new Error("git boom") }
    await expect(kernel.transition(t.id, "running", "start")).rejects.toThrow("git boom")
    expect(dao.getTask(t.id)?.status).toBe("claimed") // no half-state
  })
})
