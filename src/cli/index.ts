/**
 * kobe CLI entry point.
 *
 * Phase 0.1 scope: just boot the TUI. Argv parsing is a stub for now —
 * we'll wire up Commander/yargs once the engine + orchestrator are in.
 *
 * Host-mode hooks (Wave 3 behavior testing):
 *   When a `KOBE_<PANE>_HOST=1` env var is set, we boot a stripped-down
 *   variant of kobe that mounts a single pane in isolation. This lets
 *   each pane stream's behavior test (Stream G/H/I/J) drive its own
 *   pane via PTY without spinning up the full app. Each branch is one
 *   if-statement — orchestrator merges keep them independent.
 *
 *   - `KOBE_PREVIEW_HOST=1` (Stream I) → mount `<Preview>` over a
 *     fixture worktree. The test sets `KOBE_PREVIEW_WORKTREE` to point
 *     at the worktree, optional `KOBE_PREVIEW_DIFF_BASE`, and
 *     `KOBE_PREVIEW_OPEN_FILE` to drive the imperative `open(...)` call.
 *
 *   Other streams add their own `KOBE_*_HOST` hooks here as separate
 *   if-branches. Don't merge them — keep one branch per pane so a
 *   broken pane doesn't take the others down.
 */
import { startTui } from "../tui/index.tsx"

async function main(): Promise<void> {
  if (process.env.KOBE_PREVIEW_HOST === "1") {
    const { startPreviewHost } = await import("../../test/behavior/fixtures/preview-host.tsx")
    await startPreviewHost()
    return
  }
  // Future: parse argv here (e.g. `kobe --repo <path>`, `kobe new "title"`).
  // For 0.1 we just open the TUI.
  await startTui()
}

main().catch((err) => {
  console.error("kobe failed to start:", err)
  process.exit(1)
})
