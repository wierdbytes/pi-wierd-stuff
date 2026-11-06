# @wierdbytes/pi-autoname

Auto-names [pi](https://github.com/earendil-works/pi) sessions and the terminal title with a short summary of what the session is about — the way Claude Code and Codex do.

Pi's own title is `π - <folder>`, so dashboards like [herdr](https://herdr.dev), tmux and terminal tabs can't tell your pi sessions apart. With this extension the title becomes `Fix login redirect loop`, and herdr's agent list reads `dev · Fix login redirect loop`.

## Install

```bash
pi install npm:@wierdbytes/pi-autoname
```

## How it works

- After a turn settles, the first request (and, in `auto` / `follow`, the latest requests plus the last reply) goes to a small model in the background. It never delays the agent.
- The model answers with a 2–6 word name in the language you write in.
- The name goes to the session (`pi.setSessionName()` — `/resume`, footer) and/or the terminal title (`ctx.ui.setTitle()`).
- The call runs in-process through pi's model registry, so any provider you're logged into works (API keys and OAuth, including extension providers such as `@wierdbytes/pi-anthropic`).
- **Manual names win.** A name from `/name`, `--name` or another extension locks auto-naming for the session; the title mirrors it. Clearing the name unlocks it.
- **Resume-safe.** Each generated name is recorded in the session, so a resumed session restores its title without a model call and knows whether its name was generated or yours.
- **Failures.** If the model call fails, the session is named from the first prompt line (optional) and the model is retried next turn. After 3 failures in a row it stops and shows a warning; `/autoname regen` retries.
- Skipped without a UI (`pi -p`, json mode, sub-agents). Ephemeral sessions (`--no-session`) only get the title.

## Commands

| Command | |
|---|---|
| `/autoname` | Settings overlay |
| `/autoname regen` | Name the session from the conversation now (also overrides a manual name) |
| `/autoname status` | Current name, source, model and config path |
| `/autoname on` / `off` | Enable / disable |

## Settings

`~/.pi/agent/@wierdbytes/pi-autoname/settings.json`, editable from `/autoname`:

| Key | Default | |
|---|---|---|
| `enabled` | `true` | Master switch. Off restores pi's own title. |
| `target` | `"both"` | `both` — session name + terminal title; `session` — session name only; `title` — terminal title only |
| `mode` | `"first"` | `first` — name once after the first turn; `auto` — after each turn the model keeps the name (`KEEP`) or picks a new one; `follow` — rename after every turn |
| `model` | `"anthropic/claude-haiku-5-5"` | `provider/id` of the naming model; `""` uses the session model |
| `thinking` | `"off"` | Reasoning effort for the naming model |
| `maxLength` | `40` | Longest name, characters (10–120) |
| `titleTemplate` | `"{name}"` | Terminal title; `{name}` (required), `{cwd}` (folder name), e.g. `"{name} · {cwd}"` |
| `fallback` | `true` | Name from the first prompt line when the model call fails |

`auto` and `follow` make one small model call per turn.
