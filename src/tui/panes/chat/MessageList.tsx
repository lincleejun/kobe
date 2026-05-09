/**
 * Wave 4 chat split — render-side of the chat pane.
 *
 * Owns: the chronological message list, the per-row renderer, the
 * "thinking" spinner placement, the error banner, and the empty-state
 * placeholder. Stateless — receives `messages`, `isStreaming`,
 * `expandedToolIndex`, etc. as props from {@link Chat}.
 *
 * Why split: `Chat.tsx` previously held both the render and the
 * composer in one ~500-line file, which created merge conflicts when
 * Wave-4 streams (chat-render parity vs. composer optimization) ran in
 * parallel. The split lets each stream own its own file.
 *
 * What's load-bearing in this file (from Wave 3 G3):
 *   - The streaming cursor "▏" must trail the LAST assistant row
 *     while `isStreaming` is true.
 *   - Tool rows render as a single line `▶ <name>(<input>) — <status>`
 *     by default and expand on toggle.
 *   - The "thinking" spinner only renders when streaming AND there is
 *     no assistant text yet (caller computes via `showThinking`).
 *
 * Wave 4 stream W4.B will re-style this file (markdown rendering, tool
 * banner shape, thinking dots animation). Don't add composer logic here.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Loading } from "./Loading"
import type { ChatRow } from "./store"

export interface MessageListProps {
  messages: readonly ChatRow[]
  isStreaming: boolean
  /** Index of the last assistant row, or -1 if none. Anchors the streaming cursor. */
  lastAssistantIdx: number
  /** Currently expanded tool row index, or null. */
  expandedToolIndex: number | null
  /** Toggle expansion for the row at the given index. */
  onToggleTool: (rowIndex: number) => void
  /** True when we're streaming AND no assistant text has arrived yet. */
  showThinking: boolean
  /** Transient error banner text. Null when no error. */
  error: string | null
}

export function MessageList(props: MessageListProps) {
  const { theme } = useTheme()
  return (
    <box paddingRight={1} gap={0}>
      {/* Empty placeholder when we have nothing to show. */}
      <Show when={props.messages.length === 0}>
        <box paddingTop={2}>
          <text fg={theme.textMuted}>Type a prompt below.</text>
        </box>
      </Show>

      {/* Single chronological list — user, assistant, tool, system rows in arrival order. */}
      <For each={props.messages}>
        {(row, i) => (
          <MessageRow
            row={row}
            index={i()}
            isLastAssistant={i() === props.lastAssistantIdx}
            isStreaming={props.isStreaming}
            expanded={row.kind === "tool" && props.expandedToolIndex === i()}
            onToggle={() => props.onToggleTool(i())}
          />
        )}
      </For>

      {/* Loading spinner while we're waiting for the first token. */}
      <Show when={props.showThinking}>
        <Loading />
      </Show>

      {/* Error banner. */}
      <Show when={props.error}>
        <box paddingTop={1}>
          <text fg={theme.error}>error: {props.error}</text>
        </box>
      </Show>
    </box>
  )
}

/**
 * Render a single chronological row from the unified `messages` array.
 * Tool rows are collapsed by default — `expanded` and `onToggle` thread
 * mouse + keyboard both into the same handler (kobe convention).
 */
export function MessageRow(props: {
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

/* --------------------------------------------------------------------- */
/*  Formatting helpers — exported so future Wave 4 work can reuse them.   */
/* --------------------------------------------------------------------- */

/** One-line preview of a tool's input arg blob. */
export function previewToolInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return collapseToOneLine(input, 60)
  try {
    return collapseToOneLine(JSON.stringify(input), 60)
  } catch {
    return "<unserializable>"
  }
}

export function previewToolOutput(output: unknown): string {
  if (output == null) return ""
  if (typeof output === "string") return collapseToOneLine(output, 60)
  try {
    return collapseToOneLine(JSON.stringify(output), 60)
  } catch {
    return "<unserializable>"
  }
}

export function collapseToOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…`
}

export function safeStringify(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
