// test/dao-comment.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { INIT_SQL } from "@/db/migrations/001_init"
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

describe("Dao comment CRUD", () => {
  it("addComment + listComments preserves insertion order", () => {
    const dao = freshDao()
    const t = dao.createTask({ title: "do X" })
    const c1 = dao.addComment({ task_id: t.id, author_kind: "human", body: "first" })
    const c2 = dao.addComment({ task_id: t.id, author_kind: "role", author_id: "r1", body: "second" })
    const c3 = dao.addComment({ task_id: t.id, author_kind: "system", body: "third" })
    const list = dao.listComments(t.id)
    expect(list.map((c) => c.id)).toEqual([c1.id, c2.id, c3.id])
    expect(list.map((c) => c.body)).toEqual(["first", "second", "third"])
    expect(list[1]!.author_id).toBe("r1")
    expect(list[0]!.author_id).toBeNull()
  })

  it("scopes listComments to the given task", () => {
    const dao = freshDao()
    const a = dao.createTask({ title: "a" })
    const b = dao.createTask({ title: "b" })
    dao.addComment({ task_id: a.id, author_kind: "human", body: "on a" })
    dao.addComment({ task_id: b.id, author_kind: "human", body: "on b" })
    expect(dao.listComments(a.id).map((c) => c.body)).toEqual(["on a"])
    expect(dao.listComments(b.id).map((c) => c.body)).toEqual(["on b"])
  })

  it("enforces the task_id foreign key", () => {
    const dao = freshDao()
    expect(() => dao.addComment({ task_id: "nope", author_kind: "human", body: "x" })).toThrow()
  })

  it("rejects a bad author_kind via CHECK", () => {
    const dao = freshDao()
    const t = dao.createTask({ title: "x" })
    // @ts-expect-error intentional bad author_kind
    expect(() => dao.addComment({ task_id: t.id, author_kind: "bogus", body: "x" })).toThrow()
  })
})

describe("migration v1 -> v2", () => {
  it("upgrades a v1-only db to v2 and creates the comment table", () => {
    // Build a db at user_version=1 the way an existing deployment looks.
    const db = openDb(":memory:")
    db.exec(INIT_SQL)
    db.run("PRAGMA user_version = 1")
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1)
    const before = db.query("SELECT name FROM sqlite_master WHERE name='comment'").get()
    expect(before).toBeNull()

    runMigrations(db)
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2)
    const after = db.query("SELECT name FROM sqlite_master WHERE name='comment'").get() as { name: string } | null
    expect(after?.name).toBe("comment")
  })

  it("is idempotent: a second runMigrations is a no-op", () => {
    const db = openDb(":memory:")
    runMigrations(db)
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2)
    // Second run must not throw (would throw on duplicate CREATE TABLE if not gated).
    runMigrations(db)
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2)
  })
})
