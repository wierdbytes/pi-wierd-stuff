/**
 * TUI renderers for the web_fetch tool.
 *
 * Mirrors upstream pi-web-fetch presentation:
 *  - renderCall: tool title + URL (or "N pages") + optional prompt suffix.
 *  - renderResult while in progress: per-URL status lines (icon + url + state).
 *  - renderResult collapsed: success icon + first 5 lines.
 *  - renderResult expanded: full markdown via Markdown widget.
 */

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Text } from "@mariozechner/pi-tui";
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

function renderBatchStatus(pages: BatchPageState[], theme: Theme): Container {
  const container = new Container();

  for (const page of pages) {
    const icon = STATUS_ICONS[page.status];
    const label = STATUS_LABELS[page.status];

    let displayUrl: string;
    try {
      const parsed = new URL(page.url);
      const path = parsed.pathname + parsed.search;
      displayUrl = parsed.hostname + (path.length > 40 ? path.slice(0, 40) + "..." : path);
    } catch {
      displayUrl = page.url.length > 60 ? page.url.slice(0, 60) + "..." : page.url;
    }

    let line: string;
    if (page.status === "done") {
      line = theme.fg("success", icon) + " " + theme.fg("dim", displayUrl);
    } else if (page.status === "error") {
      line =
        theme.fg("error", icon) +
        " " +
        theme.fg("error", displayUrl) +
        theme.fg("dim", " · " + label);
    } else if (page.status === "pending") {
      line = theme.fg("muted", icon + " " + displayUrl);
    } else {
      line =
        theme.fg("accent", icon) +
        " " +
        theme.fg("accent", displayUrl) +
        theme.fg("dim", " · " + label);
    }

    container.addChild(new Text(line, 0, 0));
  }

  return container;
}

export function renderFetchCall(args: WebFetchParams, theme: Theme, _ctx: unknown) {
  if (args.pages && Array.isArray(args.pages)) {
    const count = args.pages.length;
    let text =
      theme.fg("toolTitle", theme.bold("web_fetch ")) +
      theme.fg("accent", `${count} page${count === 1 ? "" : "s"}`);
    const urls = args.pages.slice(0, 3).map((p) => {
      const u = p.url || "...";
      return u.length > 50 ? u.slice(0, 50) + "..." : u;
    });
    text += "  " + theme.fg("dim", urls.join(", "));
    if (count > 3) text += theme.fg("dim", ` +${count - 3} more`);
    return new Text(text, 0, 0);
  }

  const url = args.url || "...";
  const shortUrl = url.length > 70 ? url.slice(0, 70) + "..." : url;
  let text = theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", shortUrl);
  if (args.prompt) {
    text += "  " + theme.fg("dim", "· " + args.prompt);
  }
  return new Text(text, 0, 0);
}

export function renderFetchResult(
  result: AgentToolResult<WebFetchToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _ctx: unknown,
) {
  const { expanded, isPartial } = options;
  const pages = result.details?.pages;

  if (isPartial && pages) {
    return renderBatchStatus(pages, theme);
  }

  // `isError` is a runtime field set by tools but not part of AgentToolResult<T>'s static type.
  const isError = (result as { isError?: boolean }).isError;
  const textContent = result.content[0];
  const text = textContent?.type === "text" ? textContent.text : "(no output)";

  if (isError) {
    return new Text("\n" + theme.fg("error", "✗ ") + theme.fg("error", text), 0, 0);
  }

  const icon = theme.fg("success", "✓ ");
  if (expanded) {
    return new Markdown("\n" + text, 0, 0, getMarkdownTheme());
  }

  const lines = text.split("\n");
  const preview = lines.slice(0, 5).join("\n");
  const suffix =
    lines.length > 5
      ? theme.fg("muted", `\n... (${lines.length - 5} more lines, Ctrl+O to expand)`)
      : "";
  return new Text("\n" + icon + preview + suffix, 0, 0);
}
