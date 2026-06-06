import { describe, expect, it } from "bun:test"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"
import {
  ASSET_KINDS,
  DAG_STATUSES,
  INBOX_SEVERITIES,
  INBOX_STATUSES,
  ROLE_KINDS,
  ROLE_STATUSES,
  SCHEDULE_CONCURRENCY_POLICIES,
  SCHEDULE_EXECUTION_MODES,
  SCHEDULE_RUN_STATUSES,
  SCHEDULE_TARGET_KINDS,
  SCHEDULE_TRIGGER_KINDS,
  TASK_SOURCE_KINDS,
  TASK_STATUSES,
} from "@/types"

// Extract the IN (...) value list for a column's CHECK from the table DDL.
function checkValues(ddl: string, column: string): string[] {
  const re = new RegExp(`${column}[\\s\\S]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "i")
  const m = ddl.match(re)
  if (!m) throw new Error(`no CHECK found for ${column}`)
  return m[1]!
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .sort()
}

describe("enum sync: TS arrays match SQL CHECK", () => {
  const db = openDb(":memory:")
  runMigrations(db)
  const taskDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='task'").get() as { sql: string }).sql
  const roleDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='role'").get() as { sql: string }).sql
  const dagDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='dag'").get() as { sql: string }).sql
  const inboxDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='inbox_item'").get() as { sql: string }).sql
  const schedDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='schedule'").get() as { sql: string }).sql
  const schedRunDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='schedule_run'").get() as { sql: string }).sql
  const assetDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='asset'").get() as { sql: string }).sql

  it("task.status", () => expect(checkValues(taskDdl, "status")).toEqual([...TASK_STATUSES].sort()))
  it("task.source_kind", () => expect(checkValues(taskDdl, "source_kind")).toEqual([...TASK_SOURCE_KINDS].sort()))
  it("role.kind", () => expect(checkValues(roleDdl, "kind")).toEqual([...ROLE_KINDS].sort()))
  it("role.status", () => expect(checkValues(roleDdl, "status")).toEqual([...ROLE_STATUSES].sort()))
  it("dag.status", () => expect(checkValues(dagDdl, "status")).toEqual([...DAG_STATUSES].sort()))
  it("inbox_item.severity", () => expect(checkValues(inboxDdl, "severity")).toEqual([...INBOX_SEVERITIES].sort()))
  it("inbox_item.status", () => expect(checkValues(inboxDdl, "status")).toEqual([...INBOX_STATUSES].sort()))
  it("schedule.trigger_kind", () =>
    expect(checkValues(schedDdl, "trigger_kind")).toEqual([...SCHEDULE_TRIGGER_KINDS].sort()))
  it("schedule.target_kind", () =>
    expect(checkValues(schedDdl, "target_kind")).toEqual([...SCHEDULE_TARGET_KINDS].sort()))
  it("schedule.execution_mode", () =>
    expect(checkValues(schedDdl, "execution_mode")).toEqual([...SCHEDULE_EXECUTION_MODES].sort()))
  it("schedule.concurrency_policy", () =>
    expect(checkValues(schedDdl, "concurrency_policy")).toEqual([...SCHEDULE_CONCURRENCY_POLICIES].sort()))
  it("schedule_run.status", () => expect(checkValues(schedRunDdl, "status")).toEqual([...SCHEDULE_RUN_STATUSES].sort()))
  it("asset.kind", () => expect(checkValues(assetDdl, "kind")).toEqual([...ASSET_KINDS].sort()))
})
