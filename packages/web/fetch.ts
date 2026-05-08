/**
 * web_fetch tool definition.
 *
 * Pipeline per URL: validate → cache → puppeteer fetch → trafilatura extract
 * → optional sub-agent summarize/distill. Single-URL calls route through the
 * batch executor so the live status UI is identical.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  defineTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BrowserPool } from "./browser-pool.ts";
import { extractContent, withTimeout } from "./extract.ts";
import { runSubAgent, type SubAgentError } from "./subagent.ts";
import type {
  BatchDetails,
  BatchPageState,
  BatchPageStatus,
  FetchPageResult,
  FetchRedirectResult,
  WebFetchToolDetails,
} from "./fetch-types.ts";
import { renderFetchCall, renderFetchResult } from "./fetch-render.ts";

// --- Internal result shape ---
//
// AgentToolResult<T> requires `details: T` and has no `isError` field, but
// the runtime treats `isError` as a first-class signal. We use a permissive
// internal shape end-to-end and cast at the `execute()` boundary.
type InternalResult = {
  content: (TextContent | ImageContent)[];
  details?: WebFetchToolDetails;
  isError?: boolean;
};

type InternalUpdate = (partial: InternalResult) => void;

function toAgentResult(r: InternalResult): AgentToolResult<WebFetchToolDetails> {
  return { details: {}, ...r } as AgentToolResult<WebFetchToolDetails>;
}

function wrapUpdate(
  cb?: AgentToolUpdateCallback<WebFetchToolDetails>,
): InternalUpdate | undefined {
  if (!cb) return undefined;
  return (partial) => cb(toAgentResult(partial));
}

// --- Constants ---

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/** Hard ceiling for the initial DOM-ready navigation. */
const PAGE_TIMEOUT_MS = 20_000;
/**
 * After DOM is ready we wait briefly for the SPA to hydrate, but cap how long
 * we tolerate ongoing trackers/ads. networkidle2 alone can hang indefinitely
 * on ad-heavy sites. This budget is the longest we'll wait for the network to
 * quiet down before snapshotting whatever we have.
 */
const POST_LOAD_IDLE_TIMEOUT_MS = 5_000;
/** How long the network must be ~idle before we consider the page settled. */
const POST_LOAD_IDLE_TIME_MS = 500;
const EXTRACT_TIMEOUT_MS = 10_000;
const SUBAGENT_TIMEOUT_MS = 10_000;
const CONTENT_SIZE_THRESHOLD = 50_000;
const MAX_BROWSER_TABS = 6;
const BROWSER_IDLE_TIMEOUT_MS = 60_000;
export const MAX_BATCH_SIZE = 10;

const CONTENT_GUARDRAILS = `Respond concisely using only the page content above.
- Keep direct quotes under 125 characters and always use quotation marks for exact wording.
- Outside of quotes, rephrase in your own words — never reproduce source text verbatim.
- Open-source code and documentation snippets are fine to include as-is.`;

const SUMMARIZE_PROMPT = `Summarize this page:
1. A 2-3 sentence overview of the page's purpose.
2. For each major section or heading, its name and a 1-2 sentence description.
3. End with: "To extract specific information, call web_fetch again with the same URL and a prompt. The page is cached so re-fetching is instant."

${CONTENT_GUARDRAILS}`;

// --- Schema ---

export const WebFetchSchema = Type.Object({
  url: Type.Optional(
    Type.String({
      description:
        "Fully-formed URL to fetch (e.g., https://example.com/page). Mutually exclusive with 'pages'.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "What information to extract from the page. Strongly recommended — the page content will be processed by a fast LLM and only relevant information returned. Omit only if you need the full raw content. Only used with 'url', not 'pages'.",
    }),
  ),
  pages: Type.Optional(
    Type.Array(
      Type.Object({
        url: Type.String({ description: "Fully-formed URL to fetch" }),
        prompt: Type.Optional(
          Type.String({ description: "What information to extract from this page" }),
        ),
      }),
      {
        maxItems: MAX_BATCH_SIZE,
        description: `Array of pages to fetch concurrently (max ${MAX_BATCH_SIZE}). Mutually exclusive with 'url'. Each entry can have its own prompt.`,
      },
    ),
  ),
});

export type WebFetchParams = Static<typeof WebFetchSchema>;

// --- Cache ---

interface CacheEntry {
  content: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(url: string): string | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return entry.content;
}

function setCache(url: string, content: string): void {
  cache.set(url, { content, timestamp: Date.now() });
}

function cleanupCache(): void {
  const now = Date.now();
  for (const [url, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(url);
    }
  }
}

// --- Browser pool ---

const browserPool = new BrowserPool({
  maxTabs: MAX_BROWSER_TABS,
  idleTimeoutMs: BROWSER_IDLE_TIMEOUT_MS,
});

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startCacheCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupCache, CACHE_CLEANUP_INTERVAL_MS);
}

export async function shutdownWebFetch(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  cache.clear();
  await browserPool.shutdown();
}

// --- URL helpers ---

type UrlValidation = { ok: true; url: string } | { ok: false; error: string };

function validateAndNormalizeUrl(raw: string): UrlValidation {
  const cleaned = raw.startsWith("@") ? raw.slice(1) : raw;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return {
      ok: false,
      error: `Invalid URL: "${cleaned}". Please provide a fully-formed URL (e.g., https://example.com/page).`,
    };
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Unsupported URL scheme: "${parsed.protocol}". Only HTTP and HTTPS URLs are supported.`,
    };
  }
  return { ok: true, url: parsed.toString() };
}

// --- Fetch via puppeteer ---

async function fetchPage(
  url: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; result: FetchPageResult }
  | { ok: true; redirect: FetchRedirectResult }
  | { ok: false; error: string }
> {
  let page: Awaited<ReturnType<typeof browserPool.acquire>> | null = null;

  try {
    if (signal?.aborted) return { ok: false, error: "Aborted" };

    page = await browserPool.acquire(signal);

    const requestUrl = new URL(url);
    let crossHostRedirect: string | null = null;

    page.on("response", (response) => {
      if (!response.request().isNavigationRequest()) return;
      const status = response.status();
      if (status >= 300 && status < 400) {
        const location = response.headers()["location"];
        if (location) {
          try {
            const redirectUrl = new URL(location, url);
            if (redirectUrl.hostname !== requestUrl.hostname) {
              crossHostRedirect = redirectUrl.toString();
            }
          } catch {
            // ignore malformed redirect URLs
          }
        }
      }
    });

    try {
      // Two-phase load:
      //   1. Wait for DOMContentLoaded with a hard timeout. This unblocks us
      //      on heavy sites whose ad/analytics traffic prevents networkidle2
      //      from ever firing.
      //   2. Then opportunistically wait up to POST_LOAD_IDLE_TIMEOUT_MS for
      //      the network to actually quiet down so SPA hydration completes.
      //      Whichever happens first (idle or timeout) we snapshot.
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });
      if (!signal?.aborted) {
        await page
          .waitForNetworkIdle({
            idleTime: POST_LOAD_IDLE_TIME_MS,
            timeout: POST_LOAD_IDLE_TIMEOUT_MS,
          })
          .catch(() => {
            // Idle never reached within budget — that's fine, snapshot anyway.
          });
      }
    } catch (err: any) {
      if (signal?.aborted) return { ok: false, error: "Aborted" };
      if (err.name === "TimeoutError" || err.message?.includes("timeout")) {
        return {
          ok: false,
          error: `Page load timed out after ${PAGE_TIMEOUT_MS / 1000} seconds for URL: ${url}`,
        };
      }
      return { ok: false, error: `Failed to load page: ${err.message}` };
    }

    if (crossHostRedirect) {
      return { ok: true, redirect: { redirectedTo: crossHostRedirect } };
    }

    const html = await page.content();
    const finalUrl = page.url();
    return { ok: true, result: { html, finalUrl } };
  } catch (err: any) {
    if (signal?.aborted) return { ok: false, error: "Aborted" };
    return { ok: false, error: `Browser error: ${err.message}` };
  } finally {
    if (page) await browserPool.release(page);
  }
}

// --- Batch result formatting (exported for tests) ---

export function formatBatchResults(
  pages: Array<{ url: string; prompt?: string }>,
  results: PromiseSettledResult<any>[],
) {
  const total = pages.length;

  if (total === 1) {
    const settled = results[0];
    if (settled.status === "rejected") {
      return {
        content: [{ type: "text", text: `Error: ${settled.reason?.message || String(settled.reason)}` }],
        isError: true,
      };
    }
    return settled.value;
  }

  const sections: string[] = [];
  for (let i = 0; i < total; i++) {
    const header = `--- [${i + 1}/${total}] ${pages[i].url} ---`;
    const settled = results[i];

    let body: string;
    if (settled.status === "rejected") {
      body = `Error: ${settled.reason?.message || String(settled.reason)}`;
    } else {
      const result = settled.value;
      if (result.isError) {
        const textContent = result.content?.[0];
        body = `Error: ${textContent?.type === "text" ? textContent.text : "Unknown error"}`;
      } else {
        const textContent = result.content?.[0];
        body = textContent?.type === "text" ? textContent.text : "(no content)";
      }
    }

    sections.push(`${header}\n${body}`);
  }

  return {
    content: [{ type: "text", text: sections.join("\n\n") }],
  };
}

// --- Tool factory ---

export interface WebFetchToolOptions {
  /**
   * Returns the model id (provider/model) to use for the sub-agent. May
   * return undefined to fall back to the current session model.
   */
  getFetchModel: (ctx: ExtensionContext) => string | undefined;
  /**
   * Returns the thinking level for the sub-agent. May return undefined to
   * fall back to the current session thinking level.
   */
  getFetchThinkingLevel: () => string | undefined;
  /** Used to read the current session thinking level when override is unset. */
  getSessionThinkingLevel: () => string;
}

export function createWebFetchTool(
  options: WebFetchToolOptions,
): ToolDefinition<typeof WebFetchSchema, WebFetchToolDetails> {
  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Retrieves and extracts the main content of a web page as markdown.",
      "",
      "Include a 'prompt' parameter to have an LLM distill the page down to just the information you need — this saves significant context compared to ingesting raw page content.",
      "Without a prompt, the full extracted markdown is returned (or a structured overview if the page is large).",
      "",
      "Batch mode: use 'pages' instead of 'url' to fetch multiple URLs in a single call. Each entry can have its own prompt.",
      "This is much faster than making separate web_fetch calls when you need content from several pages.",
      "The 'url' and 'pages' parameters are mutually exclusive. Maximum 10 pages per batch.",
      "",
      "When to use something else:",
      "- The gh CLI (via bash) for anything on GitHub — issues, PRs, repo contents, API calls.",
      "",
      "Behavior notes:",
      "- URLs must include the scheme (e.g. https://). Plain HTTP is silently upgraded to HTTPS.",
      "- Fetched content is held in a short-lived cache, so asking multiple questions about the same page is cheap.",
      "- Cross-host redirects are surfaced rather than followed — make a second request to the target URL.",
      "- No files or external state are modified by this tool.",
    ].join("\n"),
    parameters: WebFetchSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Heartbeat: kick off `renderResult` immediately so the pending
      // box is fully drawn (top + body + bottom-label with live timer)
      // and the renderer's interval-driven 1 s invalidate can keep
      // ticking. Single-URL fetches don't otherwise emit `onUpdate`
      // until the whole pipeline resolves; without this the user only
      // sees the top border drawn by `renderCall`.
      onUpdate?.({ content: [] });

      const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const model = options.getFetchModel(ctx) || sessionModel;
      const thinkingLevel =
        options.getFetchThinkingLevel() || options.getSessionThinkingLevel() || "off";

      const hasUrl = params.url !== undefined && params.url !== null;
      const hasPages = params.pages !== undefined && params.pages !== null;

      if (hasUrl && hasPages) {
        return toAgentResult({
          content: [
            {
              type: "text",
              text: "The 'url' and 'pages' parameters are mutually exclusive. Use 'url' for a single page or 'pages' for batch fetching, not both.",
            },
          ],
          isError: true,
        });
      }
      if (!hasUrl && !hasPages) {
        return toAgentResult({
          content: [{ type: "text", text: "Either 'url' or 'pages' must be provided." }],
          isError: true,
        });
      }

      if (hasPages) {
        const pages = params.pages!;
        if (pages.length === 0) {
          return toAgentResult({
            content: [{ type: "text", text: "The 'pages' array must contain at least one entry." }],
            isError: true,
          });
        }
        if (pages.length > MAX_BATCH_SIZE) {
          return toAgentResult({
            content: [
              {
                type: "text",
                text: `The 'pages' array exceeds the maximum batch size of ${MAX_BATCH_SIZE}.`,
              },
            ],
            isError: true,
          });
        }
        return toAgentResult(await executeBatch(pages, model, thinkingLevel, signal, onUpdate));
      }

      return toAgentResult(
        await executeBatch(
          [{ url: params.url!, prompt: params.prompt }],
          model,
          thinkingLevel,
          signal,
          onUpdate,
        ),
      );
    },

    // we draw our own open-right rounded frame via @wierdbytes/pi-common/tool-frame
    renderShell: "self",
    renderCall: renderFetchCall,
    renderResult: renderFetchResult,
  });
}

// --- Pipeline ---

async function processSingleUrl(
  rawUrl: string,
  prompt: string | undefined,
  model: string | undefined,
  thinkingLevel: string,
  signal?: AbortSignal,
  onUpdate?: InternalUpdate,
): Promise<InternalResult> {
  const urlResult = validateAndNormalizeUrl(rawUrl);
  if (!urlResult.ok) {
    return {
      content: [{ type: "text", text: urlResult.error }],
      isError: true,
    };
  }
  const url = urlResult.url;

  const cached = getCached(url);
  if (cached) {
    onUpdate?.({ content: [{ type: "text", text: "Cache hit — processing..." }] });
    return await runProcess(cached, prompt, model, thinkingLevel, signal, onUpdate);
  }

  const fetchOuter = await runFetch(url, signal, onUpdate);
  if (fetchOuter.done) return fetchOuter.result;
  const html = fetchOuter.html;

  const extractOuter = await runExtract(html, signal, onUpdate);
  if (extractOuter.done) return extractOuter.result;
  const markdown = extractOuter.markdown;

  setCache(url, markdown);

  return await runProcess(markdown, prompt, model, thinkingLevel, signal, onUpdate);
}

async function executeBatch(
  pages: Array<{ url: string; prompt?: string }>,
  model: string | undefined,
  thinkingLevel: string,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<WebFetchToolDetails>,
): Promise<InternalResult> {
  const wrappedTopLevel = wrapUpdate(onUpdate);
  const pageStates: BatchPageState[] = pages.map((p) => ({
    url: p.url,
    status: "pending" as BatchPageStatus,
  }));

  function emitBatchUpdate() {
    wrappedTopLevel?.({
      content: [{ type: "text", text: "" }],
      details: { pages: pageStates } satisfies BatchDetails,
    });
  }

  emitBatchUpdate();

  const promises = pages.map(async (page, i) => {
    const pageOnUpdate: InternalUpdate = (partial) => {
      const text = partial.content?.[0];
      if (text?.type === "text") {
        const msg = text.text;
        if (msg.startsWith("Fetching")) {
          pageStates[i].status = "fetching";
        } else if (msg.startsWith("Extracting")) {
          pageStates[i].status = "extracting";
        } else if (
          msg.startsWith("Processing") ||
          msg.includes("summary") ||
          msg.includes("Cache hit")
        ) {
          pageStates[i].status = "summarizing";
        }
      }
      emitBatchUpdate();
    };

    const result = await processSingleUrl(
      page.url,
      page.prompt,
      model,
      thinkingLevel,
      signal,
      pageOnUpdate,
    );

    if (result.isError) {
      pageStates[i].status = "error";
      const errText = result.content?.[0];
      if (errText?.type === "text") pageStates[i].error = errText.text;
    } else {
      pageStates[i].status = "done";
    }
    emitBatchUpdate();

    return result;
  });

  const results = await Promise.allSettled(promises);
  const formatted = formatBatchResults(pages, results) as InternalResult;

  // Attach final per-page status so renderResult can show per-URL outcome.
  return {
    ...formatted,
    details: { pages: pageStates },
  };
}

async function runFetch(
  url: string,
  signal?: AbortSignal,
  onUpdate?: InternalUpdate,
): Promise<{ done: true; result: InternalResult } | { done: false; html: string }> {
  onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}...` }] });

  const fetchResult = await fetchPage(url, signal);
  if (!fetchResult.ok) {
    return {
      done: true,
      result: {
        content: [{ type: "text", text: (fetchResult as { ok: false; error: string }).error }],
        isError: true,
      },
    };
  }

  if ("redirect" in fetchResult) {
    const redirectUrl = (fetchResult as { ok: true; redirect: FetchRedirectResult }).redirect.redirectedTo;
    return {
      done: true,
      result: {
        content: [
          {
            type: "text",
            text: `The URL redirected to a different host: ${redirectUrl}\n\nTo fetch the content, make a new web_fetch call with this URL: ${redirectUrl}`,
          },
        ],
      },
    };
  }

  return { done: false, html: fetchResult.result.html };
}

async function runExtract(
  html: string,
  signal?: AbortSignal,
  onUpdate?: InternalUpdate,
): Promise<{ done: true; result: InternalResult } | { done: false; markdown: string }> {
  onUpdate?.({ content: [{ type: "text", text: "Extracting content..." }] });

  const extractResult = await withTimeout(
    extractContent(html, signal),
    EXTRACT_TIMEOUT_MS,
    "Content extraction",
    signal,
  ).catch((err): { ok: false; error: string } => ({ ok: false, error: err.message }));

  if (!extractResult.ok) {
    return {
      done: true,
      result: {
        content: [{ type: "text", text: (extractResult as { ok: false; error: string }).error }],
        isError: true,
      },
    };
  }

  return { done: false, markdown: extractResult.markdown };
}

async function runProcess(
  markdown: string,
  prompt: string | undefined,
  model: string | undefined,
  thinkingLevel: string,
  signal?: AbortSignal,
  onUpdate?: InternalUpdate,
): Promise<InternalResult> {
  // Prompted path — sub-agent if model available
  if (prompt && model) {
    onUpdate?.({ content: [{ type: "text", text: "Processing with LLM..." }] });

    const agentResult = await withTimeout(
      runSubAgent(markdown, `${prompt}\n\n${CONTENT_GUARDRAILS}`, model, thinkingLevel, signal),
      SUBAGENT_TIMEOUT_MS,
      "LLM processing",
      signal,
    ).catch((err): SubAgentError => ({ ok: false, error: err.message }));

    if (agentResult.ok) {
      return { content: [{ type: "text", text: agentResult.response }] };
    }

    const truncation = truncateHead(markdown, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    let fallbackText = truncation.content;
    if (truncation.truncated) {
      fallbackText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
    }
    fallbackText += `\n\n⚠️ LLM processing failed: ${(agentResult as SubAgentError).error}. Returning raw extracted content instead.`;
    return { content: [{ type: "text", text: fallbackText }] };
  }

  // No prompt — small content goes raw
  if (markdown.length <= CONTENT_SIZE_THRESHOLD) {
    return { content: [{ type: "text", text: markdown }] };
  }

  // Large content with no model — truncate
  if (!model) {
    const truncation = truncateHead(markdown, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    let text = truncation.content;
    if (truncation.truncated) {
      text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
    }
    return { content: [{ type: "text", text }] };
  }

  // Large content with model — summarize
  onUpdate?.({ content: [{ type: "text", text: "Page content is large — generating summary..." }] });

  const summaryResult = await withTimeout(
    runSubAgent(markdown, SUMMARIZE_PROMPT, model, thinkingLevel, signal),
    SUBAGENT_TIMEOUT_MS,
    "LLM summarization",
    signal,
  ).catch((err): SubAgentError => ({ ok: false, error: err.message }));

  if (summaryResult.ok) {
    return { content: [{ type: "text", text: summaryResult.response }] };
  }

  const truncation = truncateHead(markdown, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let fallbackText = truncation.content;
  if (truncation.truncated) {
    fallbackText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
  }
  fallbackText += `\n\n⚠️ Could not generate summary: ${(summaryResult as SubAgentError).error}. Returning truncated raw content. Consider calling web_fetch again with a prompt to extract specific information.`;
  return { content: [{ type: "text", text: fallbackText }] };
}
