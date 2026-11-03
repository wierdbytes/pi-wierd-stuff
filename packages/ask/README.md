# @wierdbytes/pi-ask

Interactive `ask_user` clarification tool for the
[pi](https://github.com/earendil-works/pi) coding agent: the agent pauses,
asks structured questions in a terminal UI, and continues with normalized
answers instead of guessing.

Fork of [`@eko24ive/pi-ask`](https://github.com/eko24ive/pi-ask) 1.2.0 by
eko24ive (MIT). Same tool, commands and UI, plus:

- **Blocked status for agent dashboards.** While a form is open, pi reports
  itself as `blocked` on a `question` via
  [program status (OSC 7501)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/terminal-setup.md#program-status),
  so [herdr](https://herdr.dev), Rex and other OSC 7501 terminals play their
  "needs you" alert instead of showing the agent as `working`. Needs
  pi >= 1.5.0; older pi just ignores it.

## Install

```bash
pi remove npm:@eko24ive/pi-ask   # both register ask_user — keep only one
pi install npm:@wierdbytes/pi-ask
```

## What you get

- `ask_user` tool — tabbed single / multi / preview questions,
  `(recommended)` markers, inline "Type your own" answers, `@` file
  references, option and question notes, a review tab with
  Submit / Elaborate / Cancel.
- `/ask-settings` — toggle behaviour and notifications, show the config path,
  reset to defaults (also `?` inside a form).
- `/answer` — extract questions the agent asked in plain text from its last
  message into a form; `/answer:again` reopens the latest one.
- `/ask:replay` — reopen the latest `ask_user` form on the current branch.
- Recovery of an unanswered `ask_user` form after startup, resume or fork.
- Bundled `ask-user` skill that tells the agent when to ask (disable via
  `pi config`).

## Config

`~/.pi/agent/@wierdbytes/pi-ask/settings.json` — keymaps, behaviour,
notifications (`bell`, `osc9`, `osc777`) and `/answer` extraction models.
Created with defaults on first use.

Full reference: [`docs/configuration.md`](docs/configuration.md). The agent
reads it when you ask it to tweak pi-ask settings.

## Remote events

Trusted in-process extensions can watch and answer forms over `pi.events`:
`@wierdbytes/pi-ask:started`, `:completed`, `:submit`, `:submit-result`.
Upstream bridges listening on `@eko24ive/pi-ask:*` need the new prefix. See
[`docs/remote-events.md`](docs/remote-events.md).

## Docs

- [`docs/contract.md`](docs/contract.md) — tool input/output and UX guarantees
- [`docs/configuration.md`](docs/configuration.md) — config file reference
- [`docs/remote-events.md`](docs/remote-events.md) — `pi.events` bridge contract

## Development

```bash
bun run test
pi -e ./index.ts
```

## License

MIT — © eko24ive (original `@eko24ive/pi-ask`), © wierdbytes (fork changes).
