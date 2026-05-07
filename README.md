# pi-wierd-stuff

Monorepo for various extensions for the [pi](https://github.com/badlogic/pi-mono) coding agent.

## Packages

- [`packages/statusline`](packages/statusline) — `@wierdbytes/pi-statusline`: minimal Tokyo Night statusline footer.
- [`packages/web`](packages/web) — `@wierdbytes/pi-web`: Anthropic-powered `web_search` / `web_fetch` tools.
- [`packages/anthropic`](packages/anthropic) — `@wierdbytes/pi-anthropic`: Claude Pro/Max OAuth provider.
- [`packages/voice`](packages/voice) — `@wierdbytes/pi-voice`: spoken summary after each agent turn via Gemini 3.1 Flash TTS.
- [`packages/events`](packages/events) — `@wierdbytes/pi-events`: typed `notify:toast` / `notify:status` event bus that lets any extension surface chips and toasts in the statusline.
