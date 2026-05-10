/**
 * Wave 4.B follow-up — inline Edit/Write diff helpers for the chat
 * `ToolRow`.
 *
 * Pattern lifted from upstream Claude Code:
 *   - `refs/claude-code/src/components/FileEditToolUpdatedMessage.tsx`
 *     — the "Added N lines, removed M lines" header + per-hunk diff
 *     list, displayed inline below the tool banner instead of as a
 *     generic `Edit({...})` chip.
 *   - `refs/claude-code/src/components/FileEditToolDiff.tsx`
 *     — the input shape (`{file_path, old_string, new_string}`) and
 *     the "diff the inputs we already have" fallback path. kobe's chat
 *     does NOT have access to the on-disk file content (the orchestrator
 *     ships only the tool's `input` blob over the engine event stream)
 *     so we always run the inputs-only path. Result: simpler than
 *     upstream's `StructuredDiffList` (no AST/structuredPatch needed) —
 *     just a flat list of removed/added lines with leading prefix.
 *
 * The helper is a pure function so it can be unit-tested without
 * mounting opentui. The caller (`MessageList.tsx`) is the only place
 * that consumes its output and renders Solid `<text>` rows.
 */

/** A single styled line emitted by the diff helpers. */
export type DiffLine =
  | { readonly kind: "header"; readonly text: string }
  | { readonly kind: "remove"; readonly text: string }
  | { readonly kind: "add"; readonly text: string }
  | { readonly kind: "ellipsis"; readonly text: string }

/** Output of the formatters consumed by `ToolRow`. */
export interface FormattedDiff {
  /** "Edited /abs/path · Added N lines, removed M lines" header. */
  readonly header: string
  /** All -lines (full set; truncate at render time using `collapsed`). */
  readonly removes: readonly string[]
  /** All +lines (full set; truncate at render time using `collapsed`). */
  readonly adds: readonly string[]
}

/** Visible-line cap per side when the row is collapsed. Matches the */
/* upstream "condensed" preview cap — keeps the chat skim-readable for */
/* large edits but still shows the shape of the change. */
export const COLLAPSED_LINE_CAP = 10

/**
 * Format an Edit tool input (`{file_path, old_string, new_string}`) into
 * a header + add/remove line lists.
 *
 * Returns a non-null result for any input shape — even malformed ones
 * (missing `file_path`, non-string `old_string`/`new_string`) — so the
 * renderer can always rely on a deterministic structure. Bad fields
 * become empty strings; the empty arrays render as a degenerate "no
 * changes" diff which is rare but still less surprising than throwing.
 */
export function formatEditDiff(input: unknown): FormattedDiff {
  const { file_path, old_string, new_string } = readEditInput(input)
  const removes = old_string.length > 0 ? old_string.split(/\r?\n/) : []
  const adds = new_string.length > 0 ? new_string.split(/\r?\n/) : []
  return {
    header: makeHeader(file_path, "Edited", adds.length, removes.length),
    removes,
    adds,
  }
}

/**
 * Format a Write tool input (`{file_path, content}`) as an all-additions
 * diff. Mirrors upstream's "new file" preview — every line is a `+`,
 * no removes.
 */
export function formatWriteDiff(input: unknown): FormattedDiff {
  const { file_path, content } = readWriteInput(input)
  const adds = content.length > 0 ? content.split(/\r?\n/) : []
  return {
    header: makeHeader(file_path, "Wrote", adds.length, 0),
    removes: [],
    adds,
  }
}

/**
 * Apply the collapsed-row cap to either side of a {@link FormattedDiff}.
 * Returns the truncated lines plus the count of hidden lines (0 when
 * the side fits inside the cap). The renderer uses this to decide
 * whether to emit a `… N more lines` ellipsis row.
 */
export function capLines(
  lines: readonly string[],
  cap: number,
): { readonly visible: readonly string[]; readonly hidden: number } {
  if (cap < 0 || lines.length <= cap) return { visible: lines, hidden: 0 }
  return { visible: lines.slice(0, cap), hidden: lines.length - cap }
}

/* ---------------------------------------------------------------- */
/*  internals                                                        */
/* ---------------------------------------------------------------- */

function readEditInput(input: unknown): { file_path: string; old_string: string; new_string: string } {
  if (input == null || typeof input !== "object") {
    return { file_path: "", old_string: "", new_string: "" }
  }
  const o = input as Record<string, unknown>
  return {
    file_path: typeof o.file_path === "string" ? o.file_path : "",
    old_string: typeof o.old_string === "string" ? o.old_string : "",
    new_string: typeof o.new_string === "string" ? o.new_string : "",
  }
}

function readWriteInput(input: unknown): { file_path: string; content: string } {
  if (input == null || typeof input !== "object") {
    return { file_path: "", content: "" }
  }
  const o = input as Record<string, unknown>
  return {
    file_path: typeof o.file_path === "string" ? o.file_path : "",
    content: typeof o.content === "string" ? o.content : "",
  }
}

/**
 * "Edited /path · Added 3 lines, removed 1 line" — phrasing mirrors
 * `FileEditToolUpdatedMessage`'s "Added N lines, removed M lines" but
 * with a verb prefix and the file path so the row stands on its own
 * (the chat banner above it shows the tool name, not the file).
 *
 * When both counts are zero we still emit "Edited <path>" — the
 * renderer never produces an empty header.
 */
function makeHeader(filePath: string, verb: string, adds: number, removes: number): string {
  const path = filePath || "(unknown file)"
  const parts: string[] = []
  if (adds > 0) {
    parts.push(`Added ${adds} ${adds === 1 ? "line" : "lines"}`)
  }
  if (removes > 0) {
    const word = adds === 0 ? "Removed" : "removed"
    parts.push(`${word} ${removes} ${removes === 1 ? "line" : "lines"}`)
  }
  if (parts.length === 0) return `${verb} ${path}`
  return `${verb} ${path} · ${parts.join(", ")}`
}
