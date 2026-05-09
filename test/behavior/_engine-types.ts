/**
 * Local mirror of the `AIEngine` interface from DESIGN.md §5.2.
 *
 * MUST match `src/types/engine.ts` after Stream 0.3 lands and we merge
 * worktree branches. The drift policy:
 *
 *   - At G0 merge time, this file is replaced by re-exports from
 *     `src/types/engine.ts` (keep the file as a thin shim so existing
 *     imports keep working).
 *   - If the merged shape differs from this file, `FakeAIEngine` is
 *     updated to satisfy the canonical interface.
 *   - Behavior tests should import from `./_engine-types` so the
 *     migration is a single-file edit.
 *
 * This pattern (Wave-N stream defines the interface, Stream 0.4
 * mirrors it locally so we can ship at G0) is documented in PLAN.md
 * §0.4 — option (a).
 */

export interface SessionHandle {
  /** Claude Code's session UUID. Set after the session-init event. */
  sessionId: string | null
  /** Working directory the session was spawned in. */
  cwd: string
}

export interface SpawnOpts {
  /** Optional model override (e.g. `"claude-opus-4-7"`). */
  model?: string
  /** Optional resume flag (subprocess uses `claude --resume <id>`). */
  resumeId?: string
  /** Forwarded to child process env. */
  env?: Record<string, string>
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool"
  content: string
  /** ISO timestamp from the JSONL line. */
  ts: string
}

export type EngineEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "tool.start"; name: string; input: unknown }
  | { type: "tool.result"; name: string; output: unknown }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "done" }
  | { type: "error"; message: string }

export interface AIEngine {
  /** Start a fresh session in `cwd` with `prompt` as the first user turn. */
  spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle>

  /** Resume an existing session and send a follow-up prompt. */
  resume(sessionId: string, prompt: string): Promise<SessionHandle>

  /** Stream events from a live session in arrival order. */
  stream(handle: SessionHandle): AsyncIterable<EngineEvent>

  /** Read historical messages from disk for a session. */
  readHistory(sessionId: string): Promise<Message[]>

  /** Stop a running session (SIGTERM, then SIGKILL after grace). */
  stop(handle: SessionHandle): Promise<void>
}
