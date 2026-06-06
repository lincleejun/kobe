// test/dao.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"

function freshDao() {
  const db = openDb(":memory:")
  runMigrations(db)
  return new Dao(
    db,
    () => "2026-06-05T00:00:00.000Z",
    (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
  )
}

describe("Dao role + task CRUD", () => {
  it("creates and reads a role", () => {
    const dao = freshDao()
    const r = dao.createRole({ name: "backend", kind: "worker" })
    expect(r.id).toBe("id-1")
    expect(dao.getRole(r.id)?.name).toBe("backend")
    expect(dao.listRoles().length).toBe(1)
  })

  it("rejects an invalid enum via CHECK", () => {
    const dao = freshDao()
    // @ts-expect-error intentional bad kind
    expect(() => dao.createRole({ name: "x", kind: "bogus" })).toThrow()
  })

  it("creates a task defaulting to pending, then updates it", () => {
    const dao = freshDao()
    const t = dao.createTask({ title: "do X" })
    expect(t.status).toBe("pending")
    const u = dao.updateTask(t.id, { status: "assigned", role_id: null })
    expect(u.status).toBe("assigned")
  })

  it("enforces foreign keys (task.role_id -> role.id)", () => {
    const dao = freshDao()
    expect(() => dao.createTask({ title: "x", role_id: "nope" })).toThrow()
  })

  it("records mr_url and can look up a task by it", () => {
    const dao = freshDao()
    const t = dao.createTask({ title: "feature" })
    dao.updateTask(t.id, { mr_url: "https://gitlab/mr/123", session_id: "sess-abc" })
    const got = dao.getTask(t.id)
    expect(got?.mr_url).toBe("https://gitlab/mr/123")
    // lookup by mr_url (the review-comment → origin-task linkage)
    const found = dao.raw().query("SELECT * FROM task WHERE mr_url=?").get("https://gitlab/mr/123") as
      | { id: string }
      | undefined
    expect(found?.id).toBe(t.id)
  })
})
