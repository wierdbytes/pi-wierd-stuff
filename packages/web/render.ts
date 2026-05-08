/**
 * TUI renderers for web_search.
 *
 * Layout (collapsed):
 *
 *     ╭── web_search "query" ──────────────────────────
 *     │ first 5 lines of the answer
 *     │ … N more lines  (only if answer overflows the preview cap)
 *     ╰── 10 sources · 5 cites · 1 query · ctrl+o to expand ──
 *
 * Layout (expanded):
 *
 *     ╭── web_search "query" ──────────────────────────
 *     │ full answer text
 *     │
 *     │ Sources
 *     │ [1] Title (age)
 *     │      url
 *     │ …
 *     ╰── 10 sources · 5 cites · 1 query ──────────────
 *
 * Both branches keep the per-line `│ <content>` rail spacing and the
 * counts summary in the bottom-border label, so the same numbers are
 * always visible regardless of expansion state.
 */

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  formatDuration,
  frameResultWithBottomLabel,
  frameTop,
  getDefaultFrameWidth,
  getFrameStatus,
} from "@wierdbytes/pi-common/tool-frame";
import type { WebSearchToolDetails, WebSearchParams } from "./search.ts";

/**
 * Per-call render state stashed in `ctx.state` so the elapsed-time
 * bottom-label stays live across re-renders and freezes once the
 * result lands.
 */
interface SearchRenderState {
  startedAt?: number;
  endedAt?: number;
  /** `setInterval` id for the 1 s heartbeat (cleared on completion). */
  interval?: ReturnType<typeof setInterval>;
}

const EXPANDED_SOURCES_MAX = 20;
/** Max body lines shown in the collapsed answer preview before the
 *  `... N more lines` overflow indicator kicks in. */
const COLLAPSED_PREVIEW_LINES = 5;
/** Per-line gap between the rail (`│`) and the body content. */
const BODY_PADDING_X = 1;

function formatAge(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d ago`;
  if (seconds < 2592000) return `${Math.round(seconds / 604800)}w ago`;
  if (seconds < 31536000) return `${Math.round(seconds / 2592000)}mo ago`;
  return `${Math.round(seconds / 31536000)}y ago`;
}

/**
 * Build the bottom-label segments for a successful search result. Same
 * pluralisation rules in both collapsed and expanded modes; only the
 * `ctrl+o to expand` hint differs.
 *
 * `durationMs` is rendered as the leading segment when defined so the
 * label reads `0.5s · 10 sources · …`, mirroring the bash bottom-label
 * in pi-facelift.
 */
function buildBottomLabel(
  response: NonNullable<WebSearchToolDetails["response"]>,
  theme: Theme,
  withExpandHint: boolean,
  durationMs: number | undefined,
): string {
  const sourceCount = response.sources.length;
  const citationCount = response.citations?.length ?? 0;
  const queryCount = response.searchQueries?.length ?? 0;

  const segments: string[] = [];
  if (durationMs !== undefined) segments.push(formatDuration(durationMs));
  segments.push(`${sourceCount} source${sourceCount === 1 ? "" : "s"}`);
  if (citationCount > 0) {
    segments.push(`${citationCount} cite${citationCount === 1 ? "" : "s"}`);
  }
  if (queryCount > 0) {
    segments.push(`${queryCount} ${queryCount === 1 ? "query" : "queries"}`);
  }
  if (response.usage.searchRequests !== undefined) {
    segments.push(`srv=${response.usage.searchRequests}`);
  }
  if (withExpandHint) segments.push("ctrl+o to expand");
  return theme.fg("dim", segments.join(" · "));
}

/**
 * Drive the per-render-tick lifecycle of the elapsed-time state machine:
 * latch `startedAt` on first call, schedule a 1 s heartbeat while still
 * pending so the timer ticks visibly, freeze `endedAt` and clear the
 * heartbeat once the tool finishes.
 *
 * Returns the elapsed-ms value to display in the bottom-label.
 */
function tickElapsed(
  state: SearchRenderState,
  isPartial: boolean,
  invalidate: () => void,
): number | undefined {
  if (state.startedAt === undefined) state.startedAt = Date.now();
  const stillRunning = isPartial;
  if (stillRunning) {
    if (state.interval === undefined) {
      state.interval = setInterval(() => {
        try {
          invalidate();
        } catch {
          // Defensive: if the host TUI tears the component down between
          // ticks, the interval becomes orphaned. Swallow + clear so we
          // don't leak a timer.
          if (state.interval !== undefined) clearInterval(state.interval);
          state.interval = undefined;
        }
      }, 1000);
    }
    return Date.now() - state.startedAt;
  }
  // Finished: latch endedAt, clear the heartbeat.
  state.endedAt ??= Date.now();
  if (state.interval !== undefined) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  return state.endedAt - state.startedAt;
}

/** Type guard for the optional `state` + `invalidate` fields on the render context. */
function renderCtxOf(
  ctx: unknown,
): { state?: SearchRenderState; invalidate?: () => void } {
  return (ctx as { state?: SearchRenderState; invalidate?: () => void }) ?? {};
}

// ---------------------------------------------------------------------------
// renderSearchCall
// ---------------------------------------------------------------------------

export function renderSearchCall(
  args: WebSearchParams,
  theme: Theme,
  ctx: unknown,
): Text {
  let title = theme.fg("toolTitle", theme.bold("web_search "));
  title += theme.fg("accent", `"${args.query.trim()}"`);
  const flags: string[] = [];
  if (args.allowed_domains?.length) flags.push(`+${args.allowed_domains.length}d`);
  if (args.blocked_domains?.length) flags.push(`-${args.blocked_domains.length}d`);
  if (args.max_uses) flags.push(`max=${args.max_uses}`);
  if (args.user_location?.country) flags.push(args.user_location.country);
  if (flags.length) title += theme.fg("dim", ` (${flags.join(", ")})`);

  // Read status fresh on every render — once the result arrives and
  // pi-tui re-invokes the renderers (driven by the heartbeat in
  // `renderSearchResult`), the top border flips from warning →
  // success/error to match the body.
  const frameCtx =
    (ctx as { isError?: boolean; isPartial?: boolean } | null | undefined) ?? {};
  const status = getFrameStatus(frameCtx);
  const width = getDefaultFrameWidth();
  return new Text(frameTop(title, status, theme, width), 0, 0);
}

// ---------------------------------------------------------------------------
// renderSearchResult
// ---------------------------------------------------------------------------

export function renderSearchResult(
  result: AgentToolResult<WebSearchToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  ctx: unknown,
): Text {
  const width = getDefaultFrameWidth();
  const { state = {}, invalidate = () => {} } = renderCtxOf(ctx);

  // Latch start time + drive the 1 s heartbeat so the elapsed-time
  // bottom-label stays live during the pending phase, then freezes once
  // the API call resolves. The first call to this function (kicked off
  // by the heartbeat `onUpdate({ content: [] })` from `execute`) sets up
  // the interval; subsequent ticks reuse it; completion clears it.
  const elapsedMs = tickElapsed(state, !!options.isPartial, invalidate);
  const elapsedLabel =
    elapsedMs !== undefined ? theme.fg("dim", formatDuration(elapsedMs)) : "";

  // -------------------------------------------------------------------------
  // Pending: complete box (top via renderCall, body + bottom-label here)
  // with a live `0.5s` timer in the bottom-label so the user sees progress.
  // -------------------------------------------------------------------------

  if (options.isPartial) {
    return new Text(
      frameResultWithBottomLabel(
        theme.fg("warning", "Searching…"),
        elapsedLabel,
        "pending",
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  const details = result.details ?? {};

  // -------------------------------------------------------------------------
  // Error: same chrome as success, but the bottom-label leads with the
  // frozen elapsed time and tags the error message.
  // -------------------------------------------------------------------------

  if (details.error) {
    const errStatus = details.status ? ` [${details.status}]` : "";
    const message = `web_search error${errStatus}: ${details.error}`;
    const labelSegs: string[] = [];
    if (elapsedMs !== undefined) labelSegs.push(formatDuration(elapsedMs));
    labelSegs.push(`✗ ${details.error}`);
    return new Text(
      frameResultWithBottomLabel(
        theme.fg("error", message),
        theme.fg("dim", labelSegs.join(" · ")),
        "error",
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  const response = details.response;
  if (!response) {
    const labelSegs: string[] = [];
    if (elapsedMs !== undefined) labelSegs.push(formatDuration(elapsedMs));
    labelSegs.push("✗ no data");
    return new Text(
      frameResultWithBottomLabel(
        theme.fg("error", "web_search returned no data"),
        theme.fg("dim", labelSegs.join(" · ")),
        "error",
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  const status = "success" as const;

  // -------------------------------------------------------------------------
  // Collapsed: preview of the answer in the body, counts in the bottom
  // label, with the frozen elapsed time as the leading segment.
  // -------------------------------------------------------------------------

  if (!options.expanded) {
    const answerLines = response.answer
      ? response.answer.split(/\r?\n/)
      : [];
    let bodyLines: string[];
    if (answerLines.length === 0) {
      bodyLines = [theme.fg("dim", "(no answer)")];
    } else {
      bodyLines = answerLines
        .slice(0, COLLAPSED_PREVIEW_LINES)
        .map((line) => theme.fg("toolOutput", line));
      if (answerLines.length > COLLAPSED_PREVIEW_LINES) {
        const overflow = answerLines.length - COLLAPSED_PREVIEW_LINES;
        bodyLines.push(theme.fg("dim", `... ${overflow} more lines`));
      }
    }
    return new Text(
      frameResultWithBottomLabel(
        bodyLines.join("\n"),
        buildBottomLabel(response, theme, true, elapsedMs),
        status,
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  // -------------------------------------------------------------------------
  // Expanded: full answer + sources list in the body, counts in the bottom
  // label (same as collapsed, minus the "ctrl+o to expand" hint).
  // -------------------------------------------------------------------------

  const bodyLines: string[] = [];
  if (response.answer) {
    for (const raw of response.answer.split(/\r?\n/)) {
      bodyLines.push(theme.fg("toolOutput", raw));
    }
  }

  if (response.sources.length === 0) {
    if (!response.answer) bodyLines.push(theme.fg("dim", "(no sources)"));
    return new Text(
      frameResultWithBottomLabel(
        bodyLines.join("\n"),
        buildBottomLabel(response, theme, false, elapsedMs),
        status,
        theme,
        width,
        { paddingX: BODY_PADDING_X },
      ),
      0,
      0,
    );
  }

  if (bodyLines.length > 0) bodyLines.push("");
  bodyLines.push(theme.fg("accent", theme.bold("Sources")));
  for (const [i, src] of response.sources
    .slice(0, EXPANDED_SOURCES_MAX)
    .entries()) {
    const age = formatAge(src.ageSeconds) ?? src.pageAge;
    const ageSuffix = age ? theme.fg("dim", ` (${age})`) : "";
    bodyLines.push(
      `${theme.fg("dim", `[${i + 1}]`)} ${theme.fg("toolOutput", src.title)}${ageSuffix}`,
    );
    bodyLines.push(`     ${theme.fg("muted", src.url)}`);
  }
  if (response.sources.length > EXPANDED_SOURCES_MAX) {
    bodyLines.push(
      theme.fg(
        "dim",
        `… ${response.sources.length - EXPANDED_SOURCES_MAX} more sources`,
      ),
    );
  }

  return new Text(
    frameResultWithBottomLabel(
      bodyLines.join("\n"),
      buildBottomLabel(response, theme, false, elapsedMs),
      status,
      theme,
      width,
      { paddingX: BODY_PADDING_X },
    ),
    0,
    0,
  );
}
