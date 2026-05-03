# Plan: `pi-wierd-web` extension — Anthropic-powered `web_search` + `web_fetch`

Adds two LLM-callable tools to `pi-mono`'s coding-agent via a standalone extension package, both backed by Anthropic's server-side tools (`web_search_20250305` and `web_fetch_20250910`). One-shot Messages API call per tool invocation, no agent-loop coupling.

- **Target consumer**: `~/me/dev/pi-mono/packages/coding-agent` (extension API surface in `src/core/extensions/`).
- **Plan location**: `~/me/dev/pi-wierd-stuff/docs/plans/anthropic-web-search-fetch.md` (this file).
- **New package**: `~/me/dev/pi-wierd-stuff/packages/web` → published as `pi-wierd-web`.
- **Reference implementation**: `~/me/dev/oh-my-pi/packages/coding-agent/src/web/search/providers/anthropic.ts` (for the search side; fetch is new).
- **Reference packaging**: `~/me/dev/pi-wierd-stuff/packages/statusline/` (extension manifest, npm layout, `pi.extensions` field).

## 1. Scope

### In scope
- Two custom tools registered via `pi.registerTool()`:
  - `web_search` — Claude-synthesized answer + sources + citations for a query.
  - `web_fetch` — fetch one URL with optional follow-up question; returns extracted content + citations.
- Anthropic auth via, in order:
  1. `ctx.modelRegistry.getApiKeyForProvider("anthropic")` (covers stored API key + OAuth refresh + env var, all already handled by `AuthStorage` in `packages/coding-agent/src/core/auth-storage.ts`).
  2. Explicit override env vars `PI_WIERD_WEB_API_KEY` / `ANTHROPIC_API_KEY`.
- TUI renderers (`renderCall` + `renderResult`) styled to match `pi-wierd-statusline`'s palette.
- Configurable model (default `claude-haiku-4-5`), max_tokens, temperature, allowed/blocked domains, max_uses.
- One slash command `/wierd-web` for runtime status / model switch / cache clear.

### Out of scope
- Streaming partial results into the TUI. Both tools resolve once the Messages call completes.
- Multi-provider fallback (Exa, Perplexity, etc.). This package is Anthropic-only by design; pick a different extension if you want a chain.
- Re-implementing Anthropic streaming. The agent-facing turn already streams via the built-in provider; these are *side-channel* HTTP calls.
- Persisting search/fetch history to disk.

## 2. Anthropic API contracts

Both are **server-side tools**: list them under `tools[]` on `POST /v1/messages`, send a single user `messages[0]` containing the request, parse content blocks back. No second round-trip needed for a single search/fetch.

### 2.1 `web_search` (GA — `web_search_20250305`)

Request payload (minimum):
```json
{
  "model": "claude-haiku-4-5",
  "max_tokens": 4096,
  "messages": [{"role": "user", "content": "<query>"}],
  "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}]
}
```

Optional knobs to expose: `allowed_domains`, `blocked_domains`, `user_location`, `max_uses`.

Response content blocks to demux (already proven in oh-my-pi):
- `server_tool_use` (`name === "web_search"`) → intermediate queries Claude issued.
- `web_search_tool_result` → array of `{type: "web_search_result", title, url, page_age}` → flatten into sources.
- `text` with `citations[]` → synthesized answer + per-span `{url, title, cited_text}`.

Usage extras: `usage.server_tool_use.web_search_requests`.

### 2.2 `web_fetch` (beta — `web_fetch_20250910`)

Required header: `anthropic-beta: web-fetch-2025-09-10`. Append to the existing beta list, do not replace. Tool definition:
```json
{
  "type": "web_fetch_20250910",
  "name": "web_fetch",
  "max_uses": 1,
  "max_content_tokens": 100000,
  "citations": {"enabled": true},
  "allowed_domains": ["..."],
  "blocked_domains": ["..."]
}
```

Two invocation modes — both flow through the same Messages call, only the user content differs:
- **Direct fetch**: user content = the URL alone (`"https://example.com/post"`). Claude calls the tool once with that URL.
- **Question over URL**: user content = `"<question>\n\n<url>"`. Claude fetches, then synthesizes an answer grounded in the fetched body.

Response content blocks:
- `server_tool_use` (`name === "web_fetch"`, `input.url`).
- `web_fetch_tool_result` → `{url, content: { type: "document", source: { type: "text"|"base64", media_type, data }}, retrieved_at}` *or* error variants. Document content is the extracted markdown/text representation Anthropic produced.
- `text` with `citations[]` of type `char_location` → `{url, title, cited_text, start_char_index, end_char_index}`.

Usage extras: `usage.server_tool_use.web_fetch_requests`.

PDFs come back as base64 documents. Treat them as opaque, surface only metadata + citations to the LLM.

### 2.3 Auth and headers

Same `/v1/messages` endpoint regardless of whether the key is a console API key or an OAuth access token. OAuth path needs the same headers `pi-mono`'s built-in provider uses (anthropic-beta inclusive of `oauth-2025-04-20` and `claude-code-20250219`, `User-Agent: claude-cli/...`, `x-app: cli`). Detect OAuth by the `sk-ant-oat` prefix (matches `isOAuthToken` in `examples/extensions/custom-provider-anthropic/index.ts:172`) and branch headers accordingly.

We will **not** reimplement header building. Strategy:
- For API-key path: send `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: web-fetch-2025-09-10` (only when calling fetch).
- For OAuth path: send `Authorization: Bearer <token>`, `anthropic-version: 2023-06-01`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20,web-fetch-2025-09-10`, plus `user-agent` + `x-app` to match the existing convention. Encapsulate in `buildHeaders(auth, { needsFetchBeta })`.

## 3. Package layout

```
~/me/dev/pi-wierd-stuff/packages/web/
  package.json              # name: pi-wierd-web, pi.extensions: ["./index.ts"]
  README.md
  index.ts                  # extension entry, registers tools + command
  anthropic.ts              # auth + headers + low-level POST /v1/messages
  search.ts                 # web_search tool def + parseSearchResponse
  fetch.ts                  # web_fetch tool def + parseFetchResponse
  render.ts                 # shared TUI renderers (renderCall, renderResult)
  types.ts                  # AnthropicAuth, SearchResponse, FetchResponse, raw API block types
```

`package.json` mirrors `packages/statusline/package.json`:
- `"type": "module"`.
- `"files": ["*.ts", "*.md", "*.json"]`.
- `"keywords": ["pi-package", "pi", "coding-agent", "extension", "web-search", "anthropic"]`.
- `"pi": { "extensions": ["./index.ts"] }`.
- `"devDependencies"` only: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `typebox`. No runtime deps; rely on global `fetch`.

## 4. Module-by-module design

### 4.1 `types.ts`

Mirror oh-my-pi shapes but trimmed:

```ts
export interface AnthropicAuth {
  apiKey: string;
  isOAuth: boolean;
  baseUrl: string;             // default https://api.anthropic.com
}

export interface SearchSource {
  title: string;
  url: string;
  pageAge?: string;
  ageSeconds?: number;
}

export interface Citation {
  url: string;
  title?: string;
  citedText?: string;
}

export interface SearchResponse {
  answer?: string;
  sources: SearchSource[];
  citations?: Citation[];
  searchQueries?: string[];
  model: string;
  requestId: string;
  usage: { inputTokens: number; outputTokens: number; searchRequests?: number };
}

export interface FetchedDocument {
  url: string;
  retrievedAt?: string;
  mediaType: string;          // "text/plain" | "text/markdown" | "application/pdf" | ...
  encoding: "text" | "base64";
  text?: string;              // text payload when encoding === "text"
  byteLength?: number;        // when base64
  error?: { code: string; message: string };
}

export interface FetchResponse {
  document?: FetchedDocument;
  answer?: string;
  citations?: Citation[];
  model: string;
  requestId: string;
  usage: { inputTokens: number; outputTokens: number; fetchRequests?: number };
}

export class AnthropicWebError extends Error {
  constructor(public status: number, public phase: "search" | "fetch", message: string) { super(message); }
}
```

### 4.2 `anthropic.ts` — auth + transport

Responsibilities:

1. `async function resolveAuth(ctx): Promise<AnthropicAuth>` — calls `ctx.modelRegistry.getApiKeyForProvider("anthropic")` first. If it returns undefined, falls back to `process.env.PI_WIERD_WEB_API_KEY ?? process.env.ANTHROPIC_API_KEY`. Determines `isOAuth = key.includes("sk-ant-oat")`. Throws `AnthropicWebError(401, ...)` if nothing resolved, with message instructing the user to set the env var or run `/login anthropic`.
2. `function buildHeaders(auth, opts: { needsFetchBeta: boolean }): Record<string, string>` — encapsulates the OAuth vs API-key branching described in §2.3.
3. `async function callMessages(auth, body, opts): Promise<AnthropicMessageResponse>` — single `fetch(POST /v1/messages)` with a 60s `AbortSignal.any([userSignal, AbortSignal.timeout(60_000)])`. Maps non-2xx to `AnthropicWebError`.
4. `function buildSystemBlocks(auth, model, extra?: string)` — two ephemeral text blocks: `"You are Claude Code, Anthropic's official CLI for Claude."` (skip for `claude-3-5-haiku*`, just like oh-my-pi) plus optional caller-supplied instruction. Marked `cache_control: {type: "ephemeral"}`.

The module is the *only* place that knows about HTTP. `search.ts` and `fetch.ts` import `callMessages`.

### 4.3 `search.ts`

Tool definition:

```ts
const webSearch = defineTool({
  name: "web_search",
  label: "Web Search (Anthropic)",
  description: <prompt string — see §6>,
  promptSnippet: "web_search - Web search via Anthropic's Claude with citations",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    max_uses: Type.Optional(Type.Number({ description: "Max search calls Claude may issue. Defaults to 5." })),
    allowed_domains: Type.Optional(Type.Array(Type.String())),
    blocked_domains: Type.Optional(Type.Array(Type.String())),
    user_location: Type.Optional(Type.Object({
      type: Type.Literal("approximate"),
      country: Type.Optional(Type.String()),
      city: Type.Optional(Type.String()),
      region: Type.Optional(Type.String()),
      timezone: Type.Optional(Type.String()),
    })),
    max_tokens: Type.Optional(Type.Number()),
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  }),
  renderShell: "default",
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... },
  renderCall, renderResult,
});
```

`execute` flow:
1. `const auth = await resolveAuth(ctx)`.
2. Build payload with model from `getActiveModel()` (see §4.6), `max_tokens` default 4096, system blocks, single user message = `params.query`.
3. POST via `callMessages(auth, body, { needsFetchBeta: false, signal })`.
4. `parseSearchResponse(raw)` — port of oh-my-pi's `parseResponse`.
5. Build LLM-facing text via `formatSearchForLLM(response)` (mirrors oh-my-pi's `formatForLLM`: answer, then `## Sources` numbered list, then `## Citations`, then `Search queries:` summary).
6. Return `{ content: [{type: "text", text}], details: response }`.

Errors → return `{ content: [{type: "text", text: "Error: ..."}], details: { error: msg }, isError: true }`.

### 4.4 `fetch.ts`

Tool definition:

```ts
const webFetch = defineTool({
  name: "web_fetch",
  label: "Web Fetch (Anthropic)",
  description: <prompt string — see §6>,
  promptSnippet: "web_fetch - Fetch a URL with optional question; returns extracted content + citations",
  parameters: Type.Object({
    url: Type.String({ description: "Absolute http/https URL to fetch." }),
    question: Type.Optional(Type.String({ description: "Optional question Claude should answer using the fetched page." })),
    max_content_tokens: Type.Optional(Type.Number({ description: "Cap content size returned by fetch tool." })),
    allowed_domains: Type.Optional(Type.Array(Type.String())),
    blocked_domains: Type.Optional(Type.Array(Type.String())),
    citations: Type.Optional(Type.Boolean({ description: "Include character-level citations. Defaults to true." })),
    max_tokens: Type.Optional(Type.Number()),
  }),
  renderShell: "default",
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... },
  renderCall, renderResult,
});
```

`execute` flow:
1. `resolveAuth(ctx)`.
2. Validate URL: `new URL(params.url)`, scheme must be `http`/`https` — fail fast otherwise. Reject `file:`, `data:`, `javascript:` etc.
3. Build user message:
   - Direct mode (no `question`): `messages: [{ role: "user", content: params.url }]`.
   - Q&A mode: `messages: [{ role: "user", content: \`${question}\n\n${url}\` }]`.
4. Tool block: `{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1, max_content_tokens: params.max_content_tokens ?? 100_000, citations: { enabled: params.citations ?? true }, allowed_domains?, blocked_domains? }`.
5. `callMessages(auth, body, { needsFetchBeta: true, signal })`.
6. `parseFetchResponse(raw)` → `FetchResponse`. For PDF (base64) responses, populate `byteLength` only and set `text` to a placeholder `"[PDF document, {N} bytes — content withheld from agent]"`.
7. Format for LLM:
   - Header line `Fetched: <url> (retrieved <retrievedAt>)`.
   - If `answer`: print it.
   - Else if `document.text`: print the document body, **truncated** to `max_content_tokens / 4` chars (rough char→token heuristic) with a `… [truncated]` marker. Long pages must not blow up the agent context — Anthropic's own `max_content_tokens` already gates the upstream side, but apply a hard local ceiling too.
   - `## Citations` section identical to search.
8. On error variants in the tool result block (e.g. `error: { type, message }`), surface them via `details.document.error` and return `isError: true`.

Hard rule: never echo the entire fetched document into both `answer` synthesis and the raw text block. Pick whichever is smaller (Q&A mode prefers `answer`; direct mode falls back to `document.text`).

### 4.5 `render.ts`

Two helpers, reused for both tools (the call rendering differs slightly by tool):

- `renderCall(args, theme, ctx)` — single-line summary:
  - `web_search`: `🔎 web_search "<query truncated to width-prefix>"` plus dim suffix `[<n> domains allowed]` when `allowed_domains` is set.
  - `web_fetch`: `📥 web_fetch <shortened URL>` plus `?<question truncated>` when `question` is provided.
- `renderResult(result, options, theme, ctx)`:
  - Header: tool name + status pill (`OK` / `ERR`).
  - Body collapsed (default): first 6 lines of `details.answer ?? details.document.text`, plus `Sources: N · Citations: M` summary.
  - Body expanded: full answer, sources list as `[i] title (age)\n    url`, citations grouped by URL, usage line `tokens in/out · server requests`.
  - All text passed through `replaceTabs` + `truncateToWidth` (use the helpers re-exported from `@mariozechner/pi-tui` / `pi-coding-agent` if they exist; otherwise local equivalents).
  - Match the existing statusline package's palette (Tokyo Night Storm). Pull theme from `theme.fg("accent", ...)` etc.

### 4.6 `index.ts` — extension entry + state

```ts
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { webSearchTool } from "./search.js";
import { webFetchTool } from "./fetch.js";

interface WebState { model: string; defaultMaxTokens: number; }
const STATE_TYPE = "wierd-web-config";

export default function (pi: ExtensionAPI) {
  let state: WebState = { model: process.env.PI_WIERD_WEB_MODEL ?? "claude-haiku-4-5", defaultMaxTokens: 4096 };

  pi.registerTool(webSearchTool({ getState: () => state }));
  pi.registerTool(webFetchTool({ getState: () => state }));

  pi.registerCommand("wierd-web", {
    description: "Configure pi-wierd-web (model, status)",
    handler: async (args, ctx) => { /* dispatch on args: status | model <id> | reset */ },
  });

  pi.on("session_start", async (_event, ctx) => { /* restore state from session entries via ctx.sessionManager.getBranch() */ });
  pi.on("session_tree", async (_event, ctx) => { /* re-restore on tree navigation, mirrors examples/extensions/tools.ts */ });
}
```

State persistence pattern is copied from `examples/extensions/tools.ts:42-65` — scan branch entries for `customType === "wierd-web-config"` on `session_start` and `session_tree`.

## 5. Auth resolution and OAuth detail

Path priority inside `resolveAuth(ctx)`:

1. `process.env.PI_WIERD_WEB_API_KEY` — explicit override that bypasses ModelRegistry. Lets users point at a different account from their default agent provider.
2. `await ctx.modelRegistry.getApiKeyForProvider("anthropic")` — handles stored API keys, OAuth refresh-with-locking, and `ANTHROPIC_API_KEY`. This is the same call path the agent already uses for normal turns, so it inherits any provider override the user set with `pi.registerProvider("anthropic", { baseUrl })`.
3. `process.env.ANTHROPIC_API_KEY` — last-resort direct read, in case the extension runs in a context where `modelRegistry` isn't available (RPC mode, early in startup).

Failure: `AnthropicWebError(401, "search"|"fetch", "No Anthropic credentials available. Run /login anthropic or set PI_WIERD_WEB_API_KEY.")`.

`isOAuth` flag drives:
- Header set in `buildHeaders` (Bearer + claude-code beta + UA shim).
- System block content: include the `"You are Claude Code..."` instruction *only* when `isOAuth` is true (matches built-in provider behavior; without it Anthropic returns `invalid_request_error: "OAuth authentication is currently not supported"`).
- For `claude-3-5-haiku*` models the Claude Code instruction is suppressed even on OAuth — match oh-my-pi's `getModel()` carve-out so we don't 400.

## 6. Tool prompts

Both tool descriptions live as Markdown strings in `index.ts` (or inlined via Type.String descriptions). They must be short enough to land cheaply in the system prompt's `Available tools` section. Draft:

`web_search`:
> Search the web through Anthropic's Claude. Returns a synthesized answer grounded in cited sources, plus the raw source list. Use for current events, version-specific docs, or anything outside training data. Prefer specific queries over broad ones; Claude may issue follow-up searches up to `max_uses`. Cost: counts as one Anthropic request plus per-search server-tool fees billed to the active Anthropic account.

`web_fetch`:
> Fetch a single URL through Anthropic's web_fetch tool. Returns extracted page content with citations. If `question` is provided, returns Claude's answer instead of raw content. Use when you have an exact URL (from web_search results, the user, or earlier context). Do not pass URLs you have not seen — use web_search to discover them. PDF responses are summarized but not inlined.

These strings are kept in code (Type.String descriptions and the `description` field) — no separate `.md` files needed for v1; the `pi-mono` package is fine with inline strings even though the upstream `oh-my-pi` policy preferred `.md` imports. (The constraint in oh-my-pi's AGENTS.md "no inline prompts" is **not** in pi-mono's AGENTS.md; verify before publishing.)

## 7. Settings and runtime knobs

Exposed via `/wierd-web`:

- `/wierd-web status` — prints active model, last request id, last usage, auth source.
- `/wierd-web model <id>` — overrides `state.model` for the rest of the session and persists via `pi.appendEntry(STATE_TYPE, state)`.
- `/wierd-web reset` — clears state to env defaults.

Env vars:

- `PI_WIERD_WEB_MODEL` — default model.
- `PI_WIERD_WEB_API_KEY` — explicit Anthropic key override.
- `PI_WIERD_WEB_BASE_URL` — for proxies / Bedrock-style relays. Default `https://api.anthropic.com`.

CLI flags (registered via `pi.registerFlag`):

- `--wierd-web-model <id>` — boot-time model override.
- `--wierd-web-disable-fetch` — registers only `web_search`. Useful when running on a key without web_fetch beta access.

## 8. Error handling matrix

| Failure                                              | Surface                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| No credentials                                       | `isError: true`, message instructs `/login anthropic` or env var.                              |
| 401/403                                              | `isError: true`, include status; on OAuth path hint at `/login anthropic` re-auth.             |
| 404                                                  | `isError: true`, message names the model; suggest `/wierd-web model claude-haiku-4-5`.         |
| 429                                                  | `isError: true`, surface `retry-after` header if present.                                      |
| Beta not enabled (web_fetch only)                    | Detect Anthropic error string, return clear "web_fetch beta not enabled on this account" hint. |
| Tool result `web_fetch_tool_result.content.error`    | Pass through the upstream code/message into `FetchResponse.document.error`, isError true.      |
| Body > local cap                                     | Truncate, append `… [truncated by pi-wierd-web]`.                                              |
| Abort                                                | Resolve with `isError: true, content: [{type:"text", text:"Aborted"}]`. No exception.          |
| Disallowed URL scheme                                | Local validation error before the HTTP call.                                                   |

All non-error paths must include `details` so the renderer has structured data. The TUI never displays raw API JSON.

## 9. Testing strategy

Pi-mono runs vitest (`packages/coding-agent/vitest.config.ts`). The extension can ship its own minimal test suite:

- Unit tests for `parseSearchResponse` with a fixture lifted from oh-my-pi's existing `web-search-anthropic.test.ts`. Asserts: sources flattened, citations attached, `searchQueries` populated, usage extras read.
- Unit tests for `parseFetchResponse`:
  - Direct fetch with text document → `FetchResponse.document.text` populated, `answer` undefined.
  - Q&A fetch → `answer` populated, `citations[]` non-empty, `document.text` *also* preserved (caller decides what to print).
  - Error variant block → `document.error` set, `answer` undefined.
  - Base64 (PDF) document → `text` is the placeholder, `byteLength` set.
- Header builder: API-key path has `x-api-key`, no `Authorization`. OAuth path has `Authorization: Bearer ...`, `claude-code-20250219` in `anthropic-beta`, `web-fetch-2025-09-10` only when `needsFetchBeta`.
- `resolveAuth` priority test: env override beats modelRegistry beats `ANTHROPIC_API_KEY`.

Use `vi.spyOn(globalThis, "fetch")` per-test, restore in `afterEach`. No `mock.module`. Tests live in `packages/web/test/`.

Manual integration check (out of band, not CI):

```
pi -e ./packages/web/index.ts
> /wierd-web status
> use web_search to find latest stable Bun release
> use web_fetch to read https://bun.sh/blog and summarize what changed in 1.2
```

## 10. Implementation milestones

1. **Skeleton** — package.json, tsconfig (extends pi-mono root if linked, else standalone), `index.ts` registering a no-op tool, verify `pi -e ./index.ts` loads cleanly.
2. **Search** — port `anthropic.ts` + `search.ts` from oh-my-pi (strip multi-provider plumbing). Get one successful query end-to-end with text output.
3. **Renderers** — wire `renderCall`/`renderResult`. Confirm collapse/expand behavior matches other tools in the agent.
4. **Fetch — direct mode** — minimal `web_fetch` with URL-only input, returning raw extracted text. Validate against an HTML article and a small PDF.
5. **Fetch — Q&A mode + citations** — add `question` parameter and citation rendering. Verify char_location citation indices remain consistent.
6. **Auth polish** — OAuth path, header branching, env overrides, error matrix.
7. **State + command** — `/wierd-web` command, `session_start` / `session_tree` restoration.
8. **Tests** — unit suite per §9; ensure each test is full-suite safe.
9. **Docs + README** — usage, env vars, beta-access caveat, examples. Add a section to `pi-wierd-stuff/README.md` linking the new package.
10. **Publish** — `npm publish --access public` as `pi-wierd-web`. Bump `devDependencies` to current `@mariozechner/pi-*` versions.

## 11. Open questions / follow-ups

- **Caching**: should we keep a tiny in-memory LRU keyed by `(query, allowed_domains, model)` and `(url, question)` to dedupe cost when the LLM retries? Probably yes for `web_fetch` (single-URL hits repeat often), no for `web_search` (queries vary). Defer to v0.2.
- **`web_fetch` token accounting**: `max_content_tokens` is enforced server-side in tokens, but our local truncation cap is character-based. Decide whether to request `usage.cache_creation_input_tokens` breakdown for better visibility — affects the renderer only.
- **Streaming the synthesized answer**: would require switching `callMessages` to SSE and pushing `tool_execution_update` events. Out of scope for v1; revisit if users complain about latency on `web_fetch` Q&A.
- **Provider override interplay**: if a user has `pi.registerProvider("anthropic", { baseUrl: "https://my-proxy" })`, our `callMessages` should honor that. Pull the base URL from `ctx.modelRegistry` if it exposes one for the active anthropic provider; otherwise stick with `PI_WIERD_WEB_BASE_URL` / default. Confirm `ModelRegistry` has a way to read the configured baseUrl per provider before relying on it.
- **Domain allowlist defaults**: should the extension ship a default `blocked_domains` (e.g. obvious malware/phishing lists)? Probably no — leave policy to the user / Anthropic.
- **Telemetry**: pi-mono has a telemetry module. Decide whether to count tool invocations + token usage. Leaning yes, opt-in via env var.
