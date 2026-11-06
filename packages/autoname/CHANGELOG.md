# Changelog

## 0.1.0

- **New:** auto-name sessions and the terminal title with a short summary from a cheap model (`anthropic/claude-haiku-5-5` by default) — herdr, tmux and terminal tabs show what each pi is doing.
- **New:** `/autoname` settings — apply to session / title / both, update `first` / `auto` / `follow`, model + reasoning effort, max length, title template, prompt-line fallback.
- **New:** `/autoname regen`, `/autoname status`, `/autoname on|off`.
- **New:** names set with `/name` or by other extensions are never overwritten; the title mirrors them.
