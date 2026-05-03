# pi-wierd-statusline

Minimal Tokyo Night Storm statusline footer extension for [pi](https://github.com/badlogic/pi-mono).

Renders the statusline directly into the editor's top border (replacing it),
and prepends a `❱ ` prompt glyph to the input field:

```
🤖 opus-4-7 🧠 high │ /Users/me/projects/foo │  main ✓ │ 23%: 38k[▓▓░░░░░░░░]129k │ $0.42 │ ↑38k ↓1.2k R5.7M W194k
❱ your prompt here
```

Sections:

- **Path** — last three segments, current directory in purple
- **Git** — branch + clean/dirty marker (`✓` / `✗`)
- **Context** — percentage of usable context before autocompaction (33k buffer reserved), current and remaining tokens, with a colored progress bar
- **Cost** — session total when available

Replaces [`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer);
this package skips the bash mode, working vibes, and welcome overlay pieces
and only wires the footer plus an optional fixed editor cluster.

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
