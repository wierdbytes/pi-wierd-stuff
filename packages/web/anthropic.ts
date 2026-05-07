/**
 * Auth resolution + transport for @wierdbytes/pi-web.
 *
 * Single place that knows about HTTP. web_search flows through callMessages().
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AnthropicWebError,
  type AnthropicAuth,
  type AnthropicMessageResponse,
} from "./types.ts";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
];

const REQUEST_TIMEOUT_MS = 60_000;

const isOAuthToken = (apiKey: string): boolean => apiKey.includes("sk-ant-oat");

const trimBaseUrl = (url: string): string => url.replace(/\/+$/, "");

/**
 * Resolve an Anthropic credential.
 *
 * Priority:
 *   1. PI_WIERD_WEB_API_KEY (explicit override)
 *   2. modelRegistry.getApiKeyForProvider("anthropic") - covers stored keys,
 *      OAuth refresh-with-locking, and ANTHROPIC_API_KEY via AuthStorage.
 *   3. ANTHROPIC_API_KEY (raw env, last resort).
 */
export async function resolveAuth(
  ctx: ExtensionContext,
  phase: "search" = "search",
): Promise<AnthropicAuth> {
  const baseUrl = trimBaseUrl(process.env.PI_WIERD_WEB_BASE_URL ?? ANTHROPIC_DEFAULT_BASE_URL);

  const override = process.env.PI_WIERD_WEB_API_KEY;
  if (override) {
    return { apiKey: override, isOAuth: isOAuthToken(override), baseUrl };
  }

  let viaRegistry: string | undefined;
  try {
    viaRegistry = await ctx.modelRegistry?.getApiKeyForProvider?.("anthropic");
  } catch {
    // Registry lookup failures fall through to env.
  }
  if (viaRegistry) {
    return { apiKey: viaRegistry, isOAuth: isOAuthToken(viaRegistry), baseUrl };
  }

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) {
    return { apiKey: envKey, isOAuth: isOAuthToken(envKey), baseUrl };
  }

  throw new AnthropicWebError(
    401,
    phase,
    "No Anthropic credentials available. Run /login anthropic, set ANTHROPIC_API_KEY, or set PI_WIERD_WEB_API_KEY.",
  );
}

/**
 * Build request headers. OAuth path mirrors the headers pi-mono's built-in
 * Anthropic provider sends, including the claude-code stealth-mode UA.
 */
export function buildHeaders(auth: AnthropicAuth): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "anthropic-version": ANTHROPIC_API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };

  if (auth.isOAuth) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
    headers["anthropic-beta"] = OAUTH_BETAS.join(",");
    headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
    headers["x-app"] = "cli";
  } else {
    headers["x-api-key"] = auth.apiKey;
  }

  return headers;
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * Build the system block list. The Claude Code identity line is required for
 * OAuth tokens; without it the API rejects the request. We also skip it for
 * claude-3-5-haiku models, matching the carve-out in pi-mono's provider.
 */
export function buildSystemBlocks(
  auth: AnthropicAuth,
  model: string,
  extra?: string,
): AnthropicSystemBlock[] | undefined {
  const blocks: AnthropicSystemBlock[] = [];
  const includeClaudeCode = auth.isOAuth && !/^claude-3-5-haiku/i.test(model);

  if (includeClaudeCode) {
    blocks.push({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral" },
    });
  }

  if (extra && extra.trim()) {
    blocks.push({
      type: "text",
      text: extra.trim(),
      cache_control: { type: "ephemeral" },
    });
  }

  return blocks.length > 0 ? blocks : undefined;
}

export interface CallMessagesOptions {
  signal?: AbortSignal;
}

/**
 * POST /v1/messages and parse the JSON response.
 *
 * Combines the user's signal with a 60s timeout via AbortSignal.any. Maps
 * non-2xx responses to AnthropicWebError so callers can surface clean
 * messages to the LLM.
 */
export async function callMessages(
  auth: AnthropicAuth,
  body: Record<string, unknown>,
  options: CallMessagesOptions = {},
): Promise<AnthropicMessageResponse> {
  const url = `${auth.baseUrl}/v1/messages`;
  const headers = buildHeaders(auth);

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const aborted = options.signal?.aborted;
      throw new AnthropicWebError(
        aborted ? 499 : 504,
        "search",
        aborted ? "Request aborted" : `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AnthropicWebError(0, "search", `Network error: ${message}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch {
      // Non-JSON body; keep raw text.
    }
    const retryAfter = response.headers.get("retry-after");
    const suffix = retryAfter ? ` (retry-after: ${retryAfter})` : "";
    throw new AnthropicWebError(
      response.status,
      "search",
      `Anthropic API ${response.status}: ${detail || response.statusText}${suffix}`,
    );
  }

  const json = (await response.json()) as AnthropicMessageResponse;
  return json;
}

// Re-export for tests that want to introspect timing constants.
export const __testables = {
  ANTHROPIC_API_VERSION,
  OAUTH_BETAS,
  REQUEST_TIMEOUT_MS,
};
