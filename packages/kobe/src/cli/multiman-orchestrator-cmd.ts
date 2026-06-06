/**
 * `kobe multiman orchestrator --role <id>` — an autonomous decomposer.
 *
 * A LONG-RUNNING foreground process that drives the pure multiman orchestrator
 * loop (`@sma1lboy/multiman/orchestrator`) against a real kobe daemon. For each
 * NEW inbox item it claims for its (orchestrator) role it:
 *   1. asks a headless `claude -p` to reason the item into a task DAG (one-shot,
 *      no tmux — decomposition isn't an interactive coding session; the child
 *      tasks it emits are executed later by the S1 tmux runner),
 *   2. parses + validates the LLM's JSON DAG ({@link parseDecomposeOutput}),
 *   3. resolves each task's `roleName` → `role_id`,
 *   4. creates the DAG via `dag.create`,
 *   5. marks the inbox item `processed` (or `archived` on any failure — the loop
 *      is failure-safe and never wedges on a bad item).
 *
 * The orchestration LOOP is pure and lives in the multiman package; this file is
 * the kobe-side adapter that supplies the side-effecting deps (daemon RPC, the
 * headless LLM). It mirrors `multiman-runner-cmd.ts`.
 */

import { parseDecomposeOutput } from "@sma1lboy/multiman/decompose-parse"
import { type DecomposeResult, type OrchestratorDeps, orchestrateLoop } from "@sma1lboy/multiman/orchestrator"
import type { InboxItem, Role } from "@sma1lboy/multiman/types"
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import type { KobeDaemonClient } from "../client/index.ts"

/** waitForWork cap — wake on a new multiman event OR poll at least this often. */
const WAIT_FOR_WORK_MS = 3_000
/** Default headless-claude decomposition budget per inbox item (2 min). */
const DEFAULT_DECOMPOSE_TIMEOUT_MS = 120_000

/** A task as the LLM must emit it (kept narrow on purpose for the prompt). */
interface DecomposerOpts {
  /** The orchestrator role's instructions (steer the decomposition). */
  readonly instructions: string
  /** Names of every available role, so the LLM can assign tasks. */
  readonly roleNames: readonly string[]
  /** Per-item decomposition timeout in ms. */
  readonly timeoutMs?: number
  /** Working directory for the headless claude process. */
  readonly cwd?: string
  /** Progress logger. */
  readonly log?: (msg: string) => void
}

/**
 * Build the prompt handed to headless `claude -p`. It frames the task (decompose
 * an inbox item into a DAG), lists the assignable roles, pins the exact JSON
 * shape, and embeds the item's `kind` + parsed payload.
 */
function buildDecomposePrompt(item: InboxItem, opts: DecomposerOpts): string {
  let payload: unknown = item.payload
  try {
    payload = JSON.parse(item.payload)
  } catch {
    // leave as the raw string if it isn't JSON
  }
  const roles = opts.roleNames.length > 0 ? opts.roleNames.join(", ") : "(none)"
  const lines = [
    opts.instructions.trim(),
    "",
    `You decompose an inbox item into a task DAG. Available roles: ${roles}. Output ONLY a JSON object {"tasks":[{"key","title","body","roleName","repo"}],"edges":[[from,to]]}. Assign each task to one available role by name. edges: [fromKey,toKey] means toKey depends on fromKey.`,
    "",
    "Inbox item:",
    `kind: ${item.kind}`,
    `payload: ${typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}`,
  ]
  return lines.join("\n")
}

/**
 * Build the side-effecting `decompose(item)` the loop calls. Spawns a headless
 * `claude -p <prompt>`, awaits exit under a timeout, and parses its stdout into
 * a {@link DecomposeResult}. Throws on timeout / non-zero exit / unparseable
 * output — the loop archives the item on any throw.
 */
export function makeClaudeDecomposer(opts: DecomposerOpts): (item: InboxItem) => Promise<DecomposeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DECOMPOSE_TIMEOUT_MS
  const log = opts.log ?? (() => {})

  return async (item: InboxItem): Promise<DecomposeResult> => {
    const prompt = buildDecomposePrompt(item, opts)
    log(`decomposing inbox item ${item.id} via headless claude (${prompt.length} chars)`)

    const proc = Bun.spawn(["claude", "-p", prompt], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd ?? process.cwd(),
    })

    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()

    let stdout: string
    let stderr: string
    let exitCode: number
    try {
      ;[stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      exitCode = await proc.exited
    } finally {
      clearTimeout(timer)
    }

    if (proc.killed && exitCode !== 0) {
      throw new Error(`headless claude timed out after ${timeoutMs}ms`)
    }
    if (exitCode !== 0) {
      throw new Error(`headless claude exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`)
    }
    return parseDecomposeOutput(stdout)
  }
}

/** A user-facing CLI error (bad flags / missing args). */
class OrchestratorCliError extends Error {}

const ORCHESTRATOR_USAGE = [
  "Usage: kobe multiman orchestrator --role <id> [--timeout-ms <n>]",
  "",
  "Run an autonomous decomposer: claim NEW inbox items for <id>, ask headless",
  "claude to reason each into a task DAG, create the DAG, and mark the item",
  "processed (archived on failure). Long-running; Ctrl-C to stop.",
  "",
  "Flags:",
  "  --role <id>         orchestrator role to run for (required)",
  "  --timeout-ms <n>    per-item decomposition timeout in ms (default 120000)",
  "",
].join("\n")

function parseOrchestratorArgs(argv: readonly string[]): { roleId: string; timeoutMs?: number; help: boolean } {
  let roleId = ""
  let timeoutMs: number | undefined
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      help = true
      continue
    }
    if (!arg.startsWith("--")) throw new OrchestratorCliError(`unexpected argument: ${arg}`)
    const eq = arg.indexOf("=")
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    let value = eq === -1 ? undefined : arg.slice(eq + 1)
    if (value === undefined) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) throw new OrchestratorCliError(`flag --${key} requires a value`)
      value = next
      i += 1
    }
    if (key === "role") roleId = value
    else if (key === "timeout-ms") {
      const n = Number.parseInt(value, 10)
      if (!Number.isInteger(n) || n <= 0) throw new OrchestratorCliError("--timeout-ms must be a positive integer")
      timeoutMs = n
    } else throw new OrchestratorCliError(`unknown flag: --${key}`)
  }
  return { roleId, timeoutMs, help }
}

function ts(): string {
  return new Date().toISOString()
}

/**
 * Entry point for `kobe multiman orchestrator …` (dispatched from
 * {@link runMultimanSubcommand}). Wires the daemon RPC + headless-claude
 * decomposer into the pure orchestrator loop and runs until SIGINT/SIGTERM.
 */
export async function runMultimanOrchestrator(argv: readonly string[]): Promise<void> {
  let parsed: { roleId: string; timeoutMs?: number; help: boolean }
  try {
    parsed = parseOrchestratorArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${ORCHESTRATOR_USAGE}\n`)
    process.exit(2)
  }
  if (parsed.help) {
    process.stdout.write(`${ORCHESTRATOR_USAGE}\n`)
    return
  }
  if (!parsed.roleId) {
    process.stderr.write(`--role is required\n\n${ORCHESTRATOR_USAGE}\n`)
    process.exit(2)
  }
  const roleId = parsed.roleId

  const log = (msg: string): void => {
    process.stderr.write(`[${ts()}] orchestrator(${roleId}) ${msg}\n`)
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

  // Subscribe as a "runner" so the daemon stays alive for our lifetime and we
  // receive the `multiman` channel (a new inbox item wakes the loop early).
  await client.subscribe({ role: "runner" })

  // Wake the loop early when the kernel emits a multiman event instead of
  // always waiting out the poll interval.
  let wakeWaiter: (() => void) | null = null
  client.onChannel("multiman", () => {
    const w = wakeWaiter
    wakeWaiter = null
    w?.()
  })

  // Fetch the orchestrator role (for its instructions) + the full role list
  // (for name → id resolution and the available-roles prompt hint).
  const role = await client.request<Role | null>("multiman", { method: "role.get", params: { id: roleId } })
  if (role === null) {
    process.stderr.write(`role ${roleId} not found\n`)
    client.close()
    process.exit(2)
  }
  const roles = await client.request<Role[]>("multiman", { method: "role.list", params: {} })
  const roleNames = roles.map((r) => r.name)

  const decompose = makeClaudeDecomposer({
    instructions: role.instructions,
    roleNames,
    timeoutMs: parsed.timeoutMs,
    log,
  })

  const deps: OrchestratorDeps = {
    claimInbox: () =>
      client.request<InboxItem | null>("multiman", { method: "inbox.claim", params: { consumer: roleId } }),
    decompose,
    resolveRole: async (roleName) => {
      if (roleName === undefined) return null
      const wanted = roleName.toLowerCase()
      const match = roles.find((r) => r.name.toLowerCase() === wanted)
      return match ? match.id : null
    },
    createDag: (info, tasks, edges) =>
      client.request("multiman", {
        method: "dag.create",
        params: { title: info.title, tasks, edges },
      }),
    markInbox: (id, status) =>
      client.request("multiman", { method: "inbox.mark", params: { id, status } }).then(() => undefined),
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
    log,
  }

  // Stop on SIGINT/SIGTERM: flip the flag (so the loop exits before the next
  // claim) and wake a sleeping waitForWork so it settles within an iteration.
  let stopped = false
  const onSignal = (sig: string): void => {
    log(`received ${sig}; stopping after current item…`)
    stopped = true
    wakeWaiter?.()
  }
  process.on("SIGINT", () => onSignal("SIGINT"))
  process.on("SIGTERM", () => onSignal("SIGTERM"))

  log(`multiman orchestrator for role ${roleId} — Ctrl-C to stop`)

  try {
    await orchestrateLoop(deps, { stop: () => stopped })
  } finally {
    client.close()
  }
  process.exit(0)
}
