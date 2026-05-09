/**
 * kobe TUI bootstrap.
 *
 * Phase 0.2: mount the lifted opencode shell (theme + KV + sync + dialog +
 * command palette providers) and render a themed banner with a stub sidebar.
 * No real task data yet — the orchestrator and engine streams populate that
 * in Wave 1+.
 *
 * The visible smoke surface here is intentional: the kobe banner uses the
 * theme's `primary` and `accent` colors so a `bun run dev` smoke run shows
 * ANSI color codes (proving the theme provider is wired) and the sidebar
 * width matches DESIGN.md §1's Conductor-style layout.
 *
 * Press `cmd+k` (or `ctrl+k`) to open the empty command palette — the dialog
 * stack lift is verified by that key path opening a dialog you can dismiss
 * with `esc`.
 */

import { TextAttributes } from "@opentui/core"
import { render } from "@opentui/solid"
import { Show } from "solid-js"
import { Sidebar } from "./component/sidebar"
import { CommandPaletteProvider, useCommandPalette } from "./context/command-palette"
import { KVProvider } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, useTheme } from "./context/theme"
import { useBindings } from "./lib/keymap"
import { DialogProvider } from "./ui/dialog"

const KOBE_BANNER = ["k o b e", "─────────"]

function HelpHint() {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={2} paddingTop={1}>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>cmd+k</span> commands
      </text>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>esc</span> dismiss
      </text>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>ctrl+c</span> quit
      </text>
    </box>
  )
}

function Banner() {
  const { theme, selected } = useTheme()
  return (
    <box flexGrow={1} paddingLeft={4} paddingTop={2} paddingRight={4} paddingBottom={1}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        {KOBE_BANNER[0]}
      </text>
      <text fg={theme.borderActive}>{KOBE_BANNER[1]}</text>
      <box paddingTop={1}>
        <text fg={theme.text}>
          TUI orchestrator for Claude Code <span style={{ fg: theme.textMuted }}>(codename)</span>
        </text>
        <text fg={theme.textMuted}>Phase 0.2 — opencode shell lifted, providers wired.</text>
        <text fg={theme.textMuted}>
          theme: <span style={{ fg: theme.accent }}>{selected}</span>
        </text>
      </box>
      <HelpHint />
    </box>
  )
}

function Shell() {
  const { theme } = useTheme()
  const palette = useCommandPalette()

  // Global hotkeys: cmd+k / ctrl+k open the palette; we register both
  // because terminal modifier reporting differs across environments.
  useBindings(() => ({
    bindings: [
      { key: "ctrl+k", cmd: () => palette.show() },
      { key: "alt+k", cmd: () => palette.show() },
    ],
  }))

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.background}>
      <Sidebar
        title="kobe"
        emptyMessage="No tasks yet. Wave 2 Stream F will populate this pane."
        footer={
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> ready
          </text>
        }
      />
      <Banner />
    </box>
  )
}

function App() {
  return (
    <ThemeProvider mode="dark" theme="opencode">
      <KVProvider>
        <SyncProvider>
          <DialogProvider>
            <CommandPaletteProvider>
              <Show when={true}>
                <Shell />
              </Show>
            </CommandPaletteProvider>
          </DialogProvider>
        </SyncProvider>
      </KVProvider>
    </ThemeProvider>
  )
}

export async function startTui(): Promise<void> {
  await render(() => <App />)
}
