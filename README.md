# pi-wierd-stuff

Monorepo for various extensions for the [pi](https://github.com/earendil-works/pi) coding agent.

## Packages

- [`packages/statusline`](packages/statusline) — `@wierdbytes/pi-statusline`: Minimal modular statusline, fully modular block layout — reorder, toggle, and customise the separator from the settings overlay.
- [`packages/web`](packages/web) — `@wierdbytes/pi-web`: Anthropic-powered server-side `web_search` and a Puppeteer + trafilatura `web_fetch` (with optional sub-agent distillation).
- [`packages/anthropic`](packages/anthropic) — `@wierdbytes/pi-anthropic`: Claude Pro/Max OAuth provider.
- [`packages/voice`](packages/voice) — `@wierdbytes/pi-voice`: spoken summary after each agent turn via Gemini 3.1 Flash TTS.
- [`packages/peon`](packages/peon) — `@wierdbytes/pi-peon`: [CESP / OpenPeon](https://openpeon.com/spec) sound-pack player — peons, GLaDOS, battlecruisers, 100+ community packs play on session start, task complete, errors, and other pi lifecycle events.
- [`packages/events`](packages/events) — `@wierdbytes/pi-events`: typed `notify:toast` / `notify:status` event bus that lets any extension surface chips and toasts in the statusline.
- [`packages/common`](packages/common) — `@wierdbytes/pi-common`: shared TUI building blocks for sibling packages — a one-call settings modal (ratatui-style frame, built-in field types, model + reasoning-effort widget), tool-frame helpers, and diff renderers.
- [`packages/facelift`](packages/facelift) — `@wierdbytes/pi-facelift`: cosmetic facelift for built-in pi tool output — open-right rounded frames, syntax-highlighted reads, status-aware bash summaries with execution duration, themed `ls`/`find`/`grep` rendering.
- [`packages/tokyo-night`](packages/tokyo-night) — `@wierdbytes/pi-tokyo-night`: Tokyo Night themes (folke palette) for pi — ships all four variants (`tokyo-night`, `tokyo-night-storm`, `tokyo-night-moon`, `tokyo-night-day`), each mapped to all 51 color tokens.
