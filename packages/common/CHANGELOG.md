# Changelog

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
