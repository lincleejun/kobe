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

/** Asset kinds accepted by `asset create` (validated client-side; kernel is SoT). */
const ASSET_KINDS = ["skill", "mcp"] as const

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
  "  role attach <roleId> --asset <assetId>",
  "  role detach <roleId> --asset <assetId>",
  "  role assets <roleId>",
  "  asset create --kind <skill|mcp> --name <n> [--spec <json>] [--version <v>]",
  "  asset list [--kind <skill|mcp>]",
  "  task create --title <t> [--role <id>] [--repo <path>] [--priority <n>]",
  "  task list [--status <s>]",
  "  task assign <taskId> --role <id>",
  "  task claim --role <id>",
  "  task transition <taskId> --to <status>",
  "  task get <taskId>",
  "  inbox push --source <s> --kind <k> [--payload <json>] [--severity <action|attention|info>]",
  "  inbox list [--status <new|claimed|processed|archived>]",
  "  inbox claim --consumer <id>",
  "  inbox mark <itemId> --status <new|claimed|processed|archived>",
  "  schedule create --name <n> --trigger <cron|manual> [--cron <expr>] --target-kind <role|workflow> --target-ref <ref> [--mode <collect|run_only>] [--concurrency <skip|queue|replace>]",
  "  schedule list [--enabled]",
  "  schedule enable <id> --enabled <true|false>",
  "  schedule run-now <id>",
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
    // `--enabled` is the one optional-value flag: a bare `--enabled` (used by
    // `schedule list --enabled`) means true; `--enabled true|false` still works.
    if (key === "enabled" && (next === undefined || next.startsWith("--"))) {
      flags.set(key, "true")
      continue
    }
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

/** Parse a required boolean flag (`true`/`false`, also `1`/`0`). */
function requiredBool(flags: Flags, key: string): boolean {
  const v = required(flags, key)
  if (v === "true" || v === "1") return true
  if (v === "false" || v === "0") return false
  throw new CliError(`--${key} must be true or false`)
}

/** Validate a flag value against an allowed set, when present. */
function optionalEnum<T extends string>(flags: Flags, key: string, allowed: readonly T[]): T | undefined {
  const v = optional(flags, key)
  if (v === undefined) return undefined
  if (!allowed.includes(v as T)) throw new CliError(`--${key} must be one of ${allowed.join(", ")}`)
  return v as T
}

const INBOX_SEVERITIES = ["action", "attention", "info"] as const
const INBOX_STATUSES = ["new", "claimed", "processed", "archived"] as const
const SCHEDULE_TRIGGERS = ["cron", "manual"] as const
const SCHEDULE_TARGET_KINDS = ["role", "workflow"] as const
const SCHEDULE_MODES = ["collect", "run_only"] as const
const SCHEDULE_CONCURRENCY = ["skip", "queue", "replace"] as const

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
    if (verb === "attach") {
      const id = requirePositional(positionals, "<roleId>")
      return { method: "asset.attach", params: { roleId: id, assetId: required(flags, "asset") } }
    }
    if (verb === "detach") {
      const id = requirePositional(positionals, "<roleId>")
      return { method: "asset.detach", params: { roleId: id, assetId: required(flags, "asset") } }
    }
    if (verb === "assets") {
      return { method: "role.assets", params: { roleId: requirePositional(positionals, "<roleId>") } }
    }
    throw new CliError(`unknown role command: ${verb}`)
  }

  if (noun === "asset") {
    if (verb === "create") {
      const kind = optionalEnum(flags, "kind", ASSET_KINDS)
      if (kind === undefined) throw new CliError(`--kind must be one of ${ASSET_KINDS.join(", ")}`)
      const specRaw = optional(flags, "spec")
      // Validate JSON client-side for a clean error; pass through as a string
      // (the kernel accepts a JSON string or an object).
      if (specRaw !== undefined) {
        try {
          JSON.parse(specRaw)
        } catch {
          throw new CliError("--spec must be valid JSON")
        }
      }
      return {
        method: "asset.create",
        params: compact({
          kind,
          name: required(flags, "name"),
          spec: specRaw,
          version: optional(flags, "version"),
        }),
      }
    }
    if (verb === "list")
      return { method: "asset.list", params: compact({ kind: optionalEnum(flags, "kind", ASSET_KINDS) }) }
    throw new CliError(`unknown asset command: ${verb}`)
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

  if (noun === "inbox") {
    if (verb === "push") {
      return {
        method: "inbox.push",
        params: compact({
          source: required(flags, "source"),
          kind: required(flags, "kind"),
          payload: optional(flags, "payload"),
          severity: optionalEnum(flags, "severity", INBOX_SEVERITIES),
        }),
      }
    }
    if (verb === "list") {
      return { method: "inbox.list", params: compact({ status: optionalEnum(flags, "status", INBOX_STATUSES) }) }
    }
    if (verb === "claim") return { method: "inbox.claim", params: { consumer: required(flags, "consumer") } }
    if (verb === "mark") {
      const id = requirePositional(positionals, "<itemId>")
      const status = optionalEnum(flags, "status", INBOX_STATUSES)
      if (status === undefined) throw new CliError(`--status must be one of ${INBOX_STATUSES.join(", ")}`)
      return { method: "inbox.mark", params: { id, status } }
    }
    throw new CliError(`unknown inbox command: ${verb}`)
  }

  if (noun === "schedule") {
    if (verb === "create") {
      const trigger = optionalEnum(flags, "trigger", SCHEDULE_TRIGGERS)
      if (trigger === undefined) throw new CliError(`--trigger must be one of ${SCHEDULE_TRIGGERS.join(", ")}`)
      if (trigger === "cron" && optional(flags, "cron") === undefined) {
        throw new CliError("--cron is required when --trigger is cron")
      }
      const targetKind = optionalEnum(flags, "target-kind", SCHEDULE_TARGET_KINDS)
      if (targetKind === undefined)
        throw new CliError(`--target-kind must be one of ${SCHEDULE_TARGET_KINDS.join(", ")}`)
      return {
        method: "schedule.create",
        params: compact({
          name: required(flags, "name"),
          triggerKind: trigger,
          cronExpr: optional(flags, "cron"),
          targetKind,
          targetRef: required(flags, "target-ref"),
          executionMode: optionalEnum(flags, "mode", SCHEDULE_MODES),
          concurrencyPolicy: optionalEnum(flags, "concurrency", SCHEDULE_CONCURRENCY),
        }),
      }
    }
    if (verb === "list") {
      // `--enabled` present → filter; bare or `--enabled true|false` both parse.
      const enabled = flags.has("enabled") ? requiredBool(flags, "enabled") : undefined
      return { method: "schedule.list", params: compact({ enabled }) }
    }
    if (verb === "enable") {
      const id = requirePositional(positionals, "<id>")
      return { method: "schedule.enable", params: { id, enabled: requiredBool(flags, "enabled") } }
    }
    if (verb === "run-now") {
      return { method: "schedule.runNow", params: { id: requirePositional(positionals, "<id>") } }
    }
    throw new CliError(`unknown schedule command: ${verb}`)
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
