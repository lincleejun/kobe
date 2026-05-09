/**
 * Wave 4 chat split — composer (input row) of the chat pane.
 *
 * Owns: the prompt prefix glyph (`>` / `…`), the input renderable, the
 * placeholder text, and the no-task fallback. Stateless beyond the
 * incoming `draft` accessor — does NOT manage history, multi-line
 * buffers, or paste handling yet. Wave 4 stream W4.C will extend this
 * file with multi-line, prompt history, and paste handling.
 *
 * Submit semantics live in the caller:
 *   - The composer always passes the *current trimmed text* to
 *     `onSubmit`. An empty string means "user hit enter on an empty
 *     composer" — the caller decides what to do (currently {@link Chat}
 *     toggles the most recent tool row's expansion).
 *   - The composer does NOT clear the draft itself; the caller does
 *     that on a successful send. Keeping the controlled-input pattern
 *     means the parent stays the source of truth.
 */

import { Show } from "solid-js"
import { useTheme } from "../../context/theme"

export interface ComposerProps {
  /** Current draft text. Controlled by the parent. */
  draft: string
  /** Called on every keystroke. Parent persists the new value. */
  onDraftChange: (value: string) => void
  /** True between user submit and `done`/`error`. Drives prefix + placeholder. */
  isStreaming: boolean
  /** True when a task is selected. False renders the no-task fallback. */
  hasTask: boolean
  /** Called on enter with the trimmed text. Empty string = empty-composer enter. */
  onSubmit: (trimmedText: string) => void
}

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()
  return (
    <box flexShrink={0} paddingTop={1} flexDirection="row" gap={1}>
      <text fg={theme.textMuted}>{props.isStreaming ? "…" : ">"}</text>
      <box flexGrow={1}>
        <Show when={props.hasTask} fallback={<text fg={theme.textMuted}>(no task — press n to create)</text>}>
          <input
            value={props.draft}
            placeholder={props.isStreaming ? "(streaming — wait for done)" : "Ask Claude…"}
            focused={true}
            onInput={(v: string) => props.onDraftChange(v)}
            onSubmit={() => props.onSubmit(props.draft.trim())}
          />
        </Show>
      </box>
    </box>
  )
}
