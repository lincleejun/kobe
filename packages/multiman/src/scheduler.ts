// src/scheduler.ts
//
// The scheduler is the cron→inbox bridge (S2 part B). On each tick it fires
// every DUE schedule by PUSHING an inbox_item (the "collection trigger") and
// records a schedule_run around it. It never creates tasks directly — turning
// an inbox_item into tasks is S3's job.
//
// `scheduleTick` is pure (no timers, injected `now`); `startScheduler` is the
// background worker wrapper, mirroring `startSweeper`.

import { nextRun } from "./cron"
import type { Dao } from "./db/dao"
import type { MultimanKernel } from "./kernel"
import type { Schedule } from "./types"

// For a cron trigger, the next matching instant after `now`; for a manual
// trigger (fired via run-now, which set next_run_at=now), clear it so a
// one-shot doesn't refire. May throw on a malformed cron_expr.
function nextRunAtFor(s: Schedule, now: string): string | null {
  return s.trigger_kind === "cron" ? nextRun(s.cron_expr ?? "", now) : null
}

/**
 * Fire all schedules due at `now`. Best-effort per schedule: a single bad
 * schedule (e.g. a malformed cron_expr) is marked failed and skipped — it never
 * blocks the others.
 */
export function scheduleTick(dao: Dao, now: string, publish?: (kind: string, payload: unknown) => void): void {
  for (const s of dao.dueSchedules(now)) {
    // Compute the next fire time first: for cron, the next matching instant;
    // for manual (a run-now), clear it so a one-shot doesn't refire. This can
    // throw on a malformed cron_expr — that's caught below and the offending
    // schedule's run is marked failed without touching the rest.
    let runId: string | undefined
    try {
      // concurrency: 'skip' → don't fire while a run is in flight, but STILL
      // advance next_run_at so it doesn't busy-spin. 'queue'/'replace' fire
      // anyway (S2 simplification: no real queueing/cancellation yet). No run
      // record is created for a skip; a skipped fire is a non-event.
      if (s.concurrency_policy === "skip" && dao.activeRunCountForSchedule(s.id) > 0) {
        dao.updateSchedule(s.id, { last_run_at: now, next_run_at: nextRunAtFor(s, now) })
        continue
      }

      // Create the run BEFORE computing nextRunAt so that a malformed cron_expr
      // (which throws in nextRun) is recorded as a FAILED run, not silently lost.
      const run = dao.createScheduleRun({ schedule_id: s.id, status: "running" })
      runId = run.id
      const nextRunAt = nextRunAtFor(s, now)
      const item = dao.createInboxItem({
        source: s.id,
        kind: `schedule:${s.name}`,
        payload: JSON.stringify({
          schedule_id: s.id,
          name: s.name,
          target_kind: s.target_kind,
          target_ref: s.target_ref,
          execution_mode: s.execution_mode,
        }),
        severity: "info",
      })
      dao.finishScheduleRun(run.id, { status: "done", produced_inbox_item_id: item.id })
      dao.updateSchedule(s.id, { last_run_at: now, next_run_at: nextRunAt })
      publish?.("schedule.fired", { schedule_id: s.id, name: s.name, inbox_item_id: item.id })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      if (runId) dao.finishScheduleRun(runId, { status: "failed", error })
      // Leave next_run_at as-is on failure (it stays due) so a transient error
      // retries on the next tick rather than silently dropping the schedule.
      console.error(`[multiman] schedule ${s.id} (${s.name}) fire error`, e)
    }
  }
}

export function startScheduler(kernel: MultimanKernel, opts: { intervalMs?: number } = {}): () => void {
  const intervalMs = opts.intervalMs ?? 30_000
  if (intervalMs <= 0) return () => {}
  let running = false
  const tick = () => {
    if (running) return // skip overlapping ticks
    running = true
    try {
      scheduleTick(kernel.getDao(), new Date().toISOString(), (kind, payload) => kernel.publishEvent(kind, payload))
    } catch (e) {
      console.error("[multiman] scheduler tick error", e)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
