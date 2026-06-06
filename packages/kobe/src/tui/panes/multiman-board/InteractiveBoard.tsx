/**
 * Interactive multiman console (S6b).
 *
 * Turns the read-only {@link MultimanBoard} into a navigable + editable +
 * chat-capable team console. The board host (`tui/multiman-board/host.tsx`)
 * owns the live `tasks` / `roles` signals (re-fetched on the `multiman`
 * channel) and a `client` + `refresh()`; this component owns the UI state
 * (cursor / mode / open task / input buffer) and routes every key to the
 * right daemon RPC through the {@link BoardActions} passed down from the host.
 *
 * Three modes:
 *   - "board"  — five-column kanban; ↑/↓/j/k move the cursor over a flattened,
 *                column-ordered card list; Enter opens detail; `m` (or `/`)
 *                opens the top-level chat composer; `q`/Ctrl-C quit.
 *   - "detail" — a full-screen panel for one task: meta + comment thread, with
 *                status actions (a approve / r reject / x cancel), `p` cycle
 *                priority, `e` edit title, `c` reply; Esc back.
 *   - "input"  — a bottom composer line (`chat ›` / `reply ›` / `title ›`).
 *                Enter submits (routed by `inputTarget`), Esc cancels. While
 *                here the board/detail bindings are DISABLED via `enabled` so a
 *                typed letter (a/r/x/…) never fires an action.
 *
 * Decided RPC wiring (see host docstring):
 *   - reply  → `comment.add {taskId, body}`            (does NOT change status)
 *   - chat   → `inbox.push {source:"console", kind:"chat", payload:{text}}`
 *   - approve→ `task.transition {id, to:"done"}`
 *   - reject → `task.transition {id, to:"assigned"}`
 *   - cancel → `task.transition {id, to:"cancelled"}`
 *   - prio   → `task.update {id, priority}`
 *   - title  → `task.update {id, title}`
 * Mutations are best-effort: a rejected transition (illegal status edge) is
 * caught and surfaced on the footer status line rather than crashing the view.
 */

import { TextAttributes } from "@opentui/core"
import type { Comment as MultimanComment, Role as MultimanRole, Task as MultimanTask } from "@sma1lboy/multiman/types"
import { type Accessor, For, Show, createMemo, createSignal } from "solid-js"
import { stripNewlines } from "../../component/new-task-dialog"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"

/**
 * Mutating RPC surface the host wires to its `KobeDaemonClient`. Each call is
 * best-effort: it resolves on success and rejects on a daemon error (e.g. an
 * illegal `task.transition`); the component catches and shows the message.
 */
export type BoardActions = {
  listComments: (taskId: string) => Promise<MultimanComment[]>
  transition: (id: string, to: MultimanTask["status"]) => Promise<void>
  updateTask: (id: string, patch: { title?: string; priority?: number }) => Promise<void>
  addComment: (taskId: string, body: string) => Promise<void>
  pushChat: (text: string) => Promise<void>
  /** Re-fetch the host's tasks/roles after a mutation (the channel also pushes). */
  refresh: () => Promise<void>
}

export type InteractiveBoardProps = {
  tasks: Accessor<MultimanTask[]>
  roles: Accessor<MultimanRole[]>
  actions: BoardActions
}

type Mode = "board" | "detail" | "input"
type InputTarget = "chat" | "reply" | "editTitle"

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

function priorityMeta(priority: number): { label: string; tone: ColumnTone | "error" } {
  if (priority <= 0) return { label: "No priority", tone: "textMuted" }
  if (priority === 1) return { label: "Low", tone: "info" }
  if (priority === 2) return { label: "Medium", tone: "warning" }
  if (priority === 3) return { label: "High", tone: "warning" }
  return { label: "Urgent", tone: "error" }
}

function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(id.length - 6)
}

function truncate(s: string, max: number): string {
  if (max <= 0) return ""
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** Short one-line error text for the footer status (e.g. an illegal transition). */
function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return truncate(oneLine(raw), 60)
}

export function InteractiveBoard(props: InteractiveBoardProps) {
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

  // ── UI state ────────────────────────────────────────────────────────────
  const [mode, setMode] = createSignal<Mode>("board")
  const [cursor, setCursor] = createSignal(0)
  const [openTaskId, setOpenTaskId] = createSignal<string | null>(null)
  const [inputTarget, setInputTarget] = createSignal<InputTarget>("chat")
  const [inputBuffer, setInputBuffer] = createSignal("")
  const [comments, setComments] = createSignal<MultimanComment[]>([])
  const [status, setStatus] = createSignal("")

  function flash(msg: string): void {
    setStatus(msg)
  }

  const roleNames = createMemo(() => {
    const map = new Map<string, string>()
    for (const r of props.roles()) map.set(r.id, r.name)
    return map
  })

  // Group tasks into the five columns (same mapping as the read-only board).
  const grouped = createMemo(() => {
    const buckets = new Map<string, MultimanTask[]>()
    for (const col of COLUMNS) buckets.set(col.key, [])
    for (const task of props.tasks()) {
      const col = COLUMNS.find((c) => c.statuses.includes(task.status))
      if (col) buckets.get(col.key)?.push(task)
    }
    return buckets
  })

  // Flatten cards in column order into ONE list so j/k is a single linear walk
  // (the robust first cut: no per-column row math, cursor can't land on an
  // empty column). Recomputes with the grouping.
  const flat = createMemo<MultimanTask[]>(() => {
    const out: MultimanTask[] = []
    const g = grouped()
    for (const col of COLUMNS) {
      for (const t of g.get(col.key) ?? []) out.push(t)
    }
    return out
  })

  // Keep the cursor in range as the flattened list changes (a refetch can drop
  // the card under the cursor). Clamp to [0, len-1]; an empty board → 0.
  const clampedCursor = createMemo(() => {
    const len = flat().length
    if (len === 0) return 0
    return Math.min(cursor(), len - 1)
  })

  const cursorId = createMemo<string | null>(() => flat()[clampedCursor()]?.id ?? null)

  const openTask = createMemo<MultimanTask | null>(() => {
    const id = openTaskId()
    if (!id) return null
    return props.tasks().find((t) => t.id === id) ?? null
  })

  // ── navigation ──────────────────────────────────────────────────────────
  function move(delta: number): void {
    const len = flat().length
    if (len === 0) return
    const next = Math.min(Math.max(clampedCursor() + delta, 0), len - 1)
    setCursor(next)
  }

  async function openDetail(): Promise<void> {
    const id = cursorId()
    if (!id) return
    setOpenTaskId(id)
    setComments([])
    setMode("detail")
    setStatus("")
    await loadComments(id)
  }

  async function loadComments(taskId: string): Promise<void> {
    try {
      const list = await props.actions.listComments(taskId)
      setComments(Array.isArray(list) ? list : [])
    } catch {
      setComments([])
    }
  }

  function backToBoard(): void {
    setOpenTaskId(null)
    setComments([])
    setMode("board")
    setStatus("")
  }

  // ── input mode ──────────────────────────────────────────────────────────
  function enterInput(target: InputTarget, prefill = ""): void {
    setInputTarget(target)
    setInputBuffer(prefill)
    setMode("input")
    setStatus("")
  }

  function cancelInput(): void {
    setInputBuffer("")
    // Return to detail if a task is open, else the board.
    setMode(openTaskId() ? "detail" : "board")
  }

  async function submitInput(): Promise<void> {
    const text = inputBuffer().trim()
    const target = inputTarget()
    if (!text) {
      cancelInput()
      return
    }
    try {
      if (target === "chat") {
        await props.actions.pushChat(text)
        flash("message sent to inbox")
      } else if (target === "reply") {
        const id = openTaskId()
        if (id) {
          await props.actions.addComment(id, text)
          await loadComments(id)
          flash("reply posted")
        }
      } else if (target === "editTitle") {
        const id = openTaskId()
        if (id) {
          await props.actions.updateTask(id, { title: text })
          flash("title updated")
        }
      }
      await props.actions.refresh()
    } catch (err) {
      flash(errMsg(err))
    }
    setInputBuffer("")
    setMode(openTaskId() ? "detail" : "board")
  }

  // ── detail actions (best-effort; surface errors, never crash) ─────────────
  async function runTransition(to: MultimanTask["status"], label: string): Promise<void> {
    const id = openTaskId()
    if (!id) return
    try {
      await props.actions.transition(id, to)
      await props.actions.refresh()
      flash(label)
    } catch (err) {
      flash(errMsg(err))
    }
  }

  async function cyclePriority(): Promise<void> {
    const t = openTask()
    if (!t) return
    const next = (t.priority + 1) % 5
    try {
      await props.actions.updateTask(t.id, { priority: next })
      await props.actions.refresh()
      flash(`priority → ${priorityMeta(next).label}`)
    } catch (err) {
      flash(errMsg(err))
    }
  }

  // ── key bindings ──────────────────────────────────────────────────────────
  // Three groups, each gated by `enabled` on the active mode so keys never
  // collide. The input group is the crux: when mode==="input" the board AND
  // detail groups are disabled, so typing a/r/x/letters can't fire an action —
  // the native <input> below owns every printable key + Backspace, and Esc is
  // the only board-side key we keep live (cancel).
  useBindings(() => ({
    enabled: mode() === "board",
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
      { key: "up", cmd: () => move(-1) },
      { key: "k", cmd: () => move(-1) },
      { key: "down", cmd: () => move(1) },
      { key: "j", cmd: () => move(1) },
      // ←/→/h/l: jump a screenful within the linear list (coarse column hop).
      { key: "left", cmd: () => move(-1) },
      { key: "h", cmd: () => move(-1) },
      { key: "right", cmd: () => move(1) },
      { key: "l", cmd: () => move(1) },
      { key: "return", cmd: () => void openDetail() },
      { key: "m", cmd: () => enterInput("chat") },
      { key: "/", cmd: () => enterInput("chat") },
    ],
  }))

  useBindings(() => ({
    enabled: mode() === "detail",
    bindings: [
      { key: "escape", cmd: () => backToBoard() },
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
      { key: "a", cmd: () => void runTransition("done", "approved → done") },
      { key: "r", cmd: () => void runTransition("assigned", "rejected → assigned") },
      { key: "x", cmd: () => void runTransition("cancelled", "cancelled") },
      { key: "p", cmd: () => void cyclePriority() },
      { key: "e", cmd: () => enterInput("editTitle", openTask()?.title ?? "") },
      { key: "c", cmd: () => enterInput("reply") },
    ],
  }))

  useBindings(() => ({
    enabled: mode() === "input",
    bindings: [
      // Only Esc is board-side in input mode; the <input> handles the rest
      // (printable → append, Backspace → delete, Enter → onSubmit).
      { key: "escape", cmd: () => cancelInput() },
      // Ctrl-C still quits even mid-compose (matches the rest of kobe).
      { key: "ctrl+c", cmd: () => process.exit(0) },
    ],
  }))

  const inputLabel = () => {
    switch (inputTarget()) {
      case "reply":
        return "reply"
      case "editTitle":
        return "title"
      default:
        return "chat"
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexGrow={1} flexShrink={1}>
        <Show
          when={mode() !== "detail"}
          fallback={<DetailView task={openTask} comments={comments} roleNames={roleNames} />}
        >
          <BoardView grouped={grouped} cursorId={cursorId} roleNames={roleNames} total={() => props.tasks().length} />
        </Show>
      </box>

      {/* Bottom composer — only in input mode. The native <input> is focused so
          it captures every printable key + Backspace; onSubmit routes by
          inputTarget. The board/detail bindings are disabled here. */}
      <Show when={mode() === "input"}>
        <box flexShrink={0} flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
            {inputLabel()} ›
          </text>
          <box flexGrow={1}>
            <input
              value={inputBuffer()}
              focused={true}
              onInput={(v: string) => setInputBuffer(stripNewlines(v))}
              onSubmit={() => void submitInput()}
            />
          </box>
        </box>
      </Show>

      {/* Footer: mode-aware help + a transient status line. */}
      <Footer mode={mode} status={status} />
    </box>
  )
}

function BoardView(props: {
  grouped: Accessor<Map<string, MultimanTask[]>>
  cursorId: Accessor<string | null>
  roleNames: Accessor<Map<string, string>>
  total: Accessor<number>
}) {
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

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1} paddingBottom={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          multiman board
        </text>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
          {props.total()} task{props.total() === 1 ? "" : "s"}
        </text>
      </box>

      <box flexDirection="row" gap={1} flexGrow={1}>
        <For each={COLUMNS}>
          {(col) => {
            const cards = () => props.grouped().get(col.key) ?? []
            const accent = toneColor(col.tone)
            return (
              <box flexDirection="column" flexGrow={1} flexBasis={0}>
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

                <scrollbox flexGrow={1} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}>
                  <box flexDirection="column" gap={1}>
                    <For each={cards()}>
                      {(task) => {
                        const prio = priorityMeta(task.priority)
                        const assignee = () =>
                          task.role_id ? (props.roleNames().get(task.role_id) ?? task.role_id) : "—"
                        const selected = () => props.cursorId() === task.id
                        return (
                          <box
                            flexDirection="column"
                            border
                            borderColor={selected() ? theme.primary : theme.borderSubtle}
                            backgroundColor={selected() ? theme.backgroundPanel : undefined}
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

function DetailView(props: {
  task: Accessor<MultimanTask | null>
  comments: Accessor<MultimanComment[]>
  roleNames: Accessor<Map<string, string>>
}) {
  const { theme } = useTheme()
  const assignee = () => {
    const t = props.task()
    if (!t?.role_id) return "—"
    return props.roleNames().get(t.role_id) ?? t.role_id
  }
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <Show when={props.task()} fallback={<text fg={theme.textMuted}>task not found</text>}>
        {(t) => (
          <box flexDirection="column" flexGrow={1} gap={0}>
            {/* Header: id + status. */}
            <box flexDirection="row" gap={1} paddingBottom={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                {shortId(t().id)}
              </text>
              <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
                {t().status}
              </text>
            </box>

            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {t().title}
            </text>

            {/* Meta row. */}
            <box flexDirection="row" gap={2} paddingTop={1}>
              <text fg={theme.textMuted} wrapMode="none">
                prio: {priorityMeta(t().priority).label}
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                assignee: {assignee()}
              </text>
              <Show when={t().dag_id}>
                <text fg={theme.textMuted} wrapMode="none">
                  dag: {shortId(t().dag_id ?? "")}
                </text>
              </Show>
            </box>
            <Show when={t().mr_url}>
              <text fg={theme.info} wrapMode="none">
                mr: {t().mr_url}
              </text>
            </Show>

            <Show when={t().body && t().body.trim().length > 0}>
              <box paddingTop={1}>
                <text fg={theme.text}>{t().body}</text>
              </box>
            </Show>

            {/* Comment thread. */}
            <box paddingTop={1} paddingBottom={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                ── thread ({props.comments().length}) ──
              </text>
            </box>
            <scrollbox flexGrow={1} verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}>
              <box flexDirection="column" gap={1}>
                <For each={props.comments()}>
                  {(c) => (
                    <box flexDirection="column">
                      <text fg={theme.accent} attributes={TextAttributes.DIM} wrapMode="none">
                        {c.author_kind}
                        {c.author_id ? `:${c.author_id}` : ""}
                      </text>
                      <text fg={theme.text}>{c.body}</text>
                    </box>
                  )}
                </For>
                <Show when={props.comments().length === 0}>
                  <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                    no comments yet
                  </text>
                </Show>
              </box>
            </scrollbox>
          </box>
        )}
      </Show>
    </box>
  )
}

function Footer(props: { mode: Accessor<Mode>; status: Accessor<string> }) {
  const { theme } = useTheme()
  const help = () => {
    switch (props.mode()) {
      case "detail":
        return "a approve · r reject · x cancel · p prio · e edit · c reply · esc back"
      case "input":
        return "enter send · esc cancel"
      default:
        return "↑↓/jk move · enter open · m message · q quit"
    }
  }
  return (
    <box flexShrink={0} flexDirection="row" gap={2} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
        {help()}
      </text>
      <Show when={props.status()}>
        <text fg={theme.accent} wrapMode="none">
          {props.status()}
        </text>
      </Show>
    </box>
  )
}
