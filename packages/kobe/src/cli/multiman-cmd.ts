/**
 * `kobe multiman <noun> <verb>` — a THIN client over the multiman kernel.
 *
 * Every invocation is a short-lived process: connect to (or auto-start) the
 * daemon, tunnel ONE JSON-RPC call to the in-process multiman kernel via the
 * daemon's `multiman` passthrough request (`request("multiman", { method,
 * params })`), print the kernel's result as JSON on stdout, exit. No DB, no
 * `bun:sqlite` — the kernel (and its SQLite handle) lives in the daemon; this
 * command only speaks the socket protocol (KOB, Task 20).
 *
 * Mirrors `cli/api-cmd.ts`: same `connectOrStartDaemon()` autostart, the same
 * `emit`/`fail` stdout/stderr contract, and `client.close()` in a `finally`.
 * The grammar here is positional (`role create`, `task assign <id>`) rather
 * than api-cmd's flat verb table, so the dispatch is leaner — but the daemon
 * plumbing is identical.
 *
 * ## Output contract
 *   - success → one JSON object to stdout, `\n` terminated, exit 0
 *   - error   → `{ "error": { "message" } }` to stderr, exit ≠ 0
 *   - `--help` → render usage to stdout, exit 0
 */

import { resolve } from "node:path"
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import type { KobeDaemonClient } from "../client/index.ts"

/** Role kinds accepted by `role create` (validated client-side for a clean
 *  error; the kernel is still the source of truth). */
const ROLE_KINDS = ["worker", "orchestrator", "collector"] as const

const MULTIMAN_USAGE = [
  "Usage: kobe multiman <noun> <verb> [args] [flags]",
  "",
  "A thin client over the multiman kernel (talks to the daemon over its socket).",
  "Every command prints the kernel's JSON result to stdout (exit 0); errors are",
  "JSON on stderr (exit != 0).",
  "",
  "Commands:",
  "  role create --name <n> --kind <worker|orchestrator|collector> [--instructions <s>]",
  "  role list",
  "  task create --title <t> [--role <id>] [--repo <path>] [--priority <n>]",
  "  task list [--status <s>]",
  "  task assign <taskId> --role <id>",
  "  task claim --role <id>",
  "  task transition <taskId> --to <status>",
  "  task get <taskId>",
  "  runner --role <id> [--timeout-ms <n>]   (long-running autonomous role-runner)",
  "",
  "Global: [--pretty] [--help]",
  "",
].join("\n")

type Flags = Map<string, string>

interface ParsedArgs {
  /** Positionals after the noun+verb (e.g. the `<taskId>`). */
  readonly positionals: readonly string[]
  readonly flags: Flags
  readonly pretty: boolean
  readonly help: boolean
}

/** A user-facing CLI error (bad flags / missing args) — distinct from a kernel
 *  RPC error, so dispatch can pick the right exit code. */
class CliError extends Error {}

/**
 * Parse argv into positionals + a flag map + `--pretty` / `--help` booleans.
 * Accepts both `--key=value` and `--key value`. `--pretty` / `--help` are the
 * only standalone (value-less) flags. Anything not starting with `--` is a
 * positional. Mirrors `api-cmd.ts`'s `parseFlags`, extended for positionals.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  let pretty = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-h") {
      help = true
      continue
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    if (eq !== -1) {
      const key = arg.slice(2, eq)
      const value = arg.slice(eq + 1)
      if (key === "pretty") pretty = value !== "false" && value !== "0"
      else if (key === "help") help = value !== "false" && value !== "0"
      else flags.set(key, value)
      continue
    }
    const key = arg.slice(2)
    if (key === "pretty") {
      pretty = true
      continue
    }
    if (key === "help") {
      help = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      throw new CliError(`flag --${key} requires a value`)
    }
    flags.set(key, next)
    i += 1
  }
  return { positionals, flags, pretty, help }
}

function required(flags: Flags, key: string): string {
  const v = flags.get(key)
  if (v === undefined || v.length === 0) throw new CliError(`--${key} is required`)
  return v
}

function optional(flags: Flags, key: string): string | undefined {
  const v = flags.get(key)
  return v && v.length > 0 ? v : undefined
}

function requirePositional(positionals: readonly string[], label: string): string {
  const v = positionals[0]
  if (v === undefined || v.length === 0) throw new CliError(`${label} is required`)
  return v
}

function optionalPositiveInt(flags: Flags, key: string): number | undefined {
  const raw = optional(flags, key)
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`--${key} must be a positive integer`)
  return n
}

/** Drop undefined-valued keys so the kernel sees a clean params object. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

/**
 * Map a parsed `kobe multiman <noun> <verb>` invocation to a kernel JSON-RPC
 * `{ method, params }`. Throws {@link CliError} on a bad noun/verb or missing
 * required arg — never touches the daemon. Returns the RPC the caller tunnels
 * through the `multiman` passthrough request.
 */
function toRpc(noun: string, verb: string, parsed: ParsedArgs): { method: string; params: Record<string, unknown> } {
  const { flags, positionals } = parsed
  if (noun === "role") {
    if (verb === "create") {
      const kind = required(flags, "kind")
      if (!ROLE_KINDS.includes(kind as (typeof ROLE_KINDS)[number])) {
        throw new CliError(`--kind must be one of ${ROLE_KINDS.join(", ")}`)
      }
      return {
        method: "role.create",
        params: compact({ name: required(flags, "name"), kind, instructions: optional(flags, "instructions") }),
      }
    }
    if (verb === "list") return { method: "role.list", params: {} }
    throw new CliError(`unknown role command: ${verb}`)
  }

  if (noun === "task") {
    if (verb === "create") {
      return {
        method: "task.create",
        params: compact({
          title: required(flags, "title"),
          roleId: optional(flags, "role"),
          repo: optional(flags, "repo") ? resolve(process.cwd(), required(flags, "repo")) : undefined,
          priority: optionalPositiveInt(flags, "priority"),
        }),
      }
    }
    if (verb === "list") return { method: "task.list", params: compact({ status: optional(flags, "status") }) }
    if (verb === "assign") {
      const id = requirePositional(positionals, "<taskId>")
      return { method: "task.transition", params: { id, to: "assigned", roleId: required(flags, "role") } }
    }
    if (verb === "claim") return { method: "task.claim", params: { roleId: required(flags, "role") } }
    if (verb === "transition") {
      const id = requirePositional(positionals, "<taskId>")
      return { method: "task.transition", params: { id, to: required(flags, "to") } }
    }
    if (verb === "get") return { method: "task.get", params: { id: requirePositional(positionals, "<taskId>") } }
    throw new CliError(`unknown task command: ${verb}`)
  }

  throw new CliError(`unknown multiman command: ${noun}`)
}

function emit(value: unknown, pretty: boolean): void {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  process.stdout.write(`${text}\n`)
}

function fail(message: string, exitCode = 1): never {
  process.stderr.write(`${JSON.stringify({ error: { message } })}\n`)
  process.exit(exitCode)
}

export async function runMultimanSubcommand(argv: readonly string[]): Promise<void> {
  const [noun, verb, ...rest] = argv
  if (!noun || noun === "--help" || noun === "-h" || noun === "help") {
    process.stdout.write(`${MULTIMAN_USAGE}\n`)
    return
  }

  // `runner` is the long-running autonomous role-runner, not a one-shot RPC —
  // it owns its own daemon lifetime + subscription, so it bypasses the thin
  // request/emit/close path below entirely.
  if (noun === "runner") {
    const { runMultimanRunner } = await import("./multiman-runner-cmd.ts")
    await runMultimanRunner(verb === undefined ? rest : [verb, ...rest])
    return
  }

  let parsed: ParsedArgs
  try {
    parsed = parseArgs(rest)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 2)
  }

  if (parsed.help) {
    process.stdout.write(`${MULTIMAN_USAGE}\n`)
    return
  }

  let rpc: { method: string; params: Record<string, unknown> }
  try {
    if (!verb) throw new CliError(`"${noun}" needs a sub-command`)
    rpc = toRpc(noun, verb, parsed)
  } catch (err) {
    if (err instanceof CliError) fail(`${err.message}\n\n${MULTIMAN_USAGE}`, 2)
    fail(err instanceof Error ? err.message : String(err), 2)
  }

  let client: KobeDaemonClient
  try {
    client = await connectOrStartDaemon()
  } catch (err) {
    fail(`could not reach or start the kobe daemon: ${err instanceof Error ? err.message : String(err)}`, 2)
  }

  try {
    const result = await client.request("multiman", rpc)
    emit(result, parsed.pretty)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 1)
  } finally {
    client.close()
  }
}
