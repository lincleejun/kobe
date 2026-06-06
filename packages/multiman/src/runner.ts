import type { Task, TaskStatus } from "./types"

export interface ExecuteResult {
  status: Extract<TaskStatus, "in_review" | "failed" | "blocked">
  result?: string
  error?: string
}

export interface RunnerDeps {
  claim: () => Promise<Task | null>
  transitionRunning: (id: string) => Promise<Task>
  heartbeat: (id: string) => void
  report: (id: string, status: ExecuteResult["status"], result?: string, error?: string) => Promise<Task>
  execute: (task: Task) => Promise<ExecuteResult>
  waitForWork: () => Promise<void>
  log?: (msg: string) => void
  heartbeatIntervalMs?: number
}

// One iteration. Returns the task it processed, or null if there was no work (it waited).
export async function runOnce(deps: RunnerDeps): Promise<Task | null> {
  const t = await deps.claim()
  if (t === null) {
    await deps.waitForWork()
    return null
  }
  deps.log?.(`claimed task ${t.id}`)
  await deps.transitionRunning(t.id)

  const intervalMs = deps.heartbeatIntervalMs ?? 30_000
  let ticker: ReturnType<typeof setInterval> | undefined
  if (intervalMs > 0) {
    ticker = setInterval(() => deps.heartbeat(t.id), intervalMs)
    ;(ticker as { unref?: () => void }).unref?.()
  }

  try {
    const r = await deps.execute(t)
    await deps.report(t.id, r.status, r.result, r.error)
  } catch (e) {
    await deps.report(t.id, "failed", undefined, String(e))
  } finally {
    if (ticker !== undefined) clearInterval(ticker)
  }
  return t
}

// Loop until stop() returns true. stop is checked before each claim.
export async function runLoop(deps: RunnerDeps, opts: { stop: () => boolean }): Promise<void> {
  while (!opts.stop()) {
    await runOnce(deps)
  }
}
