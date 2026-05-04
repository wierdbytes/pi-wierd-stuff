# pi-wierd-statusline

Minimal Tokyo Night Storm statusline for [pi](https://github.com/badlogic/pi-mono).
Renders a compact one-line status row above the editor, with the editor's
own top/bottom borders stripped so the two visually merge into a single
cluster.

![pi-wierd-statusline demo](./assets/demo.png)

Sections (each appears only when relevant):

- **Model** — `🤖` plus the active model's display name (e.g. `Opus 4.7`).
  `Claude ` and `anthropic/` prefixes are stripped for brevity.
- **Thinking** — `🧠` plus the current thinking level (`min`/`low`/`med`/`high`/`xhigh`),
  shown only for reasoning-capable models. Honors the model's
  `thinkingLevelMap` so providers can override the label.
- **Path** — up to the last three segments of `cwd` with a `…/` prefix.
  Parent segments in gray, current directory in purple.
- **Git** — branch name plus a clean/dirty marker (`✓` green / `✗` red).
  Hidden when not in a git repo.
- **Context** — percentage of usable context window before autocompaction
  (33k buffer reserved), printed as `pct%: used[▓░░░]remaining` with a
  colored progress bar. Color shifts green → yellow → red as you approach
  the threshold.
- **Cost** — session total in USD when greater than zero.
- **Tokens** — cumulative session input/output and cache read/write
  counters: `↑input ↓output R{cacheRead} W{cacheWrite}`.
- **Stash** — `📦 N` showing how many prompts are saved in the stash history
  (see below). Hidden when empty.

Inspired by [`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer)
by [@nicobailon](https://github.com/nicobailon) — the original brought the
statusline-as-footer idea to pi. This extension is a from-scratch take that
focuses on just that footer (skipping the bash mode, working vibes, and
welcome overlay pieces).

## Editor stash

Press `Alt+S` to save the editor's contents and clear the input, type a quick
prompt, and the stashed text auto-restores when the agent finishes — but only
if the editor is empty at that point (otherwise the stash is preserved and a
notification reminds you to clear and `Alt+S` to restore). Pressing `Alt+S`
again with text in the editor *updates* the live stash slot. The statusline's
`📦 N` indicator reflects the current stash-history depth.

Every stash is pushed onto a persisted MRU history (12 entries max, stored at
`~/.pi/agent/wierd-statusline/stash-history.json`). Press `Ctrl+Alt+S` to
open a picker overlay; navigate with arrows, `Enter` inserts the selected
entry (replace/append/cancel prompt if the editor is non-empty), `d` deletes
the selected entry, and `Esc` cancels.

## Fixed editor cluster

In interactive TUI sessions, chat/feed content scrolls above the fixed
statusline, editor, and any extension-supplied widget rows. Scroll chat with
the mouse wheel, PageUp/PageDown, Command+PageUp/PageDown, or Ctrl+Shift+Up/Down;
the editor stays put. Drag text to copy it, drag a selection to the viewport
edge to scroll, double-click a line to select it, and right-click to open the
terminal context menu. Use `/wierd-status fixed-editor off` for pi's regular
scrolling layout, or `/wierd-status mouse-scroll off` for native terminal
selection.

## Install

```bash
pi install npm:pi-wierd-statusline
```

Restart pi to activate.

## Commands

- `/wierd-status on` — enable the statusline
- `/wierd-status off` — disable, restoring pi's default editor and footer
- `/wierd-status toggle` — toggle
- `/wierd-status footer on|off|toggle` — show/hide pi's built-in footer beneath the editor (hidden by default)
- `/wierd-status fixed-editor on|off|toggle` — keep the editor cluster fixed at the bottom while chat scrolls above (on by default)
- `/wierd-status mouse-scroll on|off|toggle` — enable wheel/drag scrolling and selection inside the fixed editor (on by default)

## Shortcuts

- `Alt+S` — stash editor text / restore stash when editor is empty
- `Ctrl+Alt+S` — open the stash history picker
