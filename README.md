# pi-wierd-stuff

Monorepo for various extensions for the [pi](https://github.com/badlogic/pi-mono) coding agent.

## Packages

- [`packages/statusline`](packages/statusline) — `pi-wierd-statusline`: minimal Tokyo Night statusline footer.
- [`packages/web`](packages/web) — `pi-wierd-web`: Anthropic-powered `web_search` / `web_fetch` tools.
- [`packages/anthropic`](packages/anthropic) — `pi-wierd-anthropic`: Claude Pro/Max OAuth provider.
- [`packages/voice`](packages/voice) — `pi-wierd-voice`: spoken summary after each agent turn via Gemini 3.1 Flash TTS.
- [`packages/events`](packages/events) — `pi-wierd-events`: typed `notify:toast` / `notify:status` event bus that lets any extension surface chips and toasts in the statusline.
