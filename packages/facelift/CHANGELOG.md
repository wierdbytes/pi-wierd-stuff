# Changelog

## 0.3.0

- Frame primitives (open-right rounded box for `read` / `bash` / `ls` /
  `find` / `grep`) extracted to `@wierdbytes/pi-common/tool-frame`.
  pi-facelift now consumes them as a library so the same chrome can be
  reused by other extensions (e.g. `@wierdbytes/pi-web`).
- Status border colours now follow host theme tokens (`success` →
  `theme.fg("success", …)`, pending → `warning`, error → `error`)
  instead of pi-facelift's previous fixed RGB palette. Visual contract
  is unchanged on the default pi theme; on custom themes the frame
  inherits the user's palette.
- `formatDuration` (the bash bottom-label timer formatter) moved to
  `@wierdbytes/pi-common/tool-frame` so other extensions can reuse it.
  Behaviour unchanged.
- **Fix**: the `read` tool's frame body silently went empty after the
  Phase-2 refactor because `renderFileContent` still referenced the
  deleted `bodyW()` helper, and the highlighter promise's
  `.catch(() => {})` swallowed the resulting `ReferenceError`. The
  width is now computed inline as `termW() - 1` and the catch logs to
  stderr so future regressions in the highlighter pipeline are
  visible. Same `console.error` treatment applied to the matching
  `renderGrepResults` catch.
