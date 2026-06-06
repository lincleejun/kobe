// test/rpc-asset.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"
import { MultimanKernel } from "@/kernel"
import { makeRpcHandler } from "@/rpc"
import type { Asset, Role } from "@/types"

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
  const events: { kind: string; payload: unknown }[] = []
  const kernel = new MultimanKernel({
    dao,
    orchestrator: orch as never,
    now: () => "2026-06-05T00:00:00.000Z",
    publish: (kind, payload) => events.push({ kind, payload }),
  })
  return { h: makeRpcHandler(kernel), events }
}

describe("rpc asset.*", () => {
  it("creates an asset (spec as object → stored as JSON) and lists it", async () => {
    const { h, events } = makeHandler()
    const a = (await h("asset.create", {
      kind: "skill",
      name: "summarize",
      spec: { content: "# Summarize" },
    })) as Asset
    expect(a.kind).toBe("skill")
    expect(a.spec).toBe('{"content":"# Summarize"}')
    expect(events.some((e) => e.kind === "asset.created")).toBe(true)

    const list = (await h("asset.list", { kind: "skill" })) as Asset[]
    expect(list.map((x) => x.name)).toEqual(["summarize"])
  })

  it("accepts spec as a JSON string", async () => {
    const { h } = makeHandler()
    const a = (await h("asset.create", { kind: "mcp", name: "fs", spec: '{"command":"npx"}' })) as Asset
    expect(a.spec).toBe('{"command":"npx"}')
  })

  it("attach + role.assets round-trip, attach is idempotent", async () => {
    const { h, events } = makeHandler()
    const role = (await h("role.create", { name: "worker", kind: "worker" })) as Role
    const a = (await h("asset.create", { kind: "skill", name: "s1", spec: { content: "c" } })) as Asset
    expect(await h("asset.attach", { roleId: role.id, assetId: a.id })).toEqual({ ok: true })
    await h("asset.attach", { roleId: role.id, assetId: a.id }) // idempotent
    expect(events.some((e) => e.kind === "asset.attached")).toBe(true)

    const forRole = (await h("role.assets", { roleId: role.id })) as Asset[]
    expect(forRole.map((x) => x.name)).toEqual(["s1"])

    expect(await h("asset.detach", { roleId: role.id, assetId: a.id })).toEqual({ ok: true })
    expect((await h("role.assets", { roleId: role.id })) as Asset[]).toEqual([])
  })
})
