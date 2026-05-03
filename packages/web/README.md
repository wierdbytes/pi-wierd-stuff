# pi-wierd-web

Anthropic-powered `web_search` tool for the [pi](https://github.com/badlogic/pi-mono) coding agent.

A one-shot `POST /v1/messages` call backed by Anthropic's server-side
`web_search_20250305` tool. The extension never touches the agent's main turn
stream.

## Tool

### `web_search`

Synthesized answer + citations + raw source list.

Parameters:

- `query` *(required)* — the search query
- `max_uses` — cap on follow-up searches Claude may issue (default 5)
- `allowed_domains` / `blocked_domains` — domain filtering
- `user_location` — `{ type: "approximate", country?, city?, region?, timezone? }`
- `max_tokens` — output token cap for the synthesized answer (default 4096)
- `temperature` — sampling temperature, 0–1

## Auth

Resolved in this order, first hit wins:

1. `PI_WIERD_WEB_API_KEY` environment variable (explicit override).
2. `ctx.modelRegistry.getApiKeyForProvider("anthropic")` — covers stored API
   keys, OAuth refresh-with-locking, and `ANTHROPIC_API_KEY` via pi's
   `AuthStorage`. Same path the agent uses for normal turns, so it inherits
   any `pi.registerProvider("anthropic", { baseUrl })` overrides as long as
   `getApiKeyForProvider` reaches them.
3. `ANTHROPIC_API_KEY` — direct env read, last resort.

OAuth tokens (prefixed `sk-ant-oat`) are detected automatically and trigger
the Claude-Code-stealth header set (`anthropic-beta: claude-code-...,oauth-...`,
`User-Agent: claude-cli/...`, `x-app: cli`) plus the
`"You are Claude Code, ..."` system block. `claude-3-5-haiku*` models skip
the Claude Code identity block, matching pi-mono's built-in carve-out.

## Install

```bash
pi install npm:pi-wierd-web
```

Restart pi to activate. Verify with `/wierd-web status`.

## Commands

- `/wierd-web status` — print active model and auth source
- `/wierd-web model <id>` — set the model used for the tool (persisted to
  the current session branch)
- `/wierd-web reset` — restore env defaults

## CLI flags

- `--wierd-web-model <id>` — boot-time model override

## Environment

- `PI_WIERD_WEB_API_KEY` — explicit Anthropic credential (API key or OAuth)
- `PI_WIERD_WEB_MODEL` — default model (defaults to `claude-haiku-4-5`)
- `PI_WIERD_WEB_BASE_URL` — override the Anthropic base URL (proxies / regional
  endpoints). Defaults to `https://api.anthropic.com`.

## Architecture

| File           | Responsibility                                                                |
| -------------- | ----------------------------------------------------------------------------- |
| `index.ts`     | Extension entry: tool registration, `/wierd-web` command, state persistence   |
| `anthropic.ts` | Auth resolution, header builder, single `POST /v1/messages` transport         |
| `search.ts`    | `web_search` tool definition + response parser + LLM-facing formatter         |
| `render.ts`    | TUI renderers (`renderCall` / `renderResult`)                                 |
| `types.ts`     | Shared types + minimal raw API content-block shapes                           |
