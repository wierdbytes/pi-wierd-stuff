# Changelog

## 0.4.0

- **New**: GitHub-style split/unified diff renderer for the `write`
  and `edit` tools, ported from `@heyhuynhgiabuu/pi-diff` and rebuilt
  on `@wierdbytes/pi-common/diff` so the body slots cleanly inside
  the facelift open-right frame. Each edit in a multi-edit call gets
  its own `Edit i/N` block with the per-edit summary; the overall
  `+A -B (M diff lines)` summary sits in the bottom border. Word-
  level emphasis (`Diff.diffWords`) is layered on paired 1:1
  del/add lines.
- **New**: per-edit line-number shifting. `parseDiff` only sees a
  snippet, so a previous pass numbered every edit from line 1
  regardless of where it lived in the file. Now the wrapper
  snapshots the file before `execute`, resolves each `oldText` via
  `indexOf`, and shifts `oldNum`/`newNum` accordingly. A
  `cumulativeDelta` keeps multi-edit new-side numbers consistent for
  the common in-order case.
- **New**: persistent per-package config at
  `~/.pi/agent/wierd-facelift/config.json` (or
  `${PI_AGENT_DIR}/wierd-facelift/config.json`). Schema today is just
  `{ diffLayout: 'consistent' | 'split' | 'unified' | 'per-edit' }`
  but designed to accept more knobs without breaking older files.
  Sanitised on every load — hand-edits with typos fall back to
  defaults.
- **New**: `/facelift` slash command — bare invocation opens a
  `@wierdbytes/pi-common`-backed settings overlay (matches
  `/voice` / `/web` look). Subcommands: `status` prints config +
  path, `reset` restores defaults.
- **Change**: `consistent` is the default `diffLayout`. All edits in
  one tool call share one layout: split iff every diff fits without
  excessive line wrapping, otherwise unified for all. Stops
  `Edit 1 split, Edit 2 unified` mixed renders. `DIFF_LAYOUT=...` env
  var seeds the config on first run.
- **Fix**: bottom frame border no longer inherits the diff body's
  background. The diff module's `RST` no longer carries `BG_BASE`
  through trailing newlines, so the closing `╰──…` of the open-right
  frame stays on the same bg as the opening `╭──…`.
- **Fix**: right-edge "notch" in split rows on odd terminal widths.
  Each row is padded with one `\x1b[49m` cell so its visible width
  always matches the frame chrome above/below.
- **Dep**: bumps `@wierdbytes/pi-common` from `^0.3.0` to `^0.4.0`
  (for the new `/diff` subpath). No env-only knobs were removed;
  the only retained env var is `DIFF_LAYOUT` (one-shot seed).

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
