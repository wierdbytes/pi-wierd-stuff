/**
 * TUI renderers for web_search.
 *
 * Collapsed (default): two lines - a one-line counts summary and a single
 * preview line (first source title or first answer line).
 *
 * Expanded (Ctrl+O): the full results list with title / url / age per
 * source, capped at EXPANDED_SOURCES_MAX entries.
 */

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { WebSearchToolDetails, WebSearchParams } from "./search.ts";

const EXPANDED_SOURCES_MAX = 20;

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

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

export function renderSearchCall(
  args: WebSearchParams,
  theme: Theme,
  _ctx: unknown,
): Text {
  let line = theme.fg("toolTitle", theme.bold("web_search "));
  line += theme.fg("accent", `"${args.query.trim()}"`);
  const flags: string[] = [];
  if (args.allowed_domains?.length) flags.push(`+${args.allowed_domains.length}d`);
  if (args.blocked_domains?.length) flags.push(`-${args.blocked_domains.length}d`);
  if (args.max_uses) flags.push(`max=${args.max_uses}`);
  if (args.user_location?.country) flags.push(args.user_location.country);
  if (flags.length) line += theme.fg("dim", ` (${flags.join(", ")})`);
  return new Text(line, 0, 0);
}

export function renderSearchResult(
  result: AgentToolResult<WebSearchToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _ctx: unknown,
): Text {
  if (options.isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

  const details = result.details ?? {};
  if (details.error) {
    const status = details.status ? ` [${details.status}]` : "";
    return new Text(theme.fg("error", `web_search error${status}: ${details.error}`), 0, 0);
  }

  const response = details.response;
  if (!response) {
    return new Text(theme.fg("error", "web_search returned no data"), 0, 0);
  }

  const sourceCount = response.sources.length;
  const citationCount = response.citations?.length ?? 0;
  const queryCount = response.searchQueries?.length ?? 0;

  const summarySegments: string[] = [];
  summarySegments.push(theme.fg("success", `${sourceCount} source${sourceCount === 1 ? "" : "s"}`));
  if (citationCount > 0) {
    summarySegments.push(theme.fg("accent", `${citationCount} cite${citationCount === 1 ? "" : "s"}`));
  }
  if (queryCount > 0) {
    summarySegments.push(theme.fg("dim", `${queryCount} ${queryCount === 1 ? "query" : "queries"}`));
  }
  if (response.usage.searchRequests !== undefined) {
    summarySegments.push(theme.fg("dim", `srv=${response.usage.searchRequests}`));
  }
  const summaryLine = summarySegments.join(theme.fg("dim", " · "));

  if (!options.expanded) {
    // Collapsed: exactly two lines - summary plus an expand hint.
    return new Text(
      [summaryLine, theme.fg("dim", "ctrl+o to expand")].join("\n"),
      0,
      0,
    );
  }

  // Expanded: full answer (when present) followed by the results list
  // (title / url / age), one entry per source.
  const lines: string[] = [summaryLine];

  if (response.answer) {
    lines.push("");
    for (const raw of response.answer.split(/\r?\n/)) {
      lines.push(theme.fg("toolOutput", raw));
    }
  }

  if (response.sources.length === 0) {
    if (!response.answer) lines.push(theme.fg("dim", "(no sources)"));
    return new Text(lines.join("\n"), 0, 0);
  }

  lines.push("");
  lines.push(theme.fg("accent", theme.bold("Sources")));
  for (const [i, src] of response.sources.slice(0, EXPANDED_SOURCES_MAX).entries()) {
    const age = formatAge(src.ageSeconds) ?? src.pageAge;
    const ageSuffix = age ? theme.fg("dim", ` (${age})`) : "";
    lines.push(`${theme.fg("dim", `[${i + 1}]`)} ${theme.fg("toolOutput", src.title)}${ageSuffix}`);
    lines.push(`     ${theme.fg("muted", src.url)}`);
  }
  if (response.sources.length > EXPANDED_SOURCES_MAX) {
    lines.push(theme.fg("dim", `… ${response.sources.length - EXPANDED_SOURCES_MAX} more sources`));
  }

  return new Text(lines.join("\n"), 0, 0);
}


