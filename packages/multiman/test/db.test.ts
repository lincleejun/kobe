import { describe, it, expect } from "vitest"
import { openDb } from "@/db/open"

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
