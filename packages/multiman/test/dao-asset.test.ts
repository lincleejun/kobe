// test/dao-asset.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"

function freshDao() {
  const db = openDb(":memory:")
  runMigrations(db)
  let n = 0
  return new Dao(
    db,
    () => "2026-06-05T00:00:00.000Z",
    () => `id-${++n}`,
  )
}

describe("Dao asset + role_asset CRUD", () => {
  it("creates and reads a skill asset with defaults", () => {
    const dao = freshDao()
    const a = dao.createAsset({ kind: "skill", name: "summarize", spec: '{"content":"# Summarize"}' })
    expect(a.kind).toBe("skill")
    expect(a.version).toBe("0.1.0")
    expect(dao.getAsset(a.id)?.name).toBe("summarize")
  })

  it("filters listAssets by kind", () => {
    const dao = freshDao()
    dao.createAsset({ kind: "skill", name: "s1" })
    dao.createAsset({ kind: "mcp", name: "m1" })
    expect(dao.listAssets().length).toBe(2)
    expect(dao.listAssets({ kind: "skill" }).map((a) => a.name)).toEqual(["s1"])
    expect(dao.listAssets({ kind: "mcp" }).map((a) => a.name)).toEqual(["m1"])
  })

  it("rejects an invalid kind via CHECK", () => {
    const dao = freshDao()
    // @ts-expect-error intentional bad kind
    expect(() => dao.createAsset({ kind: "bogus", name: "x" })).toThrow()
  })

  it("attach is idempotent and assetsForRole returns attached assets", () => {
    const dao = freshDao()
    const role = dao.createRole({ name: "worker", kind: "worker" })
    const a1 = dao.createAsset({ kind: "skill", name: "s1" })
    const a2 = dao.createAsset({ kind: "mcp", name: "m1" })
    dao.attachAsset(role.id, a1.id)
    dao.attachAsset(role.id, a1.id) // duplicate — must not throw, must not double
    dao.attachAsset(role.id, a2.id)
    const got = dao.assetsForRole(role.id)
    expect(got.map((a) => a.name).sort()).toEqual(["m1", "s1"])
  })

  it("detach removes the link only", () => {
    const dao = freshDao()
    const role = dao.createRole({ name: "worker", kind: "worker" })
    const a1 = dao.createAsset({ kind: "skill", name: "s1" })
    dao.attachAsset(role.id, a1.id)
    dao.detachAsset(role.id, a1.id)
    expect(dao.assetsForRole(role.id)).toEqual([])
    // asset row still exists
    expect(dao.getAsset(a1.id)?.name).toBe("s1")
  })
})
