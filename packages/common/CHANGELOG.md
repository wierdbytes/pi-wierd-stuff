# Changelog

## 0.4.0

- Add `@wierdbytes/pi-common/diff` — Shiki-powered split / unified
  diff renderer ported from `@heyhuynhgiabuu/pi-diff`. Public API:
  `parseDiff`, `renderSplit`, `renderUnified`, `hlBlock`,
  `resolveDiffColors`, `applyDiffPalette`, `lang`, `summarize`,
  `themeCacheKey`, plus types `ParsedDiff`, `DiffLine`, `DiffColors`,
  `DiffLayout`, `DiffLayoutPreference`, `DiffRenderOptions`.
  Designed to be wrapped in an outer frame: pass
  `{ frameless: true }` to skip the standalone top/bottom rule
  lines so the diff slots cleanly into
  `@wierdbytes/pi-common/tool-frame`.
- GitHub-style layout: row tint (red/green/base) fills the entire
  row end-to-end with no `│` divider, no `▌` border bar, and no
  gutter→code split. Per-row gutter is
  `<lead 1><num nw><gap 1><sign 1><gap 2>`. Word-level emphasis
  (`BG_DEL_W` / `BG_ADD_W`) is layered on changed character ranges
  of paired 1:1 del/add lines via `Diff.diffWords`.
- `RST` stays a plain `\x1b[0m` (no baked-in `BG_BASE`) so the
  trailing tint never leaks past the diff body into the next line
  rendered by the caller (e.g., the bottom border of an outer
  frame).
- `renderSplit`'s row padding uses `\x1b[49m` for the residual
  right-edge column on odd terminal widths, so the body line
  visually terminates where the frame chrome above/below does.
- Layout override: `renderSplit({ layout: 'split' | 'unified' })`
  bypasses the wrap-fit heuristic. Public `canRenderSplit(diff,
  width, maxLines)` helper for callers that need to decide a layout
  across multiple diffs in one pass.
- Adds `diff` (`^8.0.2`) and `@shikijs/cli` (`^4.0.2`) as runtime
  dependencies.

## 0.3.0

- Add `@wierdbytes/pi-common/tool-frame` — open-right rounded box
  helpers extracted from `@wierdbytes/pi-facelift`. Use these to
  decorate `renderShell: "self"` tool output with a status-coloured
  frame (corners, rail, multi-line title sub-tree, optional
  inline bottom-border label). Status colours come from host theme
  tokens (`success` / `warning` / `error`).
- Body helpers (`frameBodyLines`, `frameResult`,
  `frameResultWithBottomLabel`, `renderToolError`) accept an
  `options.paddingX` knob — pass `1` to render `│ <content>` with a
  one-column gap between rail and body. Default `0` preserves the
  existing tight layout.
- Export `formatDuration(ms)` — compact `3.3s` / `1m3s` / `2h5m`
  helper, previously private to pi-facelift's bash renderer. Reused by
  `@wierdbytes/pi-web` for live elapsed-time bottom-labels.
