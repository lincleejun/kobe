/**
 * Border presets for kobe panes.
 *
 * Lifted unchanged from `refs/opencode/packages/opencode/src/cli/cmd/tui/component/border.tsx`.
 * `EmptyBorder` is the "no chrome" preset; `SplitBorder` draws a solid vertical
 * `┃` between adjacent panes, used everywhere a pane separator is wanted
 * without the rest of a box border.
 */

export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}
