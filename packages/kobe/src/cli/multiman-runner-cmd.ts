/**
 * `kobe multiman runner --role <id>` — an autonomous role-runner.
 *
 * A LONG-RUNNING foreground process that drives the pure multiman runner loop
 * (`@sma1lboy/multiman/runner`) against a real kobe daemon. For each ASSIGNED
 * task claimed for its role it:
 *   1. transitions the task to `running` (the daemon materializes a worktree),
 *   2. launches the task's interactive engine (claude) in a DETACHED tmux
 *      session in that worktree (`ensureSession`),
 *   3. delivers the task's prompt as the first message (`deliverFirstPrompt`),
 *   4. waits for the engine to finish a turn — observed via the daemon's
 *      `engine-state` push channel (fed by global Claude Code hooks) — and
 *      maps that to a multiman {@link ExecuteResult}, then reports it back.
 *
 * The orchestration LOOP itself is pure and lives in the multiman package;
 * this file is the kobe-side adapter that supplies the side-effecting deps
 * (daemon RPC, tmux, history reads). It is the executor counterpart to the
 * thin `kobe multiman <noun> <verb>` client in `multiman-cmd.ts`.
 *
 * Imports the pure loop from `@sma1lboy/multiman/runner` (NOT the package
 * root) so multiman's `bun:sqlite` dependency stays out of this graph — the
 * runner submodule only imports `./types`.
 */

import { runLoop } from "@sma1lboy/multiman/runner"
import type { ExecuteResult, RunnerDeps } from "@sma1lboy/multiman/runner"
import type { Task } from "@sma1lboy/multiman/types"
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import type { KobeDaemonClient } from "../client/index.ts"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import type { ContentBlock } from "../types/content.ts"
import type { VendorId } from "../types/vendor.ts"

/** Default per-task wait budget for a turn to complete (15 min). */
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000
/** waitForWork cap — wake on a new task event OR poll at least this often. */
const WAIT_FOR_WORK_MS = 3_000
/** Heartbeat cadence while a task is running. */
const HEARTBEAT_INTERVAL_MS = 30_000

/** One engine-state event, as it arrives on the daemon's `engine-state` channel. */
interface EngineStateEvent {
  readonly taskId: string
  readonly state: "idle" | "running" | "turn_complete" | "rate_limited" | "permission_needed" | "error"
  readonly detail?: { readonly failure?: string; readonly waiting?: string; readonly note?: string }
  readonly at: number
}

/**
 * A tiny pub-sub over the daemon's `engine-state` channel. The runner wires
 * `client.on("engine-state", …)` into {@link push}; the executor calls
 * {@link waitFor} to await the first qualifying event for ITS task AFTER it
 * delivered the prompt (the `since` watermark avoids a replayed stale event,
 * which the daemon emits as last-value on subscribe).
 */
export class EngineStateBus {
  private readonly waiters = new Set<(e: EngineStateEvent) => void>()
  /** Cancel callbacks for in-flight {@link waitFor}s — fired by {@link abort}. */
  private readonly aborters = new Set<() => void>()

  push(event: EngineStateEvent): void {
    for (const w of [...this.waiters]) w(event)
  }

  /**
   * Cancel every in-flight {@link waitFor} (they resolve as `"aborted"`), so a
   * SIGINT/SIGTERM mid-turn unblocks the executor promptly instead of hanging
   * until the per-task timeout. Called from the runner's signal handler.
   */
  abort(): void {
    for (const a of [...this.aborters]) a()
  }

  /**
   * Resolve with the first `engine-state` event for `taskId` whose `at`
   * watermark is `>= since` and whose state is terminal-for-a-turn
   * (`turn_complete` / `rate_limited` / `error`). Intervening `running` /
   * `idle` events are ignored. Resolves `"timeout"` after `timeoutMs`, or
   * `"aborted"` if {@link abort} fires first.
   */
  waitFor(taskId: string, since: number, timeoutMs: number): Promise<EngineStateEvent | "timeout" | "aborted"> {
    return new Promise((resolve) => {
      const done = (value: EngineStateEvent | "timeout" | "aborted"): void => {
        clearTimeout(timer)
        this.waiters.delete(onEvent)
        this.aborters.delete(abort)
        resolve(value)
      }
      const onEvent = (e: EngineStateEvent): void => {
        if (e.taskId !== taskId) return
        if (e.at < since) return
        if (e.state === "turn_complete" || e.state === "rate_limited" || e.state === "error") done(e)
      }
      const abort = (): void => done("aborted")
      const timer = setTimeout(() => done("timeout"), timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      this.waiters.add(onEvent)
      this.aborters.add(abort)
    })
  }
}

/** Flatten a Claude message's content blocks to plain text (text + thinking). */
function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" | "thinking" }> => b.type === "text" || b.type === "thinking",
    )
    .map((b) => b.text)
    .join("\n")
    .trim()
}

/** The last assistant message's text for a recorded session, or "" when unavailable. */
async function lastAssistantText(sessionId: string): Promise<string> {
  // Dynamic import: history.ts is heavy and only needed on the success path.
  const { readHistory } = await import("../engine/claude-code-local/history.ts")
  const messages = await readHistory(sessionId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "assistant") {
      const text = blocksToText(m.blocks)
      if (text.length > 0) return text
    }
  }
  return ""
}

/** Read the `@kobe_session_id` recorded on the session's (single) window. */
async function readSessionId(session: string): Promise<string> {
  const { listChatTabWindows } = await import("../tmux/chat-tab-naming.ts")
  const windows = await listChatTabWindows(session)
  for (const w of windows) if (w.sessionId.length > 0) return w.sessionId
  return ""
}

export interface KobeExecutorOpts {
  /** Per-task turn timeout in ms. Defaults to {@link DEFAULT_TURN_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Progress logger. */
  readonly log?: (msg: string) => void
  /**
   * Re-fetch a task's CURRENT state by id. The pure runner loop hands the
   * executor the task as it was at CLAIM time — before `transition→running`
   * materializes the worktree (which sets `kobe_task_id` / `work_dir`). So
   * when those fields are absent we re-read the task here to pick up the
   * post-materialization values. Optional: omit in unit tests that supply a
   * fully-materialized task.
   */
  readonly fetchTask?: (id: string) => Promise<Task>
}

/**
 * Build the side-effecting `execute(task)` the runner loop calls. Drives a
 * task's engine in tmux and resolves to an {@link ExecuteResult} from the
 * engine-state outcome. See file header for the full state mapping.
 */
export function makeKobeExecutor(
  bus: EngineStateBus,
  opts: KobeExecutorOpts = {},
): (task: Task) => Promise<ExecuteResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const log = opts.log ?? (() => {})

  return async (claimed: Task): Promise<ExecuteResult> => {
    // The loop passes the CLAIM-time task; materialization (worktree create)
    // happens during `transition→running` AFTER claim, so re-fetch the current
    // task to pick up `kobe_task_id` / `work_dir` if they're not set yet.
    let task = claimed
    if ((!task.kobe_task_id || !task.work_dir) && opts.fetchTask) {
      try {
        task = await opts.fetchTask(claimed.id)
      } catch (err) {
        return {
          status: "failed",
          error: `could not re-fetch task: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
    const kobeTaskId = task.kobe_task_id
    const workDir = task.work_dir
    if (!kobeTaskId || !workDir) {
      return { status: "failed", error: "task not materialized (missing kobe_task_id/work_dir)" }
    }

    // Default vendor claude; honor a task that already names a known vendor.
    const vendor: VendorId = "claude"

    // Imported lazily — the tmux module statically pulls node-side tmux helpers
    // that are fine under bun but we keep them off the cold CLI path.
    const { ensureSession, tmuxSessionName } = await import("../tui/panes/terminal/tmux.ts")
    const { waitForEnginePane, deliverFirstPrompt } = await import("../tmux/prompt-delivery.ts")

    const session = tmuxSessionName(kobeTaskId)
    const ok = await ensureSession({
      name: session,
      cwd: workDir,
      command: interactiveEngineCommand(vendor),
      taskId: kobeTaskId,
      vendor,
    })
    if (!ok) return { status: "failed", error: "session setup failed" }

    // Make sure the engine pane painted before we paste (best-effort; we
    // still deliver if the budget lapses).
    await waitForEnginePane(session, true)

    // Arm the engine-state wait BEFORE delivering the prompt so a fast turn
    // can't complete in the gap between deliver and await. The `since`
    // watermark is set just before delivery, so a replayed stale event from a
    // previous turn (the daemon caches last-value per channel) is ignored.
    const since = Date.now()
    const outcome = bus.waitFor(kobeTaskId, since, timeoutMs)

    const prompt = task.body && task.body.length > 0 ? `${task.title}\n\n${task.body}` : task.title
    log(`delivering prompt to ${session} (${prompt.length} chars)`)
    await deliverFirstPrompt(session, prompt)

    const result = await outcome
    if (result === "timeout") return { status: "blocked", error: "timeout" }
    if (result === "aborted") return { status: "blocked", error: "runner stopping" }

    if (result.state === "rate_limited") return { status: "blocked", error: "rate_limited" }
    if (result.state === "error") return { status: "failed", error: result.detail?.note ?? "engine error" }

    // turn_complete → harvest the last assistant message as the result text.
    let text = ""
    try {
      const sessionId = await readSessionId(session)
      if (sessionId.length > 0) text = await lastAssistantText(sessionId)
    } catch {
      // fall through to the worktree-scan fallback below
    }
    if (text.length === 0) {
      try {
        const { createEngineTurnDetector } = await import("../engine/turn-detector.ts")
        const marker = await createEngineTurnDetector(vendor).latestCompletion(workDir)
        if (marker) text = `turn complete (${new Date(marker.timestampMs).toISOString()})`
      } catch {
        /* best-effort */
      }
    }
    return { status: "in_review", result: text.length > 0 ? text : "turn complete" }
  }
}

/** A user-facing CLI error (bad flags / missing args). */
class RunnerCliError extends Error {}

const RUNNER_USAGE = [
  "Usage: kobe multiman runner --role <id> [--timeout-ms <n>]",
  "",
  "Run an autonomous role-runner: claim ASSIGNED tasks for <id>, drive each",
  "task's engine (claude) in a detached tmux session, and report the outcome.",
  "Long-running; Ctrl-C to stop.",
  "",
  "Flags:",
  "  --role <id>         role to run for (required)",
  "  --timeout-ms <n>    per-task turn timeout in ms (default 900000)",
  "",
].join("\n")

function parseRunnerArgs(argv: readonly string[]): { roleId: string; timeoutMs?: number; help: boolean } {
  let roleId = ""
  let timeoutMs: number | undefined
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      help = true
      continue
    }
    if (!arg.startsWith("--")) throw new RunnerCliError(`unexpected argument: ${arg}`)
    const eq = arg.indexOf("=")
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    let value = eq === -1 ? undefined : arg.slice(eq + 1)
    if (value === undefined) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) throw new RunnerCliError(`flag --${key} requires a value`)
      value = next
      i += 1
    }
    if (key === "role") roleId = value
    else if (key === "timeout-ms") {
      const n = Number.parseInt(value, 10)
      if (!Number.isInteger(n) || n <= 0) throw new RunnerCliError("--timeout-ms must be a positive integer")
      timeoutMs = n
    } else throw new RunnerCliError(`unknown flag: --${key}`)
  }
  return { roleId, timeoutMs, help }
}

function ts(): string {
  return new Date().toISOString()
}

/**
 * Entry point for `kobe multiman runner …` (dispatched from
 * {@link runMultimanSubcommand}). Wires the daemon RPC + tmux executor into
 * the pure runner loop and runs until SIGINT/SIGTERM.
 */
export async function runMultimanRunner(argv: readonly string[]): Promise<void> {
  let parsed: { roleId: string; timeoutMs?: number; help: boolean }
  try {
    parsed = parseRunnerArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${RUNNER_USAGE}\n`)
    process.exit(2)
  }
  if (parsed.help) {
    process.stdout.write(`${RUNNER_USAGE}\n`)
    return
  }
  if (!parsed.roleId) {
    process.stderr.write(`--role is required\n\n${RUNNER_USAGE}\n`)
    process.exit(2)
  }
  const roleId = parsed.roleId

  const log = (msg: string): void => {
    process.stderr.write(`[${ts()}] runner(${roleId}) ${msg}\n`)
  }

  // Ensure global engine hooks so engine-state events actually flow.
  const { ensureGlobalKobeHooks } = await import("./hook-cmd.ts")
  await ensureGlobalKobeHooks()

  let client: KobeDaemonClient
  try {
    client = await connectOrStartDaemon()
  } catch (err) {
    process.stderr.write(
      `could not reach or start the kobe daemon: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(2)
  }

  // Subscribe as a "runner" so the daemon stays alive for our lifetime and we
  // receive the `engine-state` + `multiman` channels.
  await client.subscribe({ role: "runner" })

  const bus = new EngineStateBus()
  client.onChannel("engine-state", (payload) => bus.push(payload as EngineStateEvent))

  // Wake the loop early when the kernel emits a multiman event (e.g. a task was
  // just assigned) instead of always waiting out the poll interval.
  let wakeWaiter: (() => void) | null = null
  client.onChannel("multiman", () => {
    const w = wakeWaiter
    wakeWaiter = null
    w?.()
  })

  const execute = makeKobeExecutor(bus, {
    timeoutMs: parsed.timeoutMs,
    log,
    fetchTask: (id) => client.request<Task>("multiman", { method: "task.get", params: { id } }),
  })

  const deps: RunnerDeps = {
    claim: async () => {
      const t = await client.request<Task | null>("multiman", {
        method: "task.claim",
        params: { roleId },
      })
      return t
    },
    transitionRunning: (id) =>
      client.request<Task>("multiman", { method: "task.transition", params: { id, to: "running" } }),
    heartbeat: (id) => {
      void client
        .request("multiman", { method: "task.heartbeat", params: { id, roleId } })
        .catch((err) => log(`heartbeat failed for ${id}: ${err instanceof Error ? err.message : String(err)}`))
    },
    report: (id, status, result, error) =>
      client.request<Task>("multiman", {
        method: "task.report",
        params: { id, status, result, error },
      }),
    execute,
    waitForWork: () =>
      new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          if (wakeWaiter === finish) wakeWaiter = null
          if (timer !== undefined) clearTimeout(timer)
          resolve()
        }
        wakeWaiter = finish
        const timer = setTimeout(finish, WAIT_FOR_WORK_MS)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    log: (msg) => {
      // Surface per-iteration progress with claimed-task context.
      if (msg.startsWith("claimed task ")) log(`claimed ${msg.slice("claimed task ".length)}`)
      else log(msg)
    },
  }

  // Stop on SIGINT/SIGTERM: flip the flag (so the loop exits before the next
  // claim), abort any in-flight engine-state wait (so a mid-turn execute
  // unblocks instead of hanging to its timeout), and wake a sleeping
  // waitForWork. The loop then settles within an iteration and tears down.
  let stopped = false
  const onSignal = (sig: string): void => {
    log(`received ${sig}; stopping after current task…`)
    stopped = true
    bus.abort()
    wakeWaiter?.()
  }
  process.on("SIGINT", () => onSignal("SIGINT"))
  process.on("SIGTERM", () => onSignal("SIGTERM"))

  log(`multiman runner for role ${roleId} — Ctrl-C to stop`)

  try {
    await runLoopWithProgress(deps, () => stopped)
  } finally {
    client.close()
  }
  process.exit(0)
}

/**
 * Run the pure loop but wrap `execute`/`report` so each iteration prints
 * structured progress (→ running / ✓ in_review / ✗ failed). The loop itself
 * is unchanged — we decorate the deps it was handed.
 */
async function runLoopWithProgress(deps: RunnerDeps, stop: () => boolean): Promise<void> {
  const log = deps.log ?? (() => {})
  const decorated: RunnerDeps = {
    ...deps,
    transitionRunning: async (id) => {
      const t = await deps.transitionRunning(id)
      log(`→ running ${id}${t.title ? ` (${t.title})` : ""}`)
      return t
    },
    report: async (id, status, result, error) => {
      const t = await deps.report(id, status, result, error)
      const mark = status === "in_review" ? "✓" : status === "blocked" ? "⏸" : "✗"
      log(`${mark} ${status} ${id}${error ? ` — ${error}` : ""}`)
      return t
    },
  }
  await runLoop(decorated, { stop })
}
