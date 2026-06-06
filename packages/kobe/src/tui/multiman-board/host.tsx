/**
 * `kobe multiman board` — a STANDALONE fullscreen multiman kanban board.
 *
 * kobe's default TUI is tmux-based (`startDirectTmux`); the Solid `app.tsx`
 * outer monitor is deprecated, so a board mounted there is invisible. This is
 * a dedicated opentui view the user opens in its own terminal — it fills the
 * whole screen and is backed by the live multiman kernel via the daemon.
 *
 * Mirrors `tui/tasks-pane/host.tsx`, the canonical "standalone opentui view
 * backed by the daemon" host: connect a `KobeDaemonClient`, subscribe to hold
 * the daemon alive + receive the `multiman` channel, build reactive signals
 * from `task.list` / `role.list`, then `render()` the component fullscreen
 * under a `ThemeProvider` (the only context `MultimanBoard` needs — it calls
 * `useTheme()` but registers no focus/keybindings/dialogs).
 *
 * Refresh model: fetch once at startup, then refetch (debounced ~250ms) on
 * every `multiman` kernel event, plus a slow ~3s fallback poll. Read-only —
 * the board never mutates the kernel.
 */

import { render } from "@opentui/solid"
import type { Comment as MultimanComment, Role as MultimanRole, Task as MultimanTask } from "@sma1lboy/multiman/types"
import { type Accessor, createSignal, onMount } from "solid-js"
import { connectOrStartDaemon } from "../../client/daemon-process.ts"
import type { KobeDaemonClient } from "../../client/index.ts"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { type BoardActions, InteractiveBoard } from "../panes/multiman-board/InteractiveBoard"

const FALLBACK_THEME = "claude"
/** Slow backstop poll: the `multiman` channel drives most refreshes; this just
 *  guarantees the board converges even if an event is ever missed. */
const POLL_MS = 3_000
/** Coalesce a burst of `multiman` events (a single mutation can fan out a few)
 *  into one refetch. */
const DEBOUNCE_MS = 250

/**
 * Normalise a `task.list` / `role.list` result into a plain array. The kernel
 * returns a bare array, but tolerate `{ tasks }` / `{ roles }` envelope shapes
 * too so a future protocol tweak doesn't blank the board.
 */
function asArray<T>(value: unknown, key: "tasks" | "roles"): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}

export async function startMultimanBoard(): Promise<void> {
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const prefs = readPersistedUiPrefs(FALLBACK_THEME)

  // Connect (auto-starting the daemon if needed). Subscribe as role:"runner"
  // so the daemon stays alive for our lifetime AND we receive the `multiman`
  // channel — a kernel mutation in any session pushes an event that wakes our
  // refetch. Matches `multiman-status-cmd.ts --watch`.
  const client: KobeDaemonClient = await connectOrStartDaemon()
  await client.subscribe({ role: "runner" })

  const [tasks, setTasks] = createSignal<MultimanTask[]>([])
  const [roles, setRoles] = createSignal<MultimanRole[]>([])

  // Fetch tasks + roles in parallel; tolerant of bare-array or enveloped
  // shapes; never throws (an empty board beats a crash on a transient error).
  async function refresh(): Promise<void> {
    try {
      const [taskResult, roleResult] = await Promise.all([
        client.request("multiman", { method: "task.list", params: {} }),
        client.request("multiman", { method: "role.list", params: {} }),
      ])
      setTasks(asArray<MultimanTask>(taskResult, "tasks"))
      setRoles(asArray<MultimanRole>(roleResult, "roles"))
    } catch {
      // Leave the last snapshot in place; the next event/poll retries.
    }
  }

  await refresh()

  // Mutating RPC surface handed to the interactive board. Each call is a thin
  // wrapper over `client.request("multiman", …)`; they reject on a daemon error
  // (e.g. an illegal `task.transition`) and the component catches + surfaces it.
  const actions: BoardActions = {
    listComments: async (taskId) => {
      const res = await client.request("multiman", { method: "comment.list", params: { taskId } })
      return Array.isArray(res) ? (res as MultimanComment[]) : []
    },
    transition: async (id, to) => {
      await client.request("multiman", { method: "task.transition", params: { id, to } })
    },
    updateTask: async (id, patch) => {
      await client.request("multiman", { method: "task.update", params: { id, ...patch } })
    },
    addComment: async (taskId, body) => {
      await client.request("multiman", { method: "comment.add", params: { taskId, body } })
    },
    // Top-level chat → inbox so the orchestrator can consume it. `payload` is a
    // JSON string (kernel stores it as text); severity "info".
    pushChat: async (text) => {
      await client.request("multiman", {
        method: "inbox.push",
        params: { source: "console", kind: "chat", payload: JSON.stringify({ text }), severity: "info" },
      })
    },
    refresh,
  }

  // Debounced refetch on every `multiman` kernel event.
  let debounce: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = client.onChannel("multiman", () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void refresh(), DEBOUNCE_MS)
  })

  // Slow backstop poll in case a channel event is ever missed.
  const poll = setInterval(() => void refresh(), POLL_MS)

  const tasksAcc: Accessor<MultimanTask[]> = tasks
  const rolesAcc: Accessor<MultimanRole[]> = roles

  await render(
    () => (
      <ThemeProvider mode="dark" theme={prefs.theme}>
        <BoardShell tasks={tasksAcc} roles={rolesAcc} actions={actions} transparent={prefs.transparent} />
      </ThemeProvider>
    ),
    {
      backgroundColor: "transparent",
      externalOutputMode: "passthrough",
      // Drive teardown ourselves so Ctrl-C / 'q' close the daemon client and
      // timers cleanly (mirrors tasks-pane). exitOnCtrlC stays off; the key
      // handler below calls process.exit, which fires onDestroy.
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      useKittyKeyboard: {},
      onDestroy: () => {
        if (debounce) clearTimeout(debounce)
        clearInterval(poll)
        unsubscribe()
        client.close()
      },
    },
  )
}

/**
 * Fullscreen wrapper: paints the theme background across the whole screen and
 * mounts the interactive console. Lives inside the `ThemeProvider` so
 * `useTheme()` resolves. All navigation / edit / chat keys (incl. q / Ctrl-C
 * quit, gated per mode) live in {@link InteractiveBoard}; mutations route
 * through the `actions` wired in `startMultimanBoard`.
 */
function BoardShell(props: {
  tasks: Accessor<MultimanTask[]>
  roles: Accessor<MultimanRole[]>
  actions: BoardActions
  transparent: boolean
}) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  onMount(() => themeCtx.setTransparentBackground(props.transparent))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <InteractiveBoard tasks={props.tasks} roles={props.roles} actions={props.actions} />
    </box>
  )
}
