import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"
import { runMigrations } from "@/db/migrate"

describe("openDb", () => {
  it("enables WAL and foreign_keys", () => {
    const db = openDb(":memory:")
    const journal = db.query("PRAGMA journal_mode").get() as { journal_mode: string }
    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    // :memory: cannot use WAL; open.ts must request WAL but tolerate memory fallback.
    expect(["wal", "memory"]).toContain(journal.journal_mode)
    expect(fk.foreign_keys).toBe(1)
    db.close()
  })
})

describe("runMigrations", () => {
  it("applies 001 to an empty db and sets user_version=1", () => {
    const db = openDb(":memory:")
    runMigrations(db)
    const v = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(v.user_version).toBe(1)
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain("task")
    expect(names).toContain("role")
    expect(names).toContain("event_log")
    db.close()
  })

  it("is idempotent — second run is a no-op", () => {
    const db = openDb(":memory:")
    runMigrations(db)
    runMigrations(db) // must not throw "table already exists"
    const v = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(v.user_version).toBe(1)
    db.close()
  })
})
