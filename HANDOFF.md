# Handoff — kobe (post-0.2.x polish wave)

> Written 2026-05-10 at the end of a long polish session that shipped 0.2.0 → 0.2.1 → 0.2.2.
> Prior handoffs:
>   - [`docs/HANDOFF-v1.md`](./docs/HANDOFF-v1.md) — Phase 0 mission + framing.
>   - [`docs/HANDOFF-v2.md`](./docs/HANDOFF-v2.md) — Wave 3 → 4 transition (5-pane TUI shipped).
>
> THIS file: where the binary stands at v0.2.2, the research that drove the recent decisions, and what's open.

---

## Read first (in this order)

1. **`CLAUDE.md`** — operating model, hard rules. Especially the "no delete without consent" rule.
2. **`docs/DESIGN.md`** — design philosophy + state-ownership conventions.
3. **`docs/PLAN.md`** — Phase 0 → 1 wave plan. Phase 1 closed at G4 (shipped as `@sma1lboy/kobe@0.1.0`); v0.2.x is post-G4 polish.
4. **`docs/KEYBINDINGS.md`** — pane-scope rules + chord-decision log. Read **before** adding/moving any chord. The Decision log section in particular records why we rejected ctrl+digit / alt+digit / ctrl+shift+digit.
5. **`docs/HARNESS.md`** — agent self-test contract.
6. **`memory/MEMORY.md`** — load-bearing per-session learnings.

---

## State of the binary at v0.2.2

```
┌──────────────────────────────────────────────────────────────────────┐
│ KobeCode v0.2.2                                  [PR] Create PR      │  TopBar
├──────────┬─────────────────────────────────┬─────────────────────────┤
│ h TASKS  │ j WORKSPACE        kobe/branch  │ k FILES                 │
│          │ ┌──[chat]─[<file>]──[<file>]─┐ │   All  Changes  Checks  │
│ [Working │ │                            │ │   .github/              │
│  session]│ │  user/assistant/tool rows  │ │   docs/                 │
│ Archives │ │  + queued prompt rows      │ │   packages/             │
│          │ │  + thinking spinner        │ │   src/                  │
│ ● task-1 │ │                            │ ├─━━━━━━━━━━━━━━━━━━━━━━━┤
│ ○ task-2 │ │  > Ask Claude…             │ │ l TERMINAL              │
│          │ │  ┃  enter queue            │ │  per-task tmux pty      │
│          │ │  ┃  ctrl+enter steer       │ │                         │
│          │ └────────────────────────────┘ │                         │
├──────────┴─────────────────────────────────┴─────────────────────────┤
│ Chat: [ctrl+q] tasks [enter] send [shift+enter] newline …            │  StatusBar
│       … [F1] help [tab] cycle [ctrl+hjkl] focus                      │
└──────────────────────────────────────────────────────────────────────┘
```

Pane focus uses **`ctrl+hjkl`** (h=tasks, j=workspace, k=files, l=terminal). The bold ordinal letter on each pane title shows the chord.

The five major user-visible additions since v0.1.x:

1. **Mid-stream queue + steer** — typing while a turn streams. Plain enter queues; ctrl+enter interrupts the in-flight subprocess and dispatches the new prompt against the same session id. Drain serialises through a `draining` lock; orchestrator buffers `done`/`error` until engine cleanup completes so `SessionRegistry: duplicate sessionId` and `tasks.json.tmp` rename races can't fire on consecutive turns.
2. **Pending approval/question pickers lifted into the composer slot** — ExitPlanMode and AskUserQuestion render as the bottom-of-chat input while pending; once submitted, the row drops back into the transcript as a resolved entry.
3. **Settings dialog two-level keyboard nav** — sidebar level (j/k cycles General/Dev) vs body level (j/k cycles theme rows + transparent-bg toggle + Dev's Reset button), h/l switch level. Every body row reachable from the keyboard.
4. **User-installable themes** under `~/.kobe/themes/` + user-pickable focus-accent color slot.
5. **Permission cycler reaches `bypassPermissions`** — `default → acceptEdits → plan → bypass → default`. Lets the user opt into "auto-approve everything" for tasks where the worktree-cwd boundary is too restrictive.

All four pane titles align (paddingTop=1, paddingLeft=2). Modals cap at viewport height with internal scroll for long content; the `▌` focus marker was dropped (the bold focus-accent ordinal does that job).

---

## Research findings that drove recent decisions

When I had to make a judgment call I delegated research to subagents. The decisions land in code; the *why* behind each lands here.

### 1. Pane focus chord — why `ctrl+hjkl` over `ctrl+1..4` / `alt+1..4`

Iterated through three candidates. Full decision log in [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) "Decision log: pane focus chord."

- **`ctrl+1..4`** — VSCode/iTerm muscle memory. Killed by terminal-layer reality: legacy mode doesn't propagate the ctrl modifier on digit keys (the byte the app receives is just `1`). Fixing that needs CSI-u / kitty keyboard support, AND tmux extended-keys, AND iTerm2 has a known quirk where ctrl+1 / ctrl+9 / ctrl+0 silently fall through to bare digit bytes even with CSI-u enabled (only ctrl+2..8 emit the proper sequence).
- **`alt+1..4`** — alt+digit produces a stable two-byte ESC-sequence in legacy mode, so it works regardless of CSI-u. Killed because macOS launchers (Raycast, Karabiner, Alfred) commonly intercept Option+digit globally before the byte reaches the terminal.
- **`ctrl+hjkl`** — final pick. ctrl+letter chords map to stable C0 control bytes (ctrl+h=BS, ctrl+j=LF, ctrl+k=VT, ctrl+l=FF), every terminal sends them without protocol negotiation. Conflict with editor commands (ctrl+h=backspace etc.) is OK because pressing the chord moves focus AWAY from the input that would consume it — by the time the byte reaches the textarea, focus has already left. Required moving `palette.open` from `ctrl+k` to `ctrl+p` / `cmd+p`.

**Lesson recorded in `feedback_keybinding_boundaries.md` memory**: prefer ctrl+letter over ctrl+digit / alt+digit / cmd+digit. Letters Just Work; digits need protocol upgrades; non-ctrl modifiers get hijacked by user-space launchers.

### 2. Default model resolution — what claude-code does, what opcode does, what kobe does

Researched both refs to figure out where the default model comes from.

- **claude-code** (`refs/claude-code/src/utils/model/model.ts:getUserSpecifiedModelSetting()`): resolution order is `/model` runtime override → `--model` CLI flag → `ANTHROPIC_MODEL` env var → `~/.claude/settings.json`'s top-level `model` key. The `[1m]` suffix syntax (`claude-opus-4-7[1m]`) is part of the model id, parsed by `parseUserSpecifiedModel()` to extract the 1M-context flag.
- **opcode** (`refs/opcode/src-tauri/src/commands/claude.rs:757-768`): does NOT read settings. The frontend passes `model: String` explicitly to the Tauri command on every spawn. No `~/.claude/settings.json` integration.
- **kobe (current)**: `Task.model` (per-task pin) → `~/.claude/settings.json`'s `model` key → hardcoded `FALLBACK_DEFAULT_MODEL_ID = "claude-opus-4-7[1m]"`. Mirrors claude-code's ordering. Reader at [`packages/kobe/src/tui/panes/chat/composer/claude-settings.ts`](./packages/kobe/src/tui/panes/chat/composer/claude-settings.ts). Orchestrator forwards the resolved id via `--model` on every spawn.

Picker entries also added: `opus 4.7 (1M)`, `sonnet 4.6 (1M)`. Same `[1m]` suffix syntax as claude-code.

### 3. Permission gating in `claude -p` mode — opcode's answer is "skip"

When a tool hits a permission gate (e.g. reading `~/.zshrc` from a worktree cwd), claude-code in `-p` mode has no interactive permission protocol — there is no popup, no approval event in stream-json, no built-in approve/deny UI. The pragmatic answers are:

- **opcode**: spawns with `--dangerously-skip-permissions` universally. Every gate is bypassed, model sees no denials. Verified: `refs/opcode/src-tauri/src/commands/claude.rs:757-768` and `web_server.rs:486-495` both add the flag unconditionally. opcode's "permission" UI you might find by grepping is for swarm leader/worker coordination — unrelated to subprocess gates.
- **kobe (current, v0.2.2)**: Exposes `bypassPermissions` as a 4th step in the shift+tab cycler (`default → acceptEdits → plan → bypass → default`). User opt-in per task, with the footer badge rendering "bypass permissions" in warning red so the loose-permissions state is visible.
- **The proper alternative** (not built): `--permission-prompt-tool <name>` lets claude-code delegate every tool-permission decision to a custom MCP tool. Wiring that up requires (a) a kobe-hosted MCP server implementing the permission tool, (b) registering it on every spawn, (c) routing async permission requests to a UI panel and waiting for approve/deny. ~2-3 day build. Tracked as a follow-up; not in v0.2.x scope.

### 4. Mid-stream submission modes — the queue/steer feature

claude-code's own UI implements this via a unified `commandQueue` with three priorities (`'now' / 'next' / 'later'`) — see `refs/claude-code/src/utils/messageQueueManager.ts`. kobe collapsed `'next'` into `'later'` because `claude -p` is a one-shot subprocess with no mid-tool insertion point: queueing past the in-flight turn is the only meaningful "later" semantics. `'now'` maps to kobe's `ctrl+enter` steer (kill subprocess + run new prompt against same session id); `'later'` maps to plain `enter` queue (drained on `done`).

---

## Open follow-ups (in rough priority order)

1. **Permission-prompt MCP bridge.** v0.2.2 settled for opcode-style `bypassPermissions`. Real fix is the MCP-server route described above. Tracked separately. ~2-3 day estimate.
2. **Behavior tests are local-only.** They need tmux + node-pty terminal sizing that CI can't easily provide. CI runs typecheck + unit + build only. Some tests on this machine fail due to local environment quirks (terminal resize timing, tmux extended-keys in test environment). Re-running on Jackson's machine generally passes.
3. **`extended-keys` requirement** for users who DO want ctrl+digit / CSI-u sequences (the few legitimate ctrl+digit chords in the keymap). `~/.tmux.conf` needs `set -g extended-keys on` + `set -as terminal-features 'xterm*:extkeys'`, AND iTerm2 needs profile-level "Report keys using CSI u." iTerm2's ctrl+1 quirk persists even with that. Documented in `docs/KEYBINDINGS.md`.
4. **kobe currently re-reads `~/.claude/settings.json` lazily** with a process-lifetime cache. claude-code's own `/model` command rewrites the file mid-session — kobe doesn't pick that up live. Cache invalidation is a follow-up; for now the user restarts kobe to pick up the new default.
5. **Bold leading number on chat tab chips** was removed when chat tab navigation moved from `ctrl+1..9` numeric pick to `ctrl+]` / `ctrl+[` cycle. If the user later wants positional chat-tab chord back (e.g. `alt+1..9` or some bracket-prefixed chord), the chip rendering can re-add an ordinal.

---

## Operating discipline — what the next session should preserve

- **Every keybinding decision goes through `docs/KEYBINDINGS.md`.** Add an overlap-table row when you discover a new conflict, append to the Decision log when a chord moves. The doc is small on purpose — if a section sprawls, the underlying design is probably wrong.
- **`KobeKeymap` in `packages/kobe/src/tui/context/keybindings.ts` is the single source of truth.** No chord strings outside that table; pane code uses `bindByIds({ id: handler })`.
- **CHANGELOG entries are user-facing.** Past sessions sometimes cataloged 30 atomic commits as 4 user-visible bullets — that's the right altitude. Use `[Unreleased]` while in flight, rename to `[X.Y.Z] - YYYY-MM-DD` when cutting.
- **Behavior tests are local-only**, not gating CI. Don't block on them; run them when you have a real environment, surface flaky ones to Jackson.
- **The `refs/` slot is read-only.** opcode + claude-code are research material. When you don't know how a subprocess pattern should look, port from `refs/opcode/`. When you don't know how a chat row should look, port from `refs/claude-code/`. Don't reinvent.
- **No delete without explicit user consent in the same conversation turn.** This bit a previous session — accidentally `git add -A` swept up 503 unrelated deletions. The recovery commit is in the log.

---

## Releases shipped this session

| Version | Date       | Notes                                                                      |
| ------- | ---------- | -------------------------------------------------------------------------- |
| 0.2.0   | 2026-05-10 | Queue/steer, modal viewport caps, picker-first new-task, two-level settings, user-installable themes, focus-accent setting, ctrl+hjkl pane focus. |
| 0.2.1   | 2026-05-10 | Default model from `~/.claude/settings.json`, opus 4.7 (1M) added, unified focus-blur on pane jump. |
| 0.2.2   | 2026-05-10 | `bypassPermissions` reachable via shift+tab cycler.                        |

All three published to npm + tagged on GitHub via the release workflow. CHANGELOG entries at `packages/kobe/CHANGELOG.md` are the authoritative descriptions.
