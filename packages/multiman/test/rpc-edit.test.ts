// test/rpc-edit.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"
import { MultimanKernel } from "@/kernel"
import { makeRpcHandler } from "@/rpc"
import type { Comment, Task } from "@/types"

function makeHandler() {
  const db = openDb(":memory:")
  runMigrations(db)
  let n = 0
  const dao = new Dao(
    db,
    () => "2026-06-05T00:00:00.000Z",
    () => `id-${++n}`,
  )
  const orch = {
    async adoptWorktree(i: { worktreePath: string; branch: string }) {
      return { id: `kobe-${i.branch}`, worktreePath: i.worktreePath }
    },
  }
  const kernel = new MultimanKernel({
    dao,
    orchestrator: orch,
    now: () => "2026-06-05T00:00:00.000Z",
    publish: () => {},
  })
  return makeRpcHandler(kernel)
}

describe("rpc task.update", () => {
  it("round-trips an edit of title/body/priority", async () => {
    const h = makeHandler()
    const t = (await h("task.create", { title: "old" })) as Task
    const u = (await h("task.update", { id: t.id, title: "new", body: "b", priority: 7 })) as Task
    expect(u.title).toBe("new")
    expect(u.body).toBe("b")
    expect(u.priority).toBe(7)
    expect(u.status).toBe("pending")
  })

  it("reassigns and unassigns role via roleId", async () => {
    const h = makeHandler()
    const role = (await h("role.create", { name: "r", kind: "worker" })) as { id: string }
    const t = (await h("task.create", { title: "x" })) as Task
    expect(((await h("task.update", { id: t.id, roleId: role.id })) as Task).role_id).toBe(role.id)
    expect(((await h("task.update", { id: t.id, roleId: null })) as Task).role_id).toBeNull()
  })

  it("rejects task.update with no editable fields", async () => {
    const h = makeHandler()
    const t = (await h("task.create", { title: "x" })) as Task
    await expect(h("task.update", { id: t.id })).rejects.toThrow(/editable field/i)
  })

  it("rejects a non-number priority", async () => {
    const h = makeHandler()
    const t = (await h("task.create", { title: "x" })) as Task
    await expect(h("task.update", { id: t.id, priority: "high" })).rejects.toThrow(/priority/)
  })
})

describe("rpc comment.add / comment.list", () => {
  it("round-trips comments", async () => {
    const h = makeHandler()
    const t = (await h("task.create", { title: "x" })) as Task
    const c = (await h("comment.add", { taskId: t.id, body: "hello" })) as Comment
    expect(c.body).toBe("hello")
    expect(c.author_kind).toBe("human")
    await h("comment.add", { taskId: t.id, body: "again", authorKind: "system" })
    const list = (await h("comment.list", { taskId: t.id })) as Comment[]
    expect(list.map((x) => x.body)).toEqual(["hello", "again"])
  })

  it("rejects comment.add without a body", async () => {
    const h = makeHandler()
    const t = (await h("task.create", { title: "x" })) as Task
    await expect(h("comment.add", { taskId: t.id })).rejects.toThrow(/body/)
  })
})
