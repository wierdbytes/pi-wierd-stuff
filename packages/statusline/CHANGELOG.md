# Changelog

## 0.9.2

- **Fix:** no blank rows under the prompt in fullscreen mode — the input is the last terminal row and grows only with its text.

## 0.9.1

- **New:** ship `CHANGELOG.md` — pi shows release notes under "Extension Updates" after an update.

## 0.9.0

- **Removed:** fixed editor cluster and its `fixed-editor` / `mouse-scroll` options.
- **Fix:** mouse and alt screen disabled after `/resume`, `/new` or `/reload`.

## 0.8.3

- **New:** `/warmer` forces prompt-cache warming for the current session; indicator shown after the cache timer.

## 0.8.2

- **Change:** cache colors retuned — hit rate green from 98.0%, gray savings, timer yellow from 0:30.

## 0.8.1

- **Change:** cache expiry timer gray above 2:00.

## 0.8.0

- **New:** prompt-cache block — hit rate, savings vs. no-cache cost, expiry countdown; replaces the tokens block (migrated in place).
- **Breaking:** requires pi ≥ 1.0.0.

## 0.7.2

- **Fix:** context block shows pi's real context usage instead of the autocompact estimate; `?` while unknown after compaction.

## 0.7.1

- **Change:** improved thinking effort colors.

## 0.7.0

- **New:** modular layout — reorderable blocks with per-block visibility and configurable separator in the Layout tab.

## 0.6.4

- **Change:** reworded package description.

## 0.6.3

- **Change:** fixed editor off by default.

## 0.6.2

- **New:** terminal-friendly icon sets (`nerd-font` default, `plain`, `ascii`, `minimal`, `emoji`) via `/statusline icons` or the Display tab.

## 0.6.1

- **Change:** slash command renamed `/wierd-status` → `/statusline`.

## 0.6.0

- **Change:** `/wierd-status` opens a settings modal (Display, Toasts, Subagents); display toggles persist across restarts.

## 0.5.1

- **Change:** first release under the `@wierdbytes/pi-statusline` name (was `pi-wierd-statusline`).

## 0.5.0

- **New:** `notify:*` events rendered as status chips and a toast row.

## 0.4.3

- **Change:** pi footer renders under the editor in the fixed editor cluster.

## 0.4.2

- **Docs:** README refreshed with a demo screenshot.

## 0.4.1

- **Fix:** thinking level respects the model's `thinkingLevelMap`.

## 0.4.0

- **New:** editor stash — `Alt+S` stash / pop, `Ctrl+Alt+S` picker, auto-restore on `agent_end`, persisted history.

## 0.3.2

- **Change:** dropped the prompt glyph and padding inside the editor.

## 0.3.1

- **Change:** 1-line mouse wheel scroll precision.

## 0.3.0

- **New:** fixed editor cluster — chat scrolls above a pinned statusline and editor; mouse wheel / PageUp / PageDown scrolling.

## 0.2.0

- **New:** statusline moved above the editor; `/wierd-status` command; pi's built-in footer hidden by default.

## 0.1.0

- **New:** Tokyo Night statusline — model, thinking level, path, git, context, cost, tokens.
