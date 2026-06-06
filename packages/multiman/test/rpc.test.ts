// test/rpc.test.ts
import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"
import { runMigrations } from "@/db/migrate"
import { Dao } from "@/db/dao"
import { MultimanKernel } from "@/kernel"
import { makeRpcHandler } from "@/rpc"

function makeHandler() {
  const db = openDb(":memory:"); runMigrations(db)
  let n = 0
  const dao = new Dao(db, () => "2026-06-05T00:00:00.000Z", () => `id-${++n}`)
  const orch = { async adoptWorktree(i: any) { return { id: `kobe-${i.branch}`, worktreePath: i.worktreePath } } }
  const kernel = new MultimanKernel({ dao, orchestrator: orch as any, now: () => "2026-06-05T00:00:00.000Z", publish: () => {} })
  return makeRpcHandler(kernel)
}

describe("rpc handle", () => {
  it("routes role.create and task.create", async () => {
    const h = makeHandler()
    const role = await h("role.create", { name: "r", kind: "worker" })
    expect((role as any).id).toBeTruthy()
    const task = await h("task.create", { title: "x" })
    expect((task as any).status).toBe("pending")
  })
  it("rejects unknown method", async () => {
    const h = makeHandler()
    await expect(h("bogus.method", {})).rejects.toThrow(/unknown/i)
  })
  it("rejects missing required param", async () => {
    const h = makeHandler()
    await expect(h("role.create", { kind: "worker" })).rejects.toThrow(/name/)
  })
})
