/**
 * `kobe multiman status [--watch]` — a live observability view of multiman.
 *
 * Fetches a snapshot (roles, all tasks, all inbox items) over the daemon's
 * `multiman` passthrough RPC and prints the pure {@link renderStatus} dashboard
 * from `@sma1lboy/multiman/status-view`.
 *
 *   - one-shot (default): fetch once, print, exit 0 — a thin client like the
 *     `kobe multiman <noun> <verb>` commands in `multiman-cmd.ts`.
 *   - `--watch`: hold a persistent `KobeDaemonClient` (subscribe role:"runner"
 *     to keep the daemon alive + receive `multiman` channel events), then loop:
 *     clear screen, render snapshot + footer, wait for either a `multiman`
 *     event OR `interval` ms, refetch, redraw. SIGINT/SIGTERM → close + exit 0.
 *     Mirrors the lifetime/subscribe/signal pattern of `multiman-runner-cmd.ts`.
 */

import { renderStatus } from "@sma1lboy/multiman/status-view"
import type { InboxItem, Role, Task } from "@sma1lboy/multiman/types"
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import type { KobeDaemonClient } from "../client/index.ts"

/** Default redraw cadence when no `multiman` event arrives first. */
const DEFAULT_INTERVAL_MS = 2_000

const STATUS_USAGE = [
  "Usage: kobe multiman status [--watch] [--interval <ms>]",
  "",
  "Render a live dashboard of multiman state: roles, tasks by status, inbox,",
  "and DAG rollups.",
  "",
  "Flags:",
  "  --watch             keep redrawing (on a multiman event or every interval)",
  "  --interval <ms>     watch redraw cadence in ms (default 2000)",
  "",
].join("\n")

/** A user-facing CLI error (bad flags). */
class StatusCliError extends Error {}

interface ParsedStatusArgs {
  readonly watch: boolean
  readonly intervalMs: number
  readonly help: boolean
}

function parseStatusArgs(argv: readonly string[]): ParsedStatusArgs {
  let watch = false
  let intervalMs = DEFAULT_INTERVAL_MS
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      help = true
      continue
    }
    if (!arg.startsWith("--")) throw new StatusCliError(`unexpected argument: ${arg}`)
    const eq = arg.indexOf("=")
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (key === "watch") {
      const v = eq === -1 ? undefined : arg.slice(eq + 1)
      watch = v === undefined || (v !== "false" && v !== "0")
      continue
    }
    let value = eq === -1 ? undefined : arg.slice(eq + 1)
    if (value === undefined) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) throw new StatusCliError(`flag --${key} requires a value`)
      value = next
      i += 1
    }
    if (key === "interval") {
      const n = Number.parseInt(value, 10)
      if (!Number.isInteger(n) || n <= 0) throw new StatusCliError("--interval must be a positive integer")
      intervalMs = n
    } else throw new StatusCliError(`unknown flag: --${key}`)
  }
  return { watch, intervalMs, help }
}

/** Fetch a full snapshot (roles + all tasks + all inbox items) in parallel. */
async function fetchSnapshot(client: KobeDaemonClient): Promise<{ roles: Role[]; tasks: Task[]; inbox: InboxItem[] }> {
  const [roles, tasks, inbox] = await Promise.all([
    client.request<Role[]>("multiman", { method: "role.list", params: {} }),
    client.request<Task[]>("multiman", { method: "task.list", params: {} }),
    client.request<InboxItem[]>("multiman", { method: "inbox.list", params: {} }),
  ])
  return { roles, tasks, inbox }
}

/**
 * Entry point for `kobe multiman status …` (dispatched from
 * {@link runMultimanSubcommand}). One-shot by default; `--watch` runs a
 * persistent redraw loop until SIGINT/SIGTERM.
 */
export async function runMultimanStatus(argv: readonly string[]): Promise<void> {
  let parsed: ParsedStatusArgs
  try {
    parsed = parseStatusArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${STATUS_USAGE}\n`)
    process.exit(2)
  }
  if (parsed.help) {
    process.stdout.write(`${STATUS_USAGE}\n`)
    return
  }

  let client: KobeDaemonClient
  try {
    client = await connectOrStartDaemon()
  } catch (err) {
    process.stderr.write(
      `could not reach or start the kobe daemon: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(2)
  }

  // One-shot: fetch, render, exit. No subscription needed.
  if (!parsed.watch) {
    try {
      const snapshot = await fetchSnapshot(client)
      process.stdout.write(`${renderStatus(snapshot)}\n`)
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      client.close()
      process.exit(1)
    }
    client.close()
    return
  }

  // Watch: subscribe as a "runner" so the daemon stays alive for our lifetime
  // and we receive the `multiman` channel (a kernel event wakes a redraw early
  // instead of always waiting out the interval).
  await client.subscribe({ role: "runner" })

  let wakeWaiter: (() => void) | null = null
  client.onChannel("multiman", () => {
    const w = wakeWaiter
    wakeWaiter = null
    w?.()
  })

  let stopped = false
  const onSignal = (): void => {
    stopped = true
    wakeWaiter?.()
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  try {
    while (!stopped) {
      const snapshot = await fetchSnapshot(client)
      // Clear screen + home cursor, then paint a fresh frame.
      process.stdout.write("\x1b[2J\x1b[H")
      process.stdout.write(`${renderStatus(snapshot)}\n`)
      process.stdout.write(`\n(updated ${new Date().toISOString()}; Ctrl-C to quit)\n`)
      if (stopped) break
      // Wake on either a multiman event OR the interval, whichever is first.
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          if (wakeWaiter === finish) wakeWaiter = null
          clearTimeout(timer)
          resolve()
        }
        wakeWaiter = finish
        const timer = setTimeout(finish, parsed.intervalMs)
        ;(timer as { unref?: () => void }).unref?.()
      })
    }
  } finally {
    client.close()
  }
  process.exit(0)
}
