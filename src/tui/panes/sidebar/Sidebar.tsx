/**
 * kobe sidebar pane (Stream F).
 *
 * Renders the status-grouped task list inside a 42-cell-wide column,
 * matching the lifted opencode sidebar primitive (`src/tui/component/sidebar.tsx`)
 * shape. Layout matches Conductor's screenshot grammar (DESIGN.md §1):
 *
 *   kobe  v<version>
 *
 *   In progress  <n>
 *     <badge> task title
 *     <badge> task title
 *   In review    <n>
 *   Backlog      <n>
 *   Done         <n>
 *   Canceled     <n>
 *   Error        <n>
 *
 *   + Add repo
 *
 * Empty groups are still rendered with their count so the row layout is
 * stable as tasks transition between statuses (see groups.ts). Status
 * badges colour-code per status: ●green=done, ◐yellow=in_review,
 * ●blue=in_progress, ○muted=backlog, ✕red=error/canceled.
 *
 * On the layout primitive: the lifted `Sidebar` from
 * `src/tui/component/sidebar.tsx` exposes only an `entries: SidebarEntry[]`
 * API for its body — flat label+hint rows, no headers, no per-row colour
 * tokens. Status grouping doesn't fit that shape. We import the
 * `SIDEBAR_WIDTH` constant and replicate the outer-shell layout
 * (panel-coloured 42-cell box, header, scrollbox body, footer) here so
 * the primitive stays untouched (the brief forbids modifying Stream 0.2's
 * file). When the primitive grows a `children` slot — likely Wave 4
 * polish — we can switch to it without breaking this contract.
 *
 * Cursor / nav: a Solid signal `cursorIndex` indexes the *flat* navigable
 * task list (group headers are NOT navigable). j/k clamp inside the list,
 * `enter` invokes `props.onSelect`. The chord `g g` jumps to top, `G`
 * jumps to bottom — see `keys.ts` for the chord state machine. When
 * `props.selectedId` changes from outside (parent E sets it after a
 * task creation), we reflect that into the cursor; the cursor and the
 * selected id are kept loosely in sync — the cursor is "what you're
 * about to select", `selectedId` is "what's actually currently active".
 *
 * Reactivity: every prop is an `Accessor`. We never `.map()` arrays in
 * JSX — `For` is used so Solid keeps the row list reactive. The grouping
 * recomputes via `createMemo` only when the upstream `tasks` accessor
 * changes; cursor changes don't re-group.
 *
 * Focus: `props.focused` defaults to `() => true` because at G2 there's
 * only one focusable pane. Stream E's Wave 3 work will own focus
 * globally — when that lands, E threads the real signal through and the
 * default disappears.
 */

import type { Task, TaskStatus } from "@/types"
import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { SIDEBAR_WIDTH } from "../../component/sidebar"
import { useTheme } from "../../context/theme"
import { buildRows, flattenIds } from "./groups"
import { useSidebarBindings } from "./keys"

/**
 * Props for the sidebar pane. Lives in this file (not the barrel) to
 * keep `index.ts` a pure re-export with no inline type definitions —
 * the barrel imports from here, not the other way around, so no circular
 * dependency exists at module-init time.
 */
export type SidebarProps = {
  tasks: Accessor<readonly Task[]>
  selectedId: Accessor<string | null>
  onSelect: (id: string) => void
  focused?: Accessor<boolean>
}

/** Hardcoded version label shown next to "kobe" in the header. Bump on release. */
const KOBE_VERSION = "0.1.0"

/** Human-readable status group titles. Match Conductor's labels. */
const STATUS_LABEL: Record<TaskStatus, string> = {
  in_progress: "In progress",
  in_review: "In review",
  backlog: "Backlog",
  done: "Done",
  canceled: "Canceled",
  error: "Error",
}

/**
 * Glyph + theme-token name for each status's badge. We render the glyph
 * with the theme colour resolved at render time; storing the *tone* (not
 * the resolved RGBA) keeps badges reactive to theme switches.
 *
 * Token choice rationale:
 *   - `done` → success (green check)
 *   - `in_review` → warning (amber, awaits user)
 *   - `in_progress` → primary (themeful "active" colour)
 *   - `backlog` → textMuted (deferred)
 *   - `canceled` → textMuted (no longer relevant)
 *   - `error` → error (red)
 */
const STATUS_BADGE: Record<
  TaskStatus,
  { glyph: string; tone: "success" | "warning" | "primary" | "textMuted" | "error" }
> = {
  done: { glyph: "●", tone: "success" },
  in_review: { glyph: "◐", tone: "warning" },
  in_progress: { glyph: "●", tone: "primary" },
  backlog: { glyph: "○", tone: "textMuted" },
  canceled: { glyph: "✕", tone: "textMuted" },
  error: { glyph: "✕", tone: "error" },
}

// Row layout helpers (`buildRows`, `flattenIds`) live in `groups.ts` so
// they are testable without spinning up the renderer. They're imported
// at the top of this file.

export function Sidebar(props: SidebarProps) {
  const { theme } = useTheme()

  // Default `focused` accessor — see file header. Reading through this
  // shim makes "no focused prop passed" mean "always focused" without
  // re-creating a signal on every render.
  const focusedAccessor = () => (props.focused ? props.focused() : true)

  // Memoize the flat row list and the navigable id list. Solid will
  // re-run these only when `props.tasks()` changes — cursor moves don't
  // re-group, header expansion doesn't re-group.
  const rows = createMemo(() => buildRows(props.tasks()))
  const flatIds = createMemo(() => flattenIds(rows()))

  // Cursor index into `flatIds`. -1 when the list is empty. Synced from
  // `props.selectedId` on first render and whenever the parent changes
  // it from outside; keystroke movement updates the cursor locally and
  // we emit `onSelect` when the user presses enter (we do NOT emit
  // `onSelect` on every j/k press — that would be a different semantic;
  // the brief separates "cursor position" from "selection").
  const [cursorIndex, setCursorIndex] = createSignal<number>(-1)

  // Sync cursor from external selectedId. Runs whenever props.selectedId
  // or the flat id list changes; reactive on both inputs.
  createEffect(() => {
    const id = props.selectedId()
    const ids = flatIds()
    if (id === null) {
      // Move cursor onto the first navigable row when tasks first
      // arrive; otherwise leave it where it is so j/k position is
      // preserved across upstream prop churn that doesn't change ids.
      if (cursorIndex() === -1 && ids.length > 0) setCursorIndex(0)
      if (cursorIndex() >= ids.length) setCursorIndex(Math.max(0, ids.length - 1))
      if (ids.length === 0) setCursorIndex(-1)
      return
    }
    const idx = ids.indexOf(id)
    if (idx >= 0 && idx !== cursorIndex()) setCursorIndex(idx)
  })

  // Register pane-local bindings. The hook closes over our cursor
  // signal — `useBindings` re-evaluates the config on every keypress, so
  // toggling `focused` from outside immediately disables our keys.
  useSidebarBindings({
    focused: focusedAccessor,
    cursorIndex,
    setCursorIndex,
    flatTaskIds: flatIds,
    onSelect: (id) => props.onSelect(id),
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      width={SIDEBAR_WIDTH}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      {/* Header: "kobe" + version. Lifts the look-and-feel of the
         primitive's header but adds a version label so the user can tell
         which build is running. */}
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          kobe
        </text>
        <text fg={theme.textMuted} wrapMode="none">{`v${KOBE_VERSION}`}</text>
      </box>

      {/* Body: scrollable group/task list. Stretching with flexGrow so
         the footer always sits at the bottom. */}
      <scrollbox
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <box flexShrink={0} gap={0} paddingRight={1}>
          <For each={rows()}>
            {(row) => {
              if (row.kind === "header") {
                const status = row.status
                const count = row.count
                return (
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingTop={1}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
                      {STATUS_LABEL[status]}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {String(count)}
                    </text>
                  </box>
                )
              }
              const task = row.task
              const flatIndex = row.flatIndex
              const isCursor = () => flatIndex === cursorIndex()
              const isSelected = () => task.id === props.selectedId()
              const badge = STATUS_BADGE[task.status]
              const badgeColor = () => {
                switch (badge.tone) {
                  case "success":
                    return theme.success
                  case "warning":
                    return theme.warning
                  case "primary":
                    return theme.primary
                  case "error":
                    return theme.error
                  default:
                    return theme.textMuted
                }
              }
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  gap={1}
                  backgroundColor={isCursor() ? theme.primary : isSelected() ? theme.backgroundElement : undefined}
                  onMouseUp={() => props.onSelect(task.id)}
                >
                  <text fg={isCursor() ? theme.selectedListItemText : badgeColor()} wrapMode="none">
                    {badge.glyph}
                  </text>
                  <text
                    fg={isCursor() ? theme.selectedListItemText : theme.text}
                    attributes={isSelected() && !isCursor() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {task.title}
                  </text>
                </box>
              )
            }}
          </For>
          <Show when={flatIds().length === 0}>
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>No tasks yet.</text>
            </box>
          </Show>
        </box>
      </scrollbox>

      {/* Footer: placeholder Add repo command (wires up Wave 3+). */}
      <box flexShrink={0} paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="none">
          + Add repo
        </text>
      </box>
    </box>
  )
}
