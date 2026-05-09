# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How to update

1. Land your change as usual.
2. Add a bullet under `## [Unreleased]` describing it user-facingly
   (one line, present tense — "Add X", "Fix Y").
3. When cutting a release: rename the `[Unreleased]` section to
   `[X.Y.Z] - YYYY-MM-DD`, add a fresh empty `[Unreleased]` above it,
   bump `package.json`, commit, then push the matching `vX.Y.Z` tag.
   The release workflow extracts the section for the tag's version
   and uses it as the GitHub release body.

---

## [Unreleased]

### Added

- `@sma1lboy/kobe` package metadata and `bin/kobe` entry so `npm i -g`
  produces a runnable CLI.
- `src/version.ts` — background version check against the npm registry
  with a 6h on-disk cache; informational `↑ vX.Y.Z available` chip in
  the TopBar.
- `scripts/build.ts` — production bundler that registers
  `@opentui/solid`'s Bun plugin and chmods the output executable.
- GitHub Actions release workflow: pushing a `vX.Y.Z` tag publishes to
  npm with provenance and creates a matching GitHub release.

## [0.0.1] - 2026-05-09

Initial public release.

### Added

- TUI orchestrator for Claude Code with a five-pane Conductor-style
  layout: sidebar (tasks), workspace (chat + per-task file tabs),
  file tree, preview, and embedded terminal.
- Per-task git worktrees with restore-across-runs persistence
  (active task + center tab survive reopen).
- Multi-line composer with paste, history, and slash commands
  inherited from claude-code; `shift+tab` cycles permission modes.
- Inline PR creation: a chat-side button injects the PR-instructions
  prompt into the active task and routes the resulting PR through
  the orchestrator's pipeline.
- Embedded terminal pane backed by tmux (one session per task,
  resized to match the rendered area, native cursor positioned via
  the renderer).
- Sidebar Working / Archives split with archive + delete flows;
  delete tears down the worktree, chat history, and task entry.
- Resizable pane splitters (drag the borders) with hover affordance.
- TopBar with brand version, repo + branch context, and a
  `Create PR` action.
- `ctrl+1234` for direct pane focus, `ctrl+q` to detach back to the
  sidebar from any pane, `?` for help dialog, `q` to quit.
- Theme system with a default `tokyonight` preset.
- Behavior-test harness (Stream 0.4) plus per-pane and end-to-end
  behavior tests covering chat, sidebar, filetree, preview, terminal,
  PR flow, composer, and task lifecycle.
