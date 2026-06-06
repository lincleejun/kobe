import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"
import { runMigrations } from "@/db/migrate"
import { TASK_STATUSES, ROLE_KINDS, ROLE_STATUSES, DAG_STATUSES, TASK_SOURCE_KINDS } from "@/types"

// Extract the IN (...) value list for a column's CHECK from the table DDL.
function checkValues(ddl: string, column: string): string[] {
  const re = new RegExp(`${column}[\\s\\S]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "i")
  const m = ddl.match(re)
  if (!m) throw new Error(`no CHECK found for ${column}`)
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort()
}

describe("enum sync: TS arrays match SQL CHECK", () => {
  const db = openDb(":memory:")
  runMigrations(db)
  const taskDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='task'").get() as { sql: string }).sql
  const roleDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='role'").get() as { sql: string }).sql
  const dagDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='dag'").get() as { sql: string }).sql

  it("task.status", () => expect(checkValues(taskDdl, "status")).toEqual([...TASK_STATUSES].sort()))
  it("task.source_kind", () => expect(checkValues(taskDdl, "source_kind")).toEqual([...TASK_SOURCE_KINDS].sort()))
  it("role.kind", () => expect(checkValues(roleDdl, "kind")).toEqual([...ROLE_KINDS].sort()))
  it("role.status", () => expect(checkValues(roleDdl, "status")).toEqual([...ROLE_STATUSES].sort()))
  it("dag.status", () => expect(checkValues(dagDdl, "status")).toEqual([...DAG_STATUSES].sort()))
})
