# pi-wierd-statusline

Minimal Tokyo Night Storm statusline footer extension for [pi](https://github.com/badlogic/pi-mono).

Replaces the default footer with a single-line status that mirrors a typical
Claude Code statusline command:

```
/Users/me/projects/foo │  main ✓ │ 23%: 38k[▓▓░░░░░░░░]129k │ $0.42
```

Sections:

- **Path** — last three segments, current directory in purple
- **Git** — branch + clean/dirty marker (`✓` / `✗`)
- **Context** — percentage of usable context before autocompaction (33k buffer reserved), current and remaining tokens, with a colored progress bar
- **Cost** — session total when available

Replaces [`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer);
this package skips the bash mode, working vibes, welcome overlay, and
fixed-editor cluster pieces and only wires the footer.

## Install

```bash
pi install npm:pi-wierd-statusline
```

Restart pi to activate.

## Commands

- `/statusline-off` — restore pi's built-in footer for the current session.
- `/statusline-on` — re-enable the wierd statusline.
