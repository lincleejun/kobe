/**
 * `DevAIEngine` — auto-replying fake engine for `bun run dev:test`.
 *
 * Wraps the behavior-test {@link FakeAIEngine} (which is otherwise
 * driven by an HTTP side-channel from the test driver) and front-runs
 * every `spawn`/`resume` with a canned script of EngineEvents so the
 * chat composer actually returns *something* in the dev TUI without a
 * real `claude` binary in the loop.
 *
 * Lives in `src/engine/` (not `test/`) because it's a product affordance
 * for development, not a test fixture. The behavior-test FakeAIEngine
 * is still imported as the underlying queue/iterator implementation —
 * no point reimplementing the queue/waiter plumbing.
 *
 * Sequencing: events fire on a 30ms tick so the user can watch the
 * stream render incrementally instead of seeing the full reply slam in
 * on a single frame. Tweakable via the optional constructor arg.
 */

import type {
  AIEngine,
  EngineEvent,
  Message,
  SessionHandle,
  SpawnOpts,
} from "../types/engine.ts"
import { FakeAIEngine } from "../../test/behavior/fake-engine.ts"

export interface DevAIEngineOpts {
  /** Delay between successive scripted events. Defaults to 30ms. */
  readonly tickMs?: number
}

export class DevAIEngine implements AIEngine {
  private readonly inner = new FakeAIEngine()
  private readonly tickMs: number

  constructor(opts: DevAIEngineOpts = {}) {
    this.tickMs = opts.tickMs ?? 30
  }

  async spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    const handle = await this.inner.spawn(cwd, prompt, opts)
    this.scheduleCannedReply(handle.sessionId, prompt, opts)
    return handle
  }

  async resume(sessionId: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    const handle = await this.inner.resume(sessionId, prompt, opts)
    this.scheduleCannedReply(handle.sessionId, prompt, opts)
    return handle
  }

  stream(handle: SessionHandle): AsyncIterable<EngineEvent> {
    return this.inner.stream(handle)
  }

  async readHistory(sessionId: string): Promise<Message[]> {
    return this.inner.readHistory(sessionId)
  }

  async deleteHistory(sessionId: string): Promise<void> {
    return this.inner.deleteHistory(sessionId)
  }

  async stop(handle: SessionHandle): Promise<void> {
    return this.inner.stop(handle)
  }

  /**
   * Pump a canned reply onto the scripted queue. Echoes the user's
   * prompt back inside the assistant text so the dev can see the
   * round-trip happened, then a fake usage record + done. Permission
   * mode `plan` triggers a synthetic plan-mode reply (markdown
   * outline) so the approve-plan widget appears.
   */
  private scheduleCannedReply(sessionId: string, prompt: string, opts: SpawnOpts | undefined): void {
    const planMode = opts?.permissionMode === "plan"
    const events: EngineEvent[] = planMode
      ? buildPlanModeReply(prompt)
      : buildAssistantReply(prompt)

    let i = 0
    const tick = () => {
      const ev = events[i++]
      if (!ev) return
      this.inner.script(sessionId, [ev])
      if (i < events.length) setTimeout(tick, this.tickMs)
    }
    setTimeout(tick, this.tickMs)
  }
}

function buildAssistantReply(prompt: string): EngineEvent[] {
  const trimmed = prompt.trim().slice(0, 120)
  const echo = trimmed.length === 0 ? "(empty prompt)" : trimmed
  const chunks = [
    "Got it — ",
    "I read your prompt as: ",
    `“${echo}”.\n\n`,
    "This is a `dev:test` mock response. ",
    "No real Claude was invoked.\n\n",
    "- The fake engine emits a handful of streamed deltas\n",
    "- Then a usage frame\n",
    "- Then a `done` so the composer unlocks.\n",
  ]
  const events: EngineEvent[] = chunks.map((text) => ({ type: "assistant.delta", text }))
  events.push({ type: "usage", input_tokens: 42, output_tokens: 87 })
  events.push({ type: "done" })
  return events
}

function buildPlanModeReply(prompt: string): EngineEvent[] {
  const echo = prompt.trim().slice(0, 80) || "(empty prompt)"
  // Synthesise an ExitPlanMode tool call so the chat pane renders the
  // approve-plan widget. The orchestrator promotes any `tool.start`
  // named `ExitPlanMode` into a user-input request.
  return [
    { type: "assistant.delta", text: "Plan mode mock — drafting an outline.\n" },
    {
      type: "tool.start",
      name: "ExitPlanMode",
      input: {
        plan: `# Plan for: ${echo}\n\n1. Inspect the relevant files\n2. Sketch the change\n3. Apply it\n4. Verify with the test suite\n`,
      },
    },
    { type: "tool.result", name: "ExitPlanMode", output: { ok: true } },
    { type: "usage", input_tokens: 50, output_tokens: 60 },
    { type: "done" },
  ]
}
