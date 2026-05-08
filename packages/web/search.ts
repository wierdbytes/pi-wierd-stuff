/**
 * web_search tool definition.
 *
 * Wraps Anthropic's `web_search_20250305` server-side tool: a single
 * /v1/messages POST returns a synthesized answer plus citations and the raw
 * sources Claude inspected.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { callMessages, buildSystemBlocks, resolveAuth } from "./anthropic.ts";
import { renderSearchCall, renderSearchResult } from "./render.ts";
import {
  AnthropicWebError,
  type AnthropicMessageResponse,
  type Citation,
  type SearchResponse,
  type SearchSource,
} from "./types.ts";

const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const WEB_SEARCH_TOOL_NAME = "web_search";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_USES = 5;
const DEFAULT_MODEL = "claude-haiku-4-5";

const TOOL_DESCRIPTION = `Search the web through Anthropic's Claude. Returns a synthesized answer grounded in cited sources, plus the raw source list.

Use for current events, version-specific docs, or anything outside training data. Prefer specific queries over broad ones; Claude may issue follow-up searches up to max_uses.

Cost: counts as one Anthropic API call plus per-search server-tool fees billed to the active Anthropic account.`;

export const SearchUserLocation = Type.Object({
  type: Type.Literal("approximate"),
  country: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  region: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
});

export const WebSearchSchema = Type.Object({
  query: Type.String({ description: "The search query." }),
  max_uses: Type.Optional(
    Type.Number({
      description: "Maximum number of search calls Claude may issue. Defaults to 5.",
      minimum: 1,
      maximum: 20,
    }),
  ),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), { description: "Whitelist of domains Claude may pull results from." }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), { description: "Domains Claude must not include in results." }),
  ),
  user_location: Type.Optional(SearchUserLocation),
  max_tokens: Type.Optional(
    Type.Number({ description: "Maximum output tokens for the synthesized answer. Defaults to 4096." }),
  ),
  temperature: Type.Optional(
    Type.Number({ description: "Sampling temperature (0-1). Lower = more focused.", minimum: 0, maximum: 1 }),
  ),
});

export type WebSearchParams = Static<typeof WebSearchSchema>;

export interface WebSearchToolOptions {
  getModel: () => string;
}

export interface WebSearchSystemPromptOptions {
  /**
   * Optional extra instruction appended to the system prompt that runs the
   * Anthropic-side reasoning. Distinct from the agent's own system prompt -
   * web_search runs as an independent /v1/messages call.
   */
  systemPrompt?: string;
}

const PAGE_AGE_RE = /^(\d+)\s*(s|sec|second|m|min|minute|h|hour|d|day|w|week|mo|month|y|year)s?\s*(ago)?$/i;
const AGE_MULTIPLIERS: Record<string, number> = {
  s: 1,
  sec: 1,
  second: 1,
  m: 60,
  min: 60,
  minute: 60,
  h: 3600,
  hour: 3600,
  d: 86400,
  day: 86400,
  w: 604800,
  week: 604800,
  mo: 2592000,
  month: 2592000,
  y: 31536000,
  year: 31536000,
};

/** Convert "2 days ago"-style strings into seconds for the renderer. */
function parsePageAge(pageAge: string | null | undefined): number | undefined {
  if (!pageAge) return undefined;
  const match = pageAge.match(PAGE_AGE_RE);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  return value * (AGE_MULTIPLIERS[unit] ?? 86400);
}

export function parseSearchResponse(raw: AnthropicMessageResponse): SearchResponse {
  const answerParts: string[] = [];
  const searchQueries: string[] = [];
  const sources: SearchSource[] = [];
  const citations: Citation[] = [];

  for (const block of raw.content) {
    if (block.type === "server_tool_use" && (block as any).name === WEB_SEARCH_TOOL_NAME) {
      const input = (block as any).input as { query?: string } | undefined;
      if (input?.query) searchQueries.push(input.query);
    } else if (block.type === "web_search_tool_result") {
      const content = (block as any).content;
      if (Array.isArray(content)) {
        for (const entry of content) {
          if (entry?.type === "web_search_result") {
            sources.push({
              title: entry.title,
              url: entry.url,
              pageAge: entry.page_age ?? undefined,
              ageSeconds: parsePageAge(entry.page_age),
            });
          }
        }
      }
    } else if (block.type === "text") {
      const text = (block as any).text as string | undefined;
      if (text) answerParts.push(text);
      const rawCitations = (block as any).citations as
        | Array<{
            url: string;
            title?: string;
            cited_text?: string;
            start_char_index?: number;
            end_char_index?: number;
          }>
        | undefined;
      if (rawCitations) {
        for (const c of rawCitations) {
          citations.push({
            url: c.url,
            title: c.title,
            citedText: c.cited_text,
            startCharIndex: c.start_char_index,
            endCharIndex: c.end_char_index,
          });
        }
      }
    }
  }

  return {
    answer: answerParts.join("\n\n") || undefined,
    sources,
    citations: citations.length > 0 ? citations : undefined,
    searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
    model: raw.model,
    requestId: raw.id,
    usage: {
      inputTokens: raw.usage.input_tokens,
      outputTokens: raw.usage.output_tokens,
      searchRequests: raw.usage.server_tool_use?.web_search_requests ?? undefined,
    },
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatCount(label: string, n: number): string {
  return `${n} ${label}${n === 1 ? "" : "s"}`;
}

/** Flatten a SearchResponse into the markdown-ish text the LLM consumes. */
export function formatSearchForLLM(response: SearchResponse): string {
  const parts: string[] = [];

  if (response.answer) {
    parts.push(response.answer);
    if (response.sources.length > 0) {
      parts.push("\n## Sources");
      parts.push(formatCount("source", response.sources.length));
    }
  } else if (response.sources.length > 0) {
    parts.push("## Sources");
    parts.push(formatCount("source", response.sources.length));
  }

  for (const [i, src] of response.sources.entries()) {
    const age = src.pageAge ? ` (${src.pageAge})` : "";
    parts.push(`[${i + 1}] ${src.title}${age}\n    ${src.url}`);
  }

  if (response.citations && response.citations.length > 0) {
    parts.push("\n## Citations");
    parts.push(formatCount("citation", response.citations.length));
    for (const [i, c] of response.citations.entries()) {
      const title = c.title || c.url;
      parts.push(`[${i + 1}] ${title}\n    ${c.url}`);
      if (c.citedText) parts.push(`    ${truncate(c.citedText, 240)}`);
    }
  }

  if (response.searchQueries && response.searchQueries.length > 0) {
    parts.push(`\nSearch queries issued: ${response.searchQueries.length}`);
    for (const query of response.searchQueries.slice(0, 5)) {
      parts.push(`- ${truncate(query, 120)}`);
    }
  }

  return parts.join("\n");
}

export interface WebSearchExtras {
  systemPrompt?: string;
  /** Override the model name resolved via getModel(). Used by /web. */
  modelOverride?: string;
}

export interface WebSearchToolDetails {
  response?: SearchResponse;
  error?: string;
  status?: number;
}

/** Build the Anthropic request payload for a web_search call. */
function buildSearchBody(
  model: string,
  params: WebSearchParams,
  systemBlocks: ReturnType<typeof buildSystemBlocks>,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: WEB_SEARCH_TOOL_TYPE,
    name: WEB_SEARCH_TOOL_NAME,
    max_uses: params.max_uses ?? DEFAULT_MAX_USES,
  };
  if (params.allowed_domains?.length) tool.allowed_domains = params.allowed_domains;
  if (params.blocked_domains?.length) tool.blocked_domains = params.blocked_domains;
  if (params.user_location) tool.user_location = params.user_location;

  const body: Record<string, unknown> = {
    model,
    max_tokens: params.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: "user", content: params.query }],
    tools: [tool],
  };

  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (systemBlocks?.length) body.system = systemBlocks;
  return body;
}

export function createWebSearchTool(
  options: WebSearchToolOptions,
): ToolDefinition<typeof WebSearchSchema, WebSearchToolDetails> {
  return defineTool({
    name: "web_search",
    label: "Web Search (Anthropic)",
    description: TOOL_DESCRIPTION,
    promptSnippet: "web_search - Web search via Anthropic's Claude with citations",
    parameters: WebSearchSchema,
    renderShell: "default",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const auth = await resolveAuth(ctx);
        const model = options.getModel() || DEFAULT_MODEL;
        const systemBlocks = buildSystemBlocks(auth, model);
        const body = buildSearchBody(model, params, systemBlocks);

        const raw = await callMessages(auth, body, { signal });

        const response = parseSearchResponse(raw);
        const text = formatSearchForLLM(response);

        return {
          content: [{ type: "text", text }],
          details: { response },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof AnthropicWebError ? err.status : undefined;
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message, status },
          isError: true,
        };
      }
    },

    renderCall: renderSearchCall,
    renderResult: renderSearchResult,
  });
}
