/**
 * TUI renderers for the web_fetch tool.
 *
 * Both `renderCall` and `renderResult` use the open-right rounded frame
 * from `@wierdbytes/pi-common/tool-frame`:
 *
 *   ╭── web_fetch https://example.com · prompt ──────
 *   │   per-URL progress / preview / error
 *   ╰── 42 lines · ctrl+o to expand ─────────────────
 *
 * `renderCall` owns the top border; `renderResult` owns the body and
 * the bottom border (with or without an inline label depending on the
 * branch). The expanded-success path renders the markdown body to a
 * pre-wrapped ANSI string via `Markdown.render(width - 1)`, then runs
 * the result through `frameBodyLines` so every output line carries the
 * status-coloured `│` rail — matching every other framed result.
 */

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import {
  formatDuration,
  frameResult,
  frameResultWithBottomLabel,
  frameTop,
  getDefaultFrameWidth,
  getFrameStatus,
} from "@wierdbytes/pi-common/tool-frame";
import type { BatchPageState, BatchPageStatus, WebFetchToolDetails } from "./fetch-types.ts";
import type { WebFetchParams } from "./fetch.ts";

const STATUS_ICONS: Record<BatchPageStatus, string> = {
  pending: "○",
  fetching: "◐",
  extracting: "◑",
  summarizing: "◕",
  done: "●",
  error: "✗",
};

const STATUS_LABELS: Record<BatchPageStatus, string> = {
  pending: "waiting",
  fetching: "fetching",
  extracting: "extracting",
  summarizing: "summarizing",
  done: "done",
  error: "error",
};

/** Cap on per-URL continuation rows shown in the multi-line top border. */
const MAX_BATCH_TITLE_ROWS = 5;

/** Per-line gap between the rail (`│`) and the body content. */
const BODY_PADDING_X = 1;

/**
 * Per-call render state stashed in `ctx.state` so the elapsed-time
 * bottom-label stays live across re-renders and freezes once the
 * fetch pipeline resolves. Mirrors the pattern used by
 * `renderSearchResult`.
 */
interface FetchRenderState {
  startedAt?: number;
  endedAt?: number;
  /** `setInterval` id for the 1 s heartbeat (cleared on completion). */
  interval?: ReturnType<typeof setInterval>;
}

/**
 * Drive the per-render-tick lifecycle of the elapsed-time state machine
 * (latch start, schedule heartbeat while pending, freeze on completion).
 * Returns the elapsed-ms value for the bottom-label, or `undefined` when
 * we somehow have no start time — callers omit the duration segment.
 */
function tickElapsed(
  state: FetchRenderState,
  isPartial: boolean,
  invalidate: () => void,
): number | undefined {
  if (state.startedAt === undefined) state.startedAt = Date.now();
  if (isPartial) {
    if (state.interval === undefined) {
      state.interval = setInterval(() => {
        try {
          invalidate();
        } catch {
          if (state.interval !== undefined) clearInterval(state.interval);
          state.interval = undefined;
        }
      }, 1000);
    }
    return Date.now() - state.startedAt;
  }
  state.endedAt ??= Date.now();
  if (state.interval !== undefined) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  return state.endedAt - state.startedAt;
}

function renderCtxOf(
  ctx: unknown,
): { state?: FetchRenderState; invalidate?: () => void } {
  return (ctx as { state?: FetchRenderState; invalidate?: () => void }) ?? {};
}

/** Join non-empty segments with ` · ` and dim them for a bottom-label. */
function dimJoin(theme: Theme, segments: string[]): string {
  return theme.fg("dim", segments.filter(Boolean).join(" · "));
}

function shortenUrl(url: string, max = 60): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return parsed.hostname + (path.length > 40 ? path.slice(0, 40) + "..." : path);
  } catch {
    return url.length > max ? url.slice(0, max) + "..." : url;
  }
}

/**
 * Compose a per-URL status line for the in-progress batch body. Mirrors
 * the previous Container-of-Texts layout but emits a single ANSI string
 * so it can flow through the frame's body helpers.
 */
function statusLine(page: BatchPageState, theme: Theme): string {
  const icon = STATUS_ICONS[page.status];
  const label = STATUS_LABELS[page.status];
  const url = shortenUrl(page.url);

  if (page.status === "done") {
    return `${theme.fg("success", icon)} ${theme.fg("dim", url)}`;
  }
  if (page.status === "error") {
    return `${theme.fg("error", icon)} ${theme.fg("error", url)}${theme.fg(
      "dim",
      ` · ${label}`,
    )}`;
  }
  if (page.status === "pending") {
    return theme.fg("muted", `${icon} ${url}`);
  }
  return `${theme.fg("accent", icon)} ${theme.fg("accent", url)}${theme.fg(
    "dim",
    ` · ${label}`,
  )}`;
}

// ---------------------------------------------------------------------------
// renderCall
// ---------------------------------------------------------------------------

export function renderFetchCall(
  args: WebFetchParams,
  theme: Theme,
  ctx: unknown,
) {
  const frameCtx =
    (ctx as { isError?: boolean; isPartial?: boolean } | null | undefined) ?? {};
  const status = getFrameStatus(frameCtx);
  const width = getDefaultFrameWidth();

  // Multi-page batch: head row "web_fetch N pages" + one continuation per
  // URL. Past MAX_BATCH_TITLE_ROWS, the last row collapses to "+M more".
  // The shared `frameTop` lays the continuations out as a sub-tree
  // hanging off the head row's first arg column.
  if (args.pages && Array.isArray(args.pages)) {
    const count = args.pages.length;
    const head =
      theme.fg("toolTitle", theme.bold("web_fetch ")) +
      theme.fg("accent", `${count} page${count === 1 ? "" : "s"}`);

    const urls = args.pages.map((p) => p.url || "...");
    const visible = urls.slice(0, MAX_BATCH_TITLE_ROWS);
    const continuations = visible.map((u) => theme.fg("dim", shortenUrl(u, 80)));
    if (urls.length > MAX_BATCH_TITLE_ROWS) {
      continuations.push(
        theme.fg("dim", `+${urls.length - MAX_BATCH_TITLE_ROWS} more`),
      );
    }
    const title = [head, ...continuations].join("\n");
    return new Text(frameTop(title, status, theme, width), 0, 0);
  }

  // Single-page: one-line title.
  const url = args.url || "...";
  let title =
    theme.fg("toolTitle", theme.bold("web_fetch ")) +
    theme.fg("accent", shortenUrl(url, 70));
  if (args.prompt) {
    title += "  " + theme.fg("dim", "· " + args.prompt);
  }
  return new Text(frameTop(title, status, theme, width), 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult
// ---------------------------------------------------------------------------

export function renderFetchResult(
  result: AgentToolResult<WebFetchToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  ctx: unknown,
) {
  const width = getDefaultFrameWidth();
  const { expanded, isPartial } = options;
  const pages = result.details?.pages;
  const { state = {}, invalidate = () => {} } = renderCtxOf(ctx);

  // Latch start time + drive the 1 s heartbeat. The first call (kicked
  // off by the heartbeat `onUpdate({ content: [] })` from `execute`)
  // sets up the interval; completion clears it. The returned value is
  // the elapsed-ms to display in the bottom-label.
  const elapsedMs = tickElapsed(state, !!isPartial, invalidate);
  const elapsedSeg = elapsedMs !== undefined ? formatDuration(elapsedMs) : "";

  // In-progress batch: rail-prefixed per-URL status lines + pending
  // bottom-label with live timer. Trade-off: we lose the per-URL
  // Container nesting in exchange for a single string that flows through
  // `frameResult`. Acceptable — the chrome is the visual signal here,
  // not the widget structure.
  if (isPartial && pages) {
    const body = pages.map((p) => statusLine(p, theme)).join("\n");
    const doneCount = pages.filter((p) => p.status === "done").length;
    const errorCount = pages.filter((p) => p.status === "error").length;
    const labelSegs = [
      elapsedSeg,
      `${doneCount}/${pages.length} done`,
      errorCount > 0 ? `${errorCount} failed` : "",
    ];
    return new Text(
      frameResultWithBottomLabel(
        body,
        dimJoin(theme, labelSegs),
        "pending",
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  // Single-URL pending (or batch pending without a `pages` payload yet):
  // the heartbeat fires `onUpdate({ content: [] })` before any real
  // output exists, so we draw an empty pending body with just the
  // elapsed-time label.
  if (isPartial) {
    return new Text(
      frameResultWithBottomLabel(
        theme.fg("warning", "Fetching…"),
        dimJoin(theme, [elapsedSeg]),
        "pending",
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  // `isError` is a runtime field set by tools but not part of AgentToolResult<T>'s static type.
  const isError = (result as { isError?: boolean }).isError;
  const textContent = result.content[0];
  const text = textContent?.type === "text" ? textContent.text : "(no output)";

  if (isError) {
    return new Text(
      frameResultWithBottomLabel(
        theme.fg("error", text),
        dimJoin(theme, [elapsedSeg, "✗ error"]),
        "error",
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  // Expanded success: render the markdown body to ANSI ourselves so we
  // can rail-prefix every line through `frameBodyLines` (matching every
  // other framed result). pi-tui's `Markdown.render(width)` returns the
  // already-wrapped/styled lines as `string[]`; we join them, hand them
  // to `frameResult`, and ship a single Text. Width passed into render
  // is `width - 1 - paddingX` to leave one column for the rail and one
  // for the body padding gap.
  if (expanded) {
    const md = new Markdown(text, 0, 0, getMarkdownTheme());
    const innerWidth = Math.max(1, width - 1 - BODY_PADDING_X);
    const renderedLines = md.render(innerWidth);
    const body = renderedLines.join("\n");
    const lineCount = text.split("\n").length;
    return new Text(
      frameResultWithBottomLabel(
        body,
        dimJoin(theme, [
          elapsedSeg,
          `${lineCount} line${lineCount === 1 ? "" : "s"}`,
        ]),
        "success",
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  // Collapsed success: rail-prefixed preview + bottom-label with the
  // frozen elapsed time, line count and expand hint. The frame chrome
  // carries the success signal, so the leading newline + "✓" icon from
  // the previous renderer are dropped.
  const lines = text.split("\n");
  const preview = lines.slice(0, 5).join("\n");
  return new Text(
    frameResultWithBottomLabel(
      preview,
      dimJoin(theme, [
        elapsedSeg,
        `${lines.length} line${lines.length === 1 ? "" : "s"}`,
        "ctrl+o to expand",
      ]),
      "success",
      theme,
      width,
      { paddingX: BODY_PADDING_X },
    ),
    0,
    0,
  );
}
