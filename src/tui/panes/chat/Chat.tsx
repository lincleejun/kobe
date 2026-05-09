/**
 * Wave 3 Stream G — chat pane.
 *
 * Replaces the throwaway `panes/chat-placeholder/Chat.tsx`. Owns the
 * entire chat surface for one selected task: header, message list,
 * loading indicator, streaming cursor, tool-call rendering, composer.
 *
 * State model — the {@link ChatState} from `./store.ts`. Two arrays
 * (past, live), one boolean (isStreaming), no separate loading flag,
 * no in-flight buffer. See store.ts top-of-file for the full rationale
 * and the pivot history.
 *
 * Lifecycle inside this component:
 *
 *   - On `taskId()` change:
 *       1. Tear down the previous orchestrator subscription.
 *       2. Reset state (`createInitialState`).
 *       3. If the task has a `sessionId`, fire `engine.readHistory(sid)`
 *          and feed it to `setPast`. Brand-new tasks have no sessionId
 *          yet — render an empty list.
 *       4. Subscribe to new task's events; each event flows into
 *          `applyEvent`.
 *
 *   - On user submit:
 *       1. `pushDraftUser(state, prompt)` — sets `isStreaming: true`
 *          immediately so the loading indicator appears that frame.
 *       2. `orchestrator.runTask(taskId, prompt)`. On rejection:
 *          `pushSystemError(state, message)`.
 *
 *   - On `pendingPrompt` (from new-task dialog): auto-submit it once,
 *     once the matching task is selected. The accessor is checked once
 *     per task switch; consumed via `onPendingPromptConsumed` so it
 *     doesn't re-fire on resubscribe.
 *
 * What's intentionally minimal (per the brief's "within reason"):
 *
 *   - Tool calls render as a single line `▶ <name>(<one-line-input>)`
 *     followed by a one-line result preview when present. Press
 *     `enter` (when the chat composer is empty) to expand the most
 *     recent tool call. Full details (json input + full output) shown
 *     on expand. Wave 4 owns rich rendering (per-arg syntax, syntax-
 *     highlighted output blobs, etc.).
 *   - Composer is single-line. Multi-line is Wave 4 (`shift-enter` to
 *     split). For now `\n` typed at the prompt is filtered out by the
 *     opentui input renderable anyway.
 *   - History rendering is text-only: `role: "user"|"assistant"` rows
 *     with `string`-coerced content. Tool messages from history are
 *     skipped in v1 (they re-appear during the next live run if the
 *     user resumes; otherwise, Wave 4 polish handles them).
 *
 * What's load-bearing (must NOT regress):
 *
 *   - The "thinking" indicator must appear within one render frame of
 *     submit. The G3 behavior test asserts this.
 *   - Streaming text accumulates by appending each `assistant.delta`
 *     to the rolling render. We do NOT mutate; the renderer reads the
 *     `live` array end-to-end every frame.
 *   - Task switch tears down the prior subscription before subscribing
 *     to the new one (Solid `createEffect` returns the cleanup; we
 *     return the unsubscribe).
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { Orchestrator } from "../../../orchestrator/core.ts"
import type { EngineEvent } from "../../../types/engine.ts"
import { useTheme } from "../../context/theme"
import { Loading } from "./Loading"
import {
  type ChatRow,
  type ChatState,
  applyEvent,
  createInitialState,
  pushSystemError,
  pushUser,
  setMessagesFromHistory,
} from "./store"

export type ChatProps = {
  orchestrator: Orchestrator
  /**
   * Solid accessor for the currently selected task id. We accept an
   * accessor (not a static prop) so task switches re-run effects
   * without React-style rerender ceremony.
   */
  taskId: Accessor<string | undefined>
  /** Active task title for the header. */
  title?: Accessor<string | undefined>
  /**
   * Optional pending prompt to auto-submit on first selection of the
   * matching task. Used by the new-task flow: the user types the
   * first prompt in the dialog, and we submit it on their behalf the
   * moment the task lands in the index. Accessor returns undefined
   * when there's nothing to submit.
   */
  pendingPrompt?: Accessor<string | undefined>
  /**
   * Called once we've consumed `pendingPrompt`. The parent uses this
   * to clear its pending-prompt signal so a re-subscribe (e.g. the
   * task gets re-selected after a switch) doesn't re-submit.
   */
  onPendingPromptConsumed?: () => void
  /** Future: focus management when multiple panes share input. Unused in v1. */
  focused?: Accessor<boolean>
}

/**
 * Coerce an unknown content blob from `engine.readHistory` into a
 * single string for display. The on-disk JSONL stores `content` as
 * either a plain string or an array of content blocks. We render
 * just the textual blocks; tool blocks are skipped in v1 (they
 * re-render via live events on the next run if the user resumes).
 */
function coerceHistoryContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block)
      } else if (block && typeof block === "object") {
        const b = block as { type?: unknown; text?: unknown }
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
      }
    }
    return parts.join("")
  }
  return ""
}

/** One-line preview of a tool's input arg blob. */
function previewToolInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return collapseToOneLine(input, 60)
  try {
    return collapseToOneLine(JSON.stringify(input), 60)
  } catch {
    return "<unserializable>"
  }
}

function previewToolOutput(output: unknown): string {
  if (output == null) return ""
  if (typeof output === "string") return collapseToOneLine(output, 60)
  try {
    return collapseToOneLine(JSON.stringify(output), 60)
  } catch {
    return "<unserializable>"
  }
}

function collapseToOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…`
}

/**
 * Render a single chronological row from the unified `messages` array.
 * Tool rows are collapsed by default — `expanded` and `onToggle` thread
 * mouse + keyboard both into the same handler (kobe convention).
 */
function MessageRow(props: {
  row: ChatRow
  isLastAssistant: boolean
  isStreaming: boolean
  index: number
  expanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  if (props.row.kind === "user") {
    return (
      <box paddingTop={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          you
        </text>
        <text fg={theme.text}>{props.row.text}</text>
      </box>
    )
  }
  if (props.row.kind === "assistant") {
    return (
      <box paddingTop={1}>
        <text fg={theme.success} attributes={TextAttributes.BOLD}>
          assistant
        </text>
        <text fg={theme.text}>
          {props.row.text}
          {/* Streaming cursor on the last assistant row mid-turn. */}
          {props.isLastAssistant && props.isStreaming ? "▏" : ""}
        </text>
      </box>
    )
  }
  if (props.row.kind === "system") {
    return (
      <box paddingTop={1}>
        <text fg={theme.error} attributes={TextAttributes.BOLD}>
          system
        </text>
        <text fg={theme.textMuted}>{props.row.text}</text>
      </box>
    )
  }
  // Tool row.
  const r = props.row
  const status = r.done ? "done" : "running"
  const arrow = props.expanded ? "▼" : "▶"
  return (
    <box paddingTop={1}>
      <text fg={theme.textMuted} onMouseUp={() => props.onToggle()}>
        {arrow} {r.name}({previewToolInput(r.input)}) — {status}
      </text>
      <Show when={props.expanded}>
        <box paddingLeft={2} paddingTop={0}>
          <text fg={theme.textMuted}>input:</text>
          <text fg={theme.text}>{safeStringify(r.input)}</text>
          <Show when={r.done}>
            <text fg={theme.textMuted}>output:</text>
            <text fg={theme.text}>{safeStringify(r.output)}</text>
          </Show>
        </box>
      </Show>
      <Show when={!props.expanded && r.done}>
        <text fg={theme.textMuted} onMouseUp={() => props.onToggle()}>
          {" "}
          {previewToolOutput(r.output)}
        </text>
      </Show>
    </box>
  )
}

function safeStringify(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function Chat(props: ChatProps) {
  const { theme } = useTheme()

  // The whole chat state lives in one signal. Solid's structural sharing
  // makes whole-state updates cheap; we don't bother with finer-grained
  // signals because the chat is small and the re-render cost is low.
  const [state, setState] = createSignal<ChatState>(createInitialState())
  const [draft, setDraft] = createSignal("")
  const [expandedToolIndex, setExpandedToolIndex] = createSignal<number | null>(null)

  // (Re)subscribe + reload history on task change. Solid's `on` makes
  // the dep explicit so we don't re-run on every signal access in the
  // body.
  createEffect(
    on(
      () => props.taskId(),
      (taskId, _prev, prevCleanup?: () => void) => {
        prevCleanup?.()
        // Fresh state for the new task; the in-progress turn (if any)
        // for the prior task is GC'd along with the prior subscription.
        setState(createInitialState())
        setDraft("")
        setExpandedToolIndex(null)
        if (!taskId) return undefined

        // Subscribe live events. Each event mutates the unified
        // `messages` array (user submits append directly, assistant
        // deltas append/coalesce, tool starts/results pair by name).
        // No re-read on done — the messages array IS the chronological
        // record while the session is live.
        const unsubscribe = props.orchestrator.subscribeEvents(taskId, (ev: EngineEvent) => {
          setState((s) => applyEvent(s, ev))
        })

        // Load history if the task already has a sessionId. Brand-new
        // tasks (just created via `n`) won't yet — that's fine, the
        // `live` events from the first run will populate the chat.
        const task = props.orchestrator.getTask(taskId)
        const sessionId = task?.sessionId ?? null
        if (sessionId) {
          props.orchestrator
            .readHistory(sessionId)
            .then((past) => {
              // Only apply if we haven't switched tasks since.
              if (props.taskId() !== taskId) return
              setState((s) => setMessagesFromHistory(s, past))
            })
            .catch((err) => {
              setState((s) => pushSystemError(s, `history load failed: ${stringifyErr(err)}`))
            })
        }

        return unsubscribe
      },
    ),
  )

  // Pending-prompt watcher: separate from the task-switch effect
  // because the orchestrator's auto-select-first-task logic in app.tsx
  // can fire `setSelectedId` BEFORE the parent has staged the
  // pending prompt. Watching the prompt accessor in its own effect
  // means we react when EITHER the task or the prompt changes —
  // whichever comes second triggers the auto-submit.
  createEffect(() => {
    const pp = props.pendingPrompt?.()
    const taskId = props.taskId()
    if (!pp || !taskId) return
    if (pp.length === 0) return
    if (state().isStreaming) return
    // Consume immediately so a re-run (signal flicker, parent
    // re-mount) doesn't double-submit.
    props.onPendingPromptConsumed?.()
    queueMicrotask(() => {
      void send(pp)
    })
  })

  // Final unmount tidy-up — Solid runs the createEffect cleanup chain
  // for us, but a defensive reset is cheap.
  onCleanup(() => {
    setState(createInitialState())
  })

  /**
   * Submit a prompt. Pulls the active taskId from the accessor so this
   * is safe to call from the auto-pending-prompt path AND the
   * composer's onSubmit handler.
   */
  async function send(promptText?: string): Promise<void> {
    const text = (promptText ?? draft()).trim()
    const taskId = props.taskId()
    if (!text || !taskId) return
    if (state().isStreaming) {
      // Don't queue — keeping the model simple. We could buffer here
      // later if multi-turn rapid-fire becomes a real workflow.
      return
    }
    setDraft("")
    setState((s) => pushUser(s, text))
    try {
      await props.orchestrator.runTask(taskId, text)
    } catch (err) {
      setState((s) => pushSystemError(s, `runTask failed: ${stringifyErr(err)}`))
    }
  }

  // Render-derived: index of the trailing assistant row (anchor for the
  // streaming cursor) and trailing tool row (anchor for "enter expands").
  const lastAssistantIdx = createMemo(() => {
    const msgs = state().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const r = msgs[i]
      if (r && r.kind === "assistant") return i
    }
    return -1
  })

  const showThinking = createMemo(() => {
    if (!state().isStreaming) return false
    // Spinner only when no assistant text yet — once text streams in,
    // the cursor takes over and the spinner gets out of the way.
    return lastAssistantIdx() === -1
  })

  const lastToolIndex = createMemo(() => {
    const msgs = state().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const r = msgs[i]
      if (r && r.kind === "tool") return i
    }
    return null
  })

  function toggleExpandLastTool(): void {
    const idx = lastToolIndex()
    if (idx == null) return
    setExpandedToolIndex((cur) => (cur === idx ? null : idx))
  }

  // Per-row toggler — used by both the click-on-tool-row handler and
  // the keyboard "enter on empty composer" path (which targets the
  // most recent tool row). Both eventually flow through this so the
  // expand/collapse model stays single-sourced.
  function toggleExpand(rowIndex: number): void {
    setExpandedToolIndex((cur) => (cur === rowIndex ? null : rowIndex))
  }

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box paddingTop={1} paddingBottom={1} flexShrink={0} flexDirection="row" gap={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          chat
        </text>
        <Show when={props.title?.()}>
          <text fg={theme.textMuted}>—</text>
          <text fg={theme.text}>{props.title?.()}</text>
        </Show>
      </box>

      {/* Empty state for "no task selected". */}
      <Show when={!props.taskId()}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>Select a task or press n to create one.</text>
        </box>
      </Show>

      {/* Message list. */}
      <Show when={props.taskId()}>
        <scrollbox
          flexGrow={1}
          stickyScroll={true}
          stickyStart="bottom"
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
          }}
        >
          <box paddingRight={1} gap={0}>
            {/* Empty placeholder when we have nothing to show. */}
            <Show when={state().messages.length === 0}>
              <box paddingTop={2}>
                <text fg={theme.textMuted}>Type a prompt below.</text>
              </box>
            </Show>

            {/* Single chronological list — user, assistant, tool, system
                rows in arrival order. */}
            <For each={state().messages}>
              {(row, i) => (
                <MessageRow
                  row={row}
                  index={i()}
                  isLastAssistant={i() === lastAssistantIdx()}
                  isStreaming={state().isStreaming}
                  expanded={row.kind === "tool" && expandedToolIndex() === i()}
                  onToggle={() => toggleExpand(i())}
                />
              )}
            </For>

            {/* Loading spinner while we're waiting for the first token. */}
            <Show when={showThinking()}>
              <Loading />
            </Show>

            {/* Error banner. */}
            <Show when={state().error}>
              <box paddingTop={1}>
                <text fg={theme.error}>error: {state().error}</text>
              </box>
            </Show>
          </box>
        </scrollbox>
      </Show>

      {/* Composer. */}
      <box flexShrink={0} paddingTop={1} flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{state().isStreaming ? "…" : ">"}</text>
        <box flexGrow={1}>
          <Show
            when={props.taskId() !== undefined}
            fallback={<text fg={theme.textMuted}>(no task — press n to create)</text>}
          >
            <input
              value={draft()}
              placeholder={state().isStreaming ? "(streaming — wait for done)" : "Ask Claude…"}
              focused={true}
              onInput={(v: string) => setDraft(v)}
              onSubmit={() => {
                // Composer enter behavior:
                //  - If draft is empty AND there's a tool row, toggle
                //    its expansion (matches the brief: "press enter to
                //    expand" without stealing keystrokes mid-typing).
                //  - Otherwise, send the prompt.
                if (draft().trim().length === 0 && lastToolIndex() !== null) {
                  toggleExpandLastTool()
                  return
                }
                void send()
              }}
            />
          </Show>
        </box>
      </box>
    </box>
  )
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
