# pi-wierd-web

Web tools for the [pi](https://github.com/badlogic/pi-mono) coding agent:

- **`web_search`** — Anthropic-powered server-side search with citations.
- **`web_fetch`** — headless-Chrome fetch + trafilatura extraction, with
  optional sub-agent distillation. Ported from
  [pi-web-fetch](https://github.com/georgebashi/pi-web-fetch) (hooks/extension
  system intentionally omitted).

## Tools

### `web_search`

A one-shot `POST /v1/messages` call backed by Anthropic's server-side
`web_search_20250305` tool. Returns a synthesized answer + citations + raw
source list. Never touches the agent's main turn stream.

Parameters:

- `query` *(required)* — the search query
- `max_uses` — cap on follow-up searches Claude may issue (default 5)
- `allowed_domains` / `blocked_domains` — domain filtering
- `user_location` — `{ type: "approximate", country?, city?, region?, timezone? }`
- `max_tokens` — output token cap for the synthesized answer (default 4096)
- `temperature` — sampling temperature, 0–1

### `web_fetch`

Fetches one or more URLs through headless Chrome, extracts the main content
as markdown via [trafilatura](https://trafilatura.readthedocs.io/), and
optionally distills the result with a pi sub-agent.

Parameters:

- `url` — single URL to fetch (mutually exclusive with `pages`)
- `prompt` — optional extraction prompt. When set, the page content is
  processed by a fast LLM and only the relevant parts are returned. Omit for
  the full extracted markdown.
- `pages` — array of `{ url, prompt? }` (max 10) for concurrent batch
  fetching with live per-URL progress.

Behavior:

- HTTP URLs are auto-upgraded to HTTPS.
- Cross-host redirects are surfaced rather than followed; make a second
  call to the redirect target.
- Pages are cached in-memory for 15 minutes — repeated questions about the
  same page are cheap.
- Pages larger than ~50KB are auto-summarized (when a model is available)
  to a structured overview when no prompt is provided.
- Browser pool keeps Chrome warm: one shared instance, up to 6 concurrent
  tabs, idle-shutdown after 60s.

Prerequisites for `web_fetch`:

- A Python tool runner (auto-detected, in priority order):
  1. [uv](https://docs.astral.sh/uv/) (`uvx`) — fastest, recommended
  2. `uv run` — fallback if `uvx` alias is missing
  3. [pipx](https://pipx.pypa.io/) — widely available on Debian/Ubuntu
  4. [pip-run](https://github.com/jaraco/pip-run) — niche fallback
- Puppeteer's bundled Chromium is downloaded on first install (~300MB).
  Set `PUPPETEER_EXECUTABLE_PATH` to skip the download and use an existing
  Chrome/Chromium binary.

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

## Configuration

Settings persist at `~/.pi/agent/wierd-web.json`. The file is created on
first run, seeded from environment variables. Shape:

```json
{
  "searchModel": "claude-haiku-4-5",
  "fetchModel": "anthropic/claude-haiku-4-5",
  "fetchThinkingLevel": "medium"
}
```

- `searchModel` — Anthropic model used by `web_search`.
- `fetchModel` — provider/model id for the `web_fetch` sub-agent. If unset,
  falls back to the current session model.
- `fetchThinkingLevel` — thinking level for the `web_fetch` sub-agent. If
  unset, falls back to the current session thinking level.

## Commands

- `/wierd-web status` — print models, thinking level, auth source, config path
- `/wierd-web model <id>` (alias: `search-model`) — set `searchModel`
- `/wierd-web fetch-model <provider/model-id>` — set `fetchModel`
- `/wierd-web fetch-thinking <level>` — set `fetchThinkingLevel`
- `/wierd-web reset` — wipe config, re-seed from env

## CLI flags

- `--wierd-web-model <id>` — boot-time `searchModel` override

## Environment

- `PI_WIERD_WEB_API_KEY` — explicit Anthropic credential (API key or OAuth)
- `PI_WIERD_WEB_MODEL` — default `searchModel` (falls back to `claude-haiku-4-5`)
- `PI_WIERD_WEB_FETCH_MODEL` — default `fetchModel` for `web_fetch`
- `PI_WIERD_WEB_FETCH_THINKING` — default `fetchThinkingLevel`
- `PI_WIERD_WEB_BASE_URL` — override the Anthropic base URL (proxies / regional
  endpoints). Defaults to `https://api.anthropic.com`.
- `PUPPETEER_EXECUTABLE_PATH` — use an existing Chrome/Chromium binary
  instead of puppeteer's bundled download.

## Tests

```bash
bun --filter pi-wierd-web test
```

## Architecture

| File                 | Responsibility                                                              |
| -------------------- | --------------------------------------------------------------------------- |
| `index.ts`           | Extension entry: tool registration, `/wierd-web` command, lifecycle hooks   |
| `config.ts`          | Load/save `~/.pi/agent/wierd-web.json`, env seeding                          |
| `anthropic.ts`       | Auth resolution, header builder, single `POST /v1/messages` transport       |
| `search.ts`          | `web_search` tool definition + response parser + LLM-facing formatter       |
| `render.ts`          | `web_search` TUI renderers                                                  |
| `types.ts`           | `web_search` types + minimal raw API content-block shapes                   |
| `fetch.ts`           | `web_fetch` tool definition + cache + pipeline + batch executor             |
| `fetch-render.ts`    | `web_fetch` TUI renderers (per-URL status, collapsed/expanded result)       |
| `fetch-types.ts`     | `web_fetch` internal types                                                  |
| `browser-pool.ts`    | Shared puppeteer browser, lazy launch, max-tabs queueing, idle shutdown     |
| `extract.ts`         | Python-runner detection, trafilatura subprocess, timeout helpers            |
| `subagent.ts`        | Spawns `pi --mode json` sub-agent for distillation/summarization            |
