// test/dao-inbox-schedule.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"

function freshDao(now = () => "2026-06-05T00:00:00.000Z") {
  const db = openDb(":memory:")
  runMigrations(db)
  let n = 0
  return new Dao(db, now, () => `id-${++n}`)
}

describe("Dao inbox CRUD", () => {
  it("creates with defaults and reads back", () => {
    const dao = freshDao()
    const item = dao.createInboxItem({ source: "sched-1", kind: "alert" })
    expect(item.id).toBe("id-1")
    expect(item.status).toBe("new")
    expect(item.severity).toBe("info")
    expect(item.payload).toBe("{}")
    expect(dao.getInboxItem(item.id)?.kind).toBe("alert")
  })

  it("honors severity + payload", () => {
    const dao = freshDao()
    const item = dao.createInboxItem({ source: "s", kind: "k", payload: '{"x":1}', severity: "action" })
    expect(item.severity).toBe("action")
    expect(item.payload).toBe('{"x":1}')
  })

  it("lists, optionally filtered by status", () => {
    const dao = freshDao()
    dao.createInboxItem({ source: "s", kind: "a" })
    const b = dao.createInboxItem({ source: "s", kind: "b" })
    dao.markInboxItem(b.id, "archived")
    expect(dao.listInboxItems().length).toBe(2)
    expect(dao.listInboxItems({ status: "new" }).length).toBe(1)
    expect(dao.listInboxItems({ status: "archived" }).length).toBe(1)
  })

  it("claim picks the oldest 'new' atomically and sets consumed_by + status", () => {
    let t = 0
    const dao = freshDao(() => `2026-06-05T00:0${t++}:00.000Z`)
    const first = dao.createInboxItem({ source: "s", kind: "a" })
    dao.createInboxItem({ source: "s", kind: "b" })
    const claimed = dao.claimInboxItem("worker-1")
    expect(claimed?.id).toBe(first.id)
    expect(claimed?.status).toBe("claimed")
    expect(claimed?.consumed_by).toBe("worker-1")
    // only one 'new' left
    expect(dao.listInboxItems({ status: "new" }).length).toBe(1)
  })

  it("claim returns null when nothing is 'new'", () => {
    const dao = freshDao()
    expect(dao.claimInboxItem("w")).toBeNull()
  })

  it("markInboxItem transitions status", () => {
    const dao = freshDao()
    const item = dao.createInboxItem({ source: "s", kind: "a" })
    const m = dao.markInboxItem(item.id, "processed")
    expect(m.status).toBe("processed")
  })
})

describe("Dao schedule CRUD", () => {
  it("creates with defaults", () => {
    const dao = freshDao()
    const s = dao.createSchedule({
      name: "nightly",
      trigger_kind: "cron",
      cron_expr: "0 0 * * *",
      target_kind: "role",
      target_ref: "collector-1",
      next_run_at: "2026-06-06T00:00:00.000Z",
    })
    expect(s.timezone).toBe("UTC")
    expect(s.execution_mode).toBe("collect")
    expect(s.concurrency_policy).toBe("skip")
    expect(s.enabled).toBe(1)
    expect(s.next_run_at).toBe("2026-06-06T00:00:00.000Z")
    expect(dao.getSchedule(s.id)?.name).toBe("nightly")
  })

  it("lists, optionally filtered by enabled", () => {
    const dao = freshDao()
    const a = dao.createSchedule({ name: "a", trigger_kind: "manual", target_kind: "role", target_ref: "r" })
    dao.createSchedule({ name: "b", trigger_kind: "manual", target_kind: "role", target_ref: "r" })
    dao.setScheduleEnabled(a.id, false)
    expect(dao.listSchedules().length).toBe(2)
    expect(dao.listSchedules({ enabled: true }).length).toBe(1)
    expect(dao.listSchedules({ enabled: false }).length).toBe(1)
  })

  it("updateSchedule patches arbitrary columns", () => {
    const dao = freshDao()
    const s = dao.createSchedule({ name: "a", trigger_kind: "cron", target_kind: "role", target_ref: "r" })
    const u = dao.updateSchedule(s.id, {
      next_run_at: "2026-06-07T00:00:00.000Z",
      last_run_at: "2026-06-05T00:00:00.000Z",
    })
    expect(u.next_run_at).toBe("2026-06-07T00:00:00.000Z")
    expect(u.last_run_at).toBe("2026-06-05T00:00:00.000Z")
  })

  it("setScheduleEnabled flips the flag", () => {
    const dao = freshDao()
    const s = dao.createSchedule({ name: "a", trigger_kind: "manual", target_kind: "role", target_ref: "r" })
    expect(dao.setScheduleEnabled(s.id, false).enabled).toBe(0)
    expect(dao.setScheduleEnabled(s.id, true).enabled).toBe(1)
  })

  it("dueSchedules returns only enabled with next_run_at <= now", () => {
    const dao = freshDao()
    const due = dao.createSchedule({
      name: "due",
      trigger_kind: "cron",
      target_kind: "role",
      target_ref: "r",
      next_run_at: "2026-06-05T00:00:00.000Z",
    })
    dao.createSchedule({
      name: "future",
      trigger_kind: "cron",
      target_kind: "role",
      target_ref: "r",
      next_run_at: "2026-06-09T00:00:00.000Z",
    })
    const disabled = dao.createSchedule({
      name: "disabled",
      trigger_kind: "cron",
      target_kind: "role",
      target_ref: "r",
      next_run_at: "2026-06-01T00:00:00.000Z",
    })
    dao.setScheduleEnabled(disabled.id, false)
    // null next_run_at never due
    dao.createSchedule({ name: "manual", trigger_kind: "manual", target_kind: "role", target_ref: "r" })
    const ids = dao.dueSchedules("2026-06-05T00:00:00.000Z").map((s) => s.id)
    expect(ids).toEqual([due.id])
  })
})

describe("Dao schedule_run CRUD", () => {
  it("creates a run, finishes it, and counts active runs", () => {
    const dao = freshDao()
    const s = dao.createSchedule({ name: "a", trigger_kind: "manual", target_kind: "role", target_ref: "r" })
    const inbox = dao.createInboxItem({ source: s.id, kind: "k" })
    const run = dao.createScheduleRun({ schedule_id: s.id, status: "running" })
    expect(run.status).toBe("running")
    expect(dao.activeRunCountForSchedule(s.id)).toBe(1)
    const done = dao.finishScheduleRun(run.id, { status: "done", produced_inbox_item_id: inbox.id })
    expect(done.status).toBe("done")
    expect(done.finished_at).toBe("2026-06-05T00:00:00.000Z")
    expect(done.produced_inbox_item_id).toBe(inbox.id)
    expect(dao.activeRunCountForSchedule(s.id)).toBe(0)
  })

  it("finishScheduleRun records error", () => {
    const dao = freshDao()
    const s = dao.createSchedule({ name: "a", trigger_kind: "manual", target_kind: "role", target_ref: "r" })
    const run = dao.createScheduleRun({ schedule_id: s.id, status: "pending" })
    expect(dao.activeRunCountForSchedule(s.id)).toBe(1)
    const fin = dao.finishScheduleRun(run.id, { status: "failed", error: "boom" })
    expect(fin.error).toBe("boom")
  })
})
