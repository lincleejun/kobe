// test/scheduler.test.ts
import { describe, expect, it } from "bun:test"
import { nextRun } from "@/cron"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"
import { scheduleTick } from "@/scheduler"

function freshDao(now = () => "2026-06-05T00:00:00.000Z") {
  const db = openDb(":memory:")
  runMigrations(db)
  let n = 0
  return new Dao(db, now, () => `id-${++n}`)
}

describe("scheduleTick", () => {
  it("fires a due cron schedule → pushes inbox_item, marks run done, advances next_run_at", () => {
    const now = "2026-06-05T00:00:00.000Z"
    const dao = freshDao(() => now)
    const s = dao.createSchedule({
      name: "poll",
      trigger_kind: "cron",
      cron_expr: "* * * * *",
      target_kind: "workflow",
      target_ref: "mr-poller",
      next_run_at: now, // due
    })

    scheduleTick(dao, now)

    // an inbox_item with kind schedule:<name> was created
    const items = dao.listInboxItems()
    expect(items.length).toBe(1)
    const item = items[0]!
    expect(item.kind).toBe("schedule:poll")
    expect(item.source).toBe(s.id)
    expect(item.severity).toBe("info")
    const payload = JSON.parse(item.payload)
    expect(payload).toEqual({
      schedule_id: s.id,
      name: "poll",
      target_kind: "workflow",
      target_ref: "mr-poller",
      execution_mode: "collect",
    })

    // schedule_run is 'done' with produced_inbox_item_id set
    const run = dao.raw().query("SELECT * FROM schedule_run WHERE schedule_id=?").get(s.id) as {
      status: string
      produced_inbox_item_id: string | null
    }
    expect(run.status).toBe("done")
    expect(run.produced_inbox_item_id).toBe(item.id)

    // next_run_at advanced to a FUTURE time computed by nextRun
    const after = dao.getSchedule(s.id)!
    expect(after.last_run_at).toBe(now)
    expect(after.next_run_at).toBe(nextRun("* * * * *", now))
    expect(Date.parse(after.next_run_at!)).toBeGreaterThan(Date.parse(now))
  })

  it("concurrency 'skip' with an active run: does NOT push but still advances next_run_at", () => {
    const now = "2026-06-05T00:00:00.000Z"
    const dao = freshDao(() => now)
    const s = dao.createSchedule({
      name: "poll",
      trigger_kind: "cron",
      cron_expr: "* * * * *",
      target_kind: "workflow",
      target_ref: "mr-poller",
      concurrency_policy: "skip",
      next_run_at: now,
    })
    // pre-insert an active (running) run for this schedule
    dao.createScheduleRun({ schedule_id: s.id, status: "running" })

    const before = dao.listInboxItems().length
    scheduleTick(dao, now)

    // no new inbox item pushed
    expect(dao.listInboxItems().length).toBe(before)
    // but next_run_at still advanced so it doesn't busy-spin
    const after = dao.getSchedule(s.id)!
    expect(after.next_run_at).toBe(nextRun("* * * * *", now))
  })

  it("does not fire a schedule whose next_run_at is in the future", () => {
    const now = "2026-06-05T00:00:00.000Z"
    const dao = freshDao(() => now)
    dao.createSchedule({
      name: "future",
      trigger_kind: "cron",
      cron_expr: "* * * * *",
      target_kind: "workflow",
      target_ref: "r",
      next_run_at: "2026-06-09T00:00:00.000Z",
    })

    scheduleTick(dao, now)
    expect(dao.listInboxItems().length).toBe(0)
  })

  it("one schedule throwing does not stop another due schedule from firing", () => {
    const now = "2026-06-05T00:00:00.000Z"
    const dao = freshDao(() => now)
    // bad cron_expr → nextRun throws when advancing this schedule
    const bad = dao.createSchedule({
      name: "bad",
      trigger_kind: "cron",
      cron_expr: "not a cron",
      target_kind: "workflow",
      target_ref: "r",
      next_run_at: now,
    })
    const good = dao.createSchedule({
      name: "good",
      trigger_kind: "cron",
      cron_expr: "* * * * *",
      target_kind: "workflow",
      target_ref: "r",
      next_run_at: now,
    })

    scheduleTick(dao, now)

    // good schedule still fired
    const goodItems = dao.listInboxItems().filter((i) => i.kind === "schedule:good")
    expect(goodItems.length).toBe(1)

    // bad schedule's run is marked failed
    const badRun = dao.raw().query("SELECT * FROM schedule_run WHERE schedule_id=?").get(bad.id) as {
      status: string
      error: string | null
    }
    expect(badRun.status).toBe("failed")
    expect(badRun.error).toBeTruthy()

    // good schedule advanced
    expect(dao.getSchedule(good.id)!.next_run_at).toBe(nextRun("* * * * *", now))
  })

  it("a fired manual schedule clears next_run_at to null", () => {
    const now = "2026-06-05T00:00:00.000Z"
    const dao = freshDao(() => now)
    const s = dao.createSchedule({
      name: "once",
      trigger_kind: "manual",
      target_kind: "workflow",
      target_ref: "r",
      next_run_at: now, // run-now set it to now
    })

    scheduleTick(dao, now)

    expect(dao.listInboxItems().filter((i) => i.kind === "schedule:once").length).toBe(1)
    expect(dao.getSchedule(s.id)!.next_run_at).toBeNull()
  })

  it("calls publish with schedule.fired when provided", () => {
    const now = "2026-06-05T00:00:00.000Z"
    const dao = freshDao(() => now)
    dao.createSchedule({
      name: "poll",
      trigger_kind: "cron",
      cron_expr: "* * * * *",
      target_kind: "workflow",
      target_ref: "r",
      next_run_at: now,
    })
    const events: { kind: string; payload: unknown }[] = []
    scheduleTick(dao, now, (kind, payload) => events.push({ kind, payload }))
    expect(events.some((e) => e.kind === "schedule.fired")).toBe(true)
  })
})
