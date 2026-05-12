# Changelog

## 0.3.2

- **Change**: `bash` tool titles always render the full command, even
  in collapsed view. Previously the multi-line command string was
  sliced at 80 chars (with a trailing `…`) before being split into
  sub-tree continuation rows, which clobbered the second line of
  short multi-step commands like
  `tmux kill-session -t poc 2>/dev/null\nrm -f /Users/.../poc/long-path`.
  Per-line right-truncation inside `frameTop` is unchanged — lines
  that genuinely overflow the terminal width are still clipped — so
  the only behavior change is that long commands no longer hide
  content behind the expand toggle.

## 0.3.1

- **Fix**: `read` bodies rendered as plain uncolored text whenever
  pi's `settings.theme` was a name Shiki doesn't ship (e.g.
  `tokyo-night-storm`). pi-facelift forwarded the raw value to
  Shiki's `codeToANSI`, which threw, and `hlBlock`'s `catch` block
  silently fell back to plain `code.split("\n")` — leaving frame
  chrome and line numbers but no syntax highlighting.
  Three changes land together:
  1. The resolved theme is now validated against Shiki's
     `bundledThemes` set; unknown names fall back to
     `DEFAULT_THEME` (`github-dark`) instead of being passed through.
  2. Common pi/host theme aliases are mapped to their nearest Shiki
     bundled equivalent (`tokyo-night-storm` → `tokyo-night`,
     `catppuccin` → `catppuccin-mocha`, `material-darker` →
     `material-theme-darker`, `gruvbox-dark` → `gruvbox-dark-medium`,
     `solarized` → `solarized-dark`, `one-dark` → `one-dark-pro`,
     and Tokyo Night/Material/Catppuccin variants). Lookup is
     case-insensitive.
  3. The `hlBlock` catch now logs once per `(theme, language)` to
     stderr (instead of swallowing every error forever) so future
     regressions in the highlighter pipeline surface during dev.
  A one-shot `console.error` is also emitted the first time an
  unknown theme name is rejected, advertising `FACELIFT_THEME` as the
  override knob.

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
