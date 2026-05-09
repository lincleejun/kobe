/**
 * Two-pane diff dialog: file list (left) + colored patch view (right).
 *
 * Adapted from `refs/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-diff.tsx`
 * (the user's `/diff` command in the Sma1lboy/opencode fork). The opencode
 * version pulled file diffs via `sdk.client.vcs.diff(...)`; kobe doesn't have
 * an SDK to call. We accept `files` as a prop instead — the caller (a future
 * preview pane in Wave 3 Stream I) is responsible for shelling out to
 * `git diff` and feeding patches in.
 *
 * The `DiffLine` rendering pattern (the actual `+`/`-`/`@@` colorization) is
 * lifted unchanged because Wave 3 Stream I will reuse it when the preview
 * pane materializes.
 */

import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"

const LIST_WIDTH = 38

export type DiffStatus = "added" | "deleted" | "modified"

export type DiffFile = {
  /** Display path. */
  file: string
  /** Status badge: A / D / M. */
  status: DiffStatus
  /** Unified-diff text (`git diff` output). Empty string = no patch. */
  patch: string
  additions?: number
  deletions?: number
}

function statusLabel(status: DiffStatus): string {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

function truncateLeft(s: string, width: number): string {
  if (s.length <= width) return s
  return `…${s.slice(s.length - width + 1)}`
}

export type DialogDiffProps = {
  /** File list. Pass `[]` and `loading` to show a loading state. */
  files: DiffFile[]
  loading?: boolean
  /** Called when the user presses `r`. Implementations can refetch. */
  onReload?: () => void
}

export function DialogDiff(props: DialogDiffProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  dialog.setSize("xlarge")

  const [selected, setSelected] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined

  const list = createMemo<DiffFile[]>(() => props.files ?? [])
  const current = createMemo<DiffFile | undefined>(() => list()[selected()])

  function move(delta: number) {
    const items = list()
    if (items.length === 0) return
    const next = (selected() + delta + items.length) % items.length
    setSelected(next)
    scroll?.scrollTo(0)
  }

  useBindings(() => ({
    bindings: [
      { key: "up", cmd: () => move(-1) },
      { key: "down", cmd: () => move(1) },
      { key: "k", cmd: () => move(-1) },
      { key: "j", cmd: () => move(1) },
      { key: "pageup", cmd: () => scroll?.scrollBy(-(scroll.height || 10)) },
      { key: "pagedown", cmd: () => scroll?.scrollBy(scroll.height || 10) },
      { key: "r", cmd: () => props.onReload?.() },
    ],
  }))

  return (
    <box gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Workspace Diff
        </text>
        <text fg={theme.textMuted}>
          {`${list().length} file${list().length === 1 ? "" : "s"}`} · ↑↓ files · pgup/pgdn diff · r reload · esc close
        </text>
      </box>

      <Show
        when={!props.loading}
        fallback={
          <box paddingLeft={2} paddingRight={2}>
            <text fg={theme.textMuted}>Loading…</text>
          </box>
        }
      >
        <Show
          when={list().length > 0}
          fallback={
            <box paddingLeft={2} paddingRight={2}>
              <text fg={theme.textMuted}>No changes in working tree.</text>
            </box>
          }
        >
          <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2}>
            <FileList
              files={list()}
              selected={selected()}
              onSelect={(idx) => {
                setSelected(idx)
                scroll?.scrollTo(0)
              }}
            />
            <DiffPane
              file={current()}
              ref={(r) => {
                scroll = r
              }}
            />
          </box>
        </Show>
      </Show>
    </box>
  )
}

function FileList(props: { files: DiffFile[]; selected: number; onSelect: (idx: number) => void }) {
  const { theme } = useTheme()
  const height = createMemo(() => Math.min(Math.max(props.files.length, 6), 20))
  const fileNameWidth = LIST_WIDTH - 14

  return (
    <box width={LIST_WIDTH} flexShrink={0}>
      <scrollbox height={height()} backgroundColor={theme.backgroundElement} scrollbarOptions={{ visible: false }}>
        <For each={props.files}>
          {(item, idx) => {
            const active = () => idx() === props.selected
            return (
              <box
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme.primary : undefined}
                onMouseUp={() => props.onSelect(idx())}
              >
                <box flexDirection="row" minWidth={0} flexShrink={1}>
                  <box width={2} flexShrink={0}>
                    <text fg={active() ? theme.selectedListItemText : theme.textMuted}>{statusLabel(item.status)}</text>
                  </box>
                  <text fg={active() ? theme.selectedListItemText : theme.text} wrapMode="none">
                    {truncateLeft(item.file, fileNameWidth)}
                  </text>
                </box>
                <box flexDirection="row" gap={1} minWidth={7} flexShrink={0} justifyContent="flex-end">
                  <text>
                    {item.additions ? <span style={{ fg: theme.diffAdded }}>+{item.additions}</span> : null}
                    {item.deletions ? <span style={{ fg: theme.diffRemoved }}> -{item.deletions}</span> : null}
                  </text>
                </box>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )
}

function DiffPane(props: { file: DiffFile | undefined; ref: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()

  const lines = createMemo<string[]>(() => {
    const text = props.file?.patch ?? ""
    if (!text) return []
    return text.split(/\r?\n/)
  })

  return (
    <box flexGrow={1} minWidth={0}>
      <Show when={props.file} fallback={<text fg={theme.textMuted}>Select a file to view its diff.</text>}>
        <Show
          when={lines().length > 0}
          fallback={
            <text fg={theme.textMuted}>
              {props.file?.patch === "" ? "Diff truncated or unavailable." : "No diff content."}
            </text>
          }
        >
          <scrollbox
            ref={props.ref}
            height={20}
            backgroundColor={theme.backgroundPanel}
            scrollbarOptions={{ visible: true }}
          >
            <For each={lines()}>{(line) => <DiffLine text={line} />}</For>
          </scrollbox>
        </Show>
      </Show>
    </box>
  )
}

/**
 * Single diff line with `+`/`-`/`@@` colorization. Exported so future preview
 * panes can reuse it without re-deriving the styling table.
 */
export function DiffLine(props: { text: string }) {
  const { theme } = useTheme()
  const text = props.text
  const styled = (() => {
    if (text.startsWith("@@")) return { fg: theme.diffHunkHeader, bg: undefined as RGBA | undefined }
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index "))
      return { fg: theme.textMuted, bg: undefined as RGBA | undefined }
    if (text.startsWith("+")) return { fg: theme.diffAdded, bg: theme.diffAddedBg }
    if (text.startsWith("-")) return { fg: theme.diffRemoved, bg: theme.diffRemovedBg }
    return { fg: theme.text, bg: undefined as RGBA | undefined }
  })()
  return (
    <box backgroundColor={styled.bg} paddingLeft={1} paddingRight={1}>
      <text fg={styled.fg} wrapMode="none">
        {text || " "}
      </text>
    </box>
  )
}

// re-export for convenience
import type { RGBA } from "@opentui/core"
