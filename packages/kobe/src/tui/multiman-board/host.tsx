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

import { TextAttributes } from "@opentui/core"
import { render } from "@opentui/solid"
import type { Role as MultimanRole, Task as MultimanTask } from "@sma1lboy/multiman/types"
import { type Accessor, createSignal, onMount } from "solid-js"
import { connectOrStartDaemon } from "../../client/daemon-process.ts"
import type { KobeDaemonClient } from "../../client/index.ts"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { useBindings } from "../lib/keymap"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { MultimanBoard } from "../panes/multiman-board/MultimanBoard"

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
        <BoardShell tasks={tasksAcc} roles={rolesAcc} transparent={prefs.transparent} />
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
 * mounts the reused `MultimanBoard` plus a one-line help footer. Lives inside
 * the `ThemeProvider` so `useTheme()` resolves; also wires the quit keys.
 */
function BoardShell(props: {
  tasks: Accessor<MultimanTask[]>
  roles: Accessor<MultimanRole[]>
  transparent: boolean
}) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  onMount(() => themeCtx.setTransparentBackground(props.transparent))

  // 'q' and Ctrl-C both quit (exitOnCtrlC is off, so we handle Ctrl-C here).
  // process.exit fires the render's onDestroy, which tears down the client +
  // timers. Uses the codebase's `useBindings` keymap rather than a raw opentui
  // key handler so it matches every other kobe TUI surface.
  useBindings(() => ({
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box flexGrow={1} flexShrink={1}>
        <MultimanBoard tasks={props.tasks} roles={props.roles} />
      </box>
      <box flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
          [q] quit · [Ctrl-C] quit · live multiman board
        </text>
      </box>
    </box>
  )
}
