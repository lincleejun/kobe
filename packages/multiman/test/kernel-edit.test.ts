// test/kernel-edit.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"
import { GuardError } from "@/errors"
import { MultimanKernel } from "@/kernel"

function makeKernel(now = () => "2026-06-05T00:00:00.000Z") {
  const db = openDb(":memory:")
  runMigrations(db)
  let n = 0
  const dao = new Dao(db, now, () => `id-${++n}`)
  const events: { kind: string; payload: unknown }[] = []
  const orch = {
    async adoptWorktree(i: { repo: string; worktreePath: string; branch: string; title?: string }) {
      return { id: `kobe-${i.branch}`, worktreePath: i.worktreePath }
    },
  }
  const kernel = new MultimanKernel({
    dao,
    orchestrator: orch,
    now,
    publish: (kind, payload) => events.push({ kind, payload }),
  })
  return { kernel, dao, events }
}

describe("kernel.editTask", () => {
  it("updates title/body/priority and publishes task.updated", () => {
    const { kernel, events } = makeKernel()
    const t = kernel.createTask({ title: "old", body: "ob", priority: 0 })
    const u = kernel.editTask(t.id, { title: "new", body: "nb", priority: 5 })
    expect(u.title).toBe("new")
    expect(u.body).toBe("nb")
    expect(u.priority).toBe(5)
    expect(events.some((e) => e.kind === "task.updated")).toBe(true)
  })

  it("reassigns role_id and can unassign via null", () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x" })
    expect(kernel.editTask(t.id, { roleId: role.id }).role_id).toBe(role.id)
    expect(kernel.editTask(t.id, { roleId: null }).role_id).toBeNull()
  })

  it("rejects reassignment to a nonexistent role", () => {
    const { kernel } = makeKernel()
    const t = kernel.createTask({ title: "x" })
    expect(() => kernel.editTask(t.id, { roleId: "nope" })).toThrow(GuardError)
  })

  it("does NOT change status (status is not an editable field)", () => {
    const { kernel } = makeKernel()
    const t = kernel.createTask({ title: "x" })
    expect(t.status).toBe("pending")
    // The editTask signature has no status; a stray status prop is ignored by TS+runtime.
    // @ts-expect-error status is intentionally not editable
    const u = kernel.editTask(t.id, { title: "y", status: "done" })
    expect(u.status).toBe("pending")
  })

  it("throws when given no editable fields", () => {
    const { kernel } = makeKernel()
    const t = kernel.createTask({ title: "x" })
    expect(() => kernel.editTask(t.id, {})).toThrow(GuardError)
  })

  it("throws for a nonexistent task", () => {
    const { kernel } = makeKernel()
    expect(() => kernel.editTask("nope", { title: "y" })).toThrow(GuardError)
  })
})

describe("kernel comments", () => {
  it("addComment defaults to human and listComments returns them in order", () => {
    const { kernel, events } = makeKernel()
    const t = kernel.createTask({ title: "x" })
    const c1 = kernel.addComment({ taskId: t.id, body: "hello" })
    expect(c1.author_kind).toBe("human")
    kernel.addComment({ taskId: t.id, body: "world", authorKind: "role", authorId: "r1" })
    const list = kernel.listComments(t.id)
    expect(list.map((c) => c.body)).toEqual(["hello", "world"])
    expect(events.some((e) => e.kind === "comment.added")).toBe(true)
  })

  it("addComment throws for a nonexistent task", () => {
    const { kernel } = makeKernel()
    expect(() => kernel.addComment({ taskId: "nope", body: "x" })).toThrow(GuardError)
  })
})
