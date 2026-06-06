/**
 * Multiman kanban board (KOB).
 *
 * A Linear-style five-column board over the live multiman kernel task list,
 * mounted full-width at the TOP of the outer monitor (above the sidebar /
 * workspace row). PASSIVE by design — it registers no keybindings and no
 * focus, so it never competes with the sidebar/workspace focus model. It is
 * a read-only mirror of `task.list`, re-fetched (debounced) by the
 * RemoteOrchestrator on every `multiman` kernel event.
 *
 * Columns map multiman's nine task statuses onto five Linear-style lanes:
 *
 *   Backlog      ← pending, blocked
 *   Todo         ← assigned, claimed
 *   In Progress  ← running
 *   In Review    ← in_review
 *   Done         ← done, failed, cancelled
 *
 * Each card shows a short id, the title, an optional body excerpt, and a
 * footer row with a priority badge + the assignee (resolved from `role_id`
 * against the live role list) and an `mr` marker when the task carries an
 * `mr_url`. Grouping is memoised so it only recomputes when `tasks()` change.
 */

import { TextAttributes } from "@opentui/core"
import type { Role as MultimanRole, Task as MultimanTask } from "@sma1lboy/multiman/types"
import { type Accessor, For, Show, createMemo } from "solid-js"
import { useTheme } from "../../context/theme"

export type MultimanBoardProps = {
  tasks: Accessor<MultimanTask[]>
  roles: Accessor<MultimanRole[]>
}

/** A board column: its display name, the kernel statuses it collects, and a
 *  theme-token name for its header accent (resolved at render time so the
 *  column stays reactive to theme switches). */
type ColumnTone = "textMuted" | "info" | "warning" | "primary" | "success"
type ColumnDef = {
  readonly key: string
  readonly name: string
  readonly statuses: readonly MultimanTask["status"][]
  readonly tone: ColumnTone
}

const COLUMNS: readonly ColumnDef[] = [
  { key: "backlog", name: "Backlog", statuses: ["pending", "blocked"], tone: "textMuted" },
  { key: "todo", name: "Todo", statuses: ["assigned", "claimed"], tone: "info" },
  { key: "in_progress", name: "In Progress", statuses: ["running"], tone: "warning" },
  { key: "in_review", name: "In Review", statuses: ["in_review"], tone: "primary" },
  { key: "done", name: "Done", statuses: ["done", "failed", "cancelled"], tone: "success" },
]

/** Integer priority → label + tone. Mirrors Linear's priority ramp. */
function priorityMeta(priority: number): { label: string; tone: ColumnTone | "error" } {
  if (priority <= 0) return { label: "No priority", tone: "textMuted" }
  if (priority === 1) return { label: "Low", tone: "info" }
  if (priority === 2) return { label: "Medium", tone: "warning" }
  if (priority === 3) return { label: "High", tone: "warning" }
  return { label: "Urgent", tone: "error" }
}

/** Last 6 chars of an id, for a compact human-scannable card label. */
function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(id.length - 6)
}

/** Single-line truncation with a trailing ellipsis when clipped. */
function truncate(s: string, max: number): string {
  if (max <= 0) return ""
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

/** Collapse whitespace/newlines so a body excerpt stays on one line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

export function MultimanBoard(props: MultimanBoardProps) {
  const { theme } = useTheme()

  const toneColor = (tone: ColumnTone | "error") => {
    switch (tone) {
      case "info":
        return theme.info
      case "warning":
        return theme.warning
      case "primary":
        return theme.primary
      case "success":
        return theme.success
      case "error":
        return theme.error
      default:
        return theme.textMuted
    }
  }

  // Map role_id → role name once per role-list change, so each card is an O(1)
  // lookup rather than a linear scan over roles().
  const roleNames = createMemo(() => {
    const map = new Map<string, string>()
    for (const r of props.roles()) map.set(r.id, r.name)
    return map
  })

  // Group tasks into the five columns. Recomputes only when tasks() changes.
  const grouped = createMemo(() => {
    const buckets = new Map<string, MultimanTask[]>()
    for (const col of COLUMNS) buckets.set(col.key, [])
    for (const task of props.tasks()) {
      const col = COLUMNS.find((c) => c.statuses.includes(task.status))
      if (col) buckets.get(col.key)?.push(task)
    }
    return buckets
  })

  const total = createMemo(() => props.tasks().length)

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      {/* Board title row — section-header grammar (BOLD label + dim count). */}
      <box flexDirection="row" gap={1} paddingBottom={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          multiman board
        </text>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
          {total()} task{total() === 1 ? "" : "s"}
        </text>
      </box>

      {/* Columns: equal-width, side by side. */}
      <box flexDirection="row" gap={1} flexGrow={1}>
        <For each={COLUMNS}>
          {(col) => {
            const cards = () => grouped().get(col.key) ?? []
            const accent = toneColor(col.tone)
            return (
              <box flexDirection="column" flexGrow={1} flexBasis={0}>
                {/* Column header: dot + name + count, colored per column. */}
                <box flexDirection="row" gap={1} paddingBottom={1}>
                  <text fg={accent} wrapMode="none">
                    ●
                  </text>
                  <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
                    {col.name}
                  </text>
                  <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                    {cards().length}
                  </text>
                </box>

                {/* Column body: scrollable card stack. */}
                <scrollbox flexGrow={1} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}>
                  <box flexDirection="column" gap={1}>
                    <For each={cards()}>
                      {(task) => {
                        const prio = priorityMeta(task.priority)
                        const assignee = () => (task.role_id ? (roleNames().get(task.role_id) ?? task.role_id) : "—")
                        return (
                          <box
                            flexDirection="column"
                            border
                            borderColor={theme.borderSubtle}
                            paddingLeft={1}
                            paddingRight={1}
                          >
                            <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                              {shortId(task.id)}
                            </text>
                            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                              {truncate(task.title, 22)}
                            </text>
                            <Show when={task.body && task.body.trim().length > 0}>
                              <text fg={theme.textMuted} wrapMode="none">
                                {truncate(oneLine(task.body), 22)}
                              </text>
                            </Show>
                            <box flexDirection="row" gap={1}>
                              <text fg={toneColor(prio.tone)} wrapMode="none">
                                {prio.label}
                              </text>
                              <text fg={theme.textMuted} wrapMode="none" flexGrow={1}>
                                {truncate(assignee(), 12)}
                              </text>
                              <Show when={task.mr_url}>
                                <text fg={theme.info} wrapMode="none">
                                  mr
                                </text>
                              </Show>
                            </box>
                          </box>
                        )
                      }}
                    </For>
                    <Show when={cards().length === 0}>
                      <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                        —
                      </text>
                    </Show>
                  </box>
                </scrollbox>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}
