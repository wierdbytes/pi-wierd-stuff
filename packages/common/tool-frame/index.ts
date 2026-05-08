/**
 * @wierdbytes/pi-common/tool-frame — open-right rounded box for tool
 * output, theme-aware.
 *
 * A status-coloured single-line frame for tools that opt into
 * `renderShell: "self"`. The right side is left open so long lines
 * fade out naturally instead of being clipped against a closing rail:
 *
 *     ╭── read /some/file.ext ─────
 *     │   12 lines
 *     │ 535 │ const x = 1;
 *     │ 536 │ const y = 2;
 *     ╰─────────────────────────
 *
 * The status colour is sourced from the host theme's `success` /
 * `warning` / `error` tokens so the frame inherits the user's palette
 * instead of pinning a fixed RGB triplet.
 *
 * This is the **open-right** sibling of `@wierdbytes/pi-common/settings`'s
 * `frame()` helper (which draws a *closed* modal box themed via
 * `borderAccent`/`accent`). The two helpers are intentionally separate:
 * they have different shapes, different colour semantics, and different
 * consumers (overlays vs inline tool rows).
 *
 * Composition pattern in a `renderShell: "self"` tool:
 *
 *     renderCall(args, theme, ctx) {
 *       const w = getDefaultFrameWidth();
 *       const status = getFrameStatus(ctx);
 *       const title = `${theme.fg("toolTitle", theme.bold("read"))} …`;
 *       text.setText(frameTop(title, status, theme, w));
 *       return text;
 *     }
 *
 *     renderResult(result, _opt, theme, ctx) {
 *       const w = getDefaultFrameWidth();
 *       const status = getFrameStatus(ctx);
 *       if (ctx.isError) return renderToolError(text, theme, w);
 *       return text.setText(frameResult(body, status, theme, w));
 *     }
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Visual status of a tool execution, used to colour the frame chrome. */
export type FrameStatus = "pending" | "success" | "error";

/**
 * Map a `FrameStatus` to the `ThemeColor` token used to paint the frame
 * chrome (corners, dashes, vertical rail). Exported so callers can
 * override the colour of inline elements (e.g., the title) to match the
 * frame status.
 */
export const STATUS_TO_THEME_COLOR: Record<FrameStatus, ThemeColor> = {
  pending: "warning",
  success: "success",
  error: "error",
};

/**
 * Derive the visual status from a render context. Mirrors the contract
 * of pi's tool render hooks: `isError` wins over `isPartial`, and the
 * default is "success".
 */
export function getFrameStatus(ctx: {
  isError?: boolean;
  isPartial?: boolean;
}): FrameStatus {
  if (ctx.isError) return "error";
  if (ctx.isPartial) return "pending";
  return "success";
}

/**
 * Compact human-readable duration: `3.3s`, `1m3s`, `2h5m`. Used in
 * tool-frame bottom-border labels to surface elapsed time alongside
 * status summaries (`0.5s`, `1.2s · ✓ exit 0`, `…`).
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  if (totalMin < 60) return sec > 0 ? `${totalMin}m${sec}s` : `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hours}h${min}m` : `${hours}h`;
}

/**
 * Resolve a sensible terminal width for the frame. Reads
 * `process.stdout.columns`, falls back to `process.stderr.columns`,
 * then `COLUMNS`, then a hard default of 200. An optional `maxCap`
 * lets callers clamp the width — pi-facelift caps at 210 so frames
 * never grow wider than pi-tui's `Text.render(width)` will accept.
 */
export function getDefaultFrameWidth(maxCap?: number): number {
  const stderrWithColumns = process.stderr as NodeJS.WriteStream & {
    columns?: number;
  };
  const raw =
    process.stdout.columns ||
    stderrWithColumns.columns ||
    Number.parseInt(process.env.COLUMNS ?? "", 10) ||
    200;
  const capped = maxCap !== undefined ? Math.min(raw, maxCap) : raw;
  return Math.max(1, capped);
}

/**
 * Find the visible column of the first space character in an ANSI-formatted
 * string, ignoring ANSI escape sequences. Returns -1 if no space is found
 * before a newline (or end of string).
 *
 * Used by `frameTop` to align continuation rows under the first argument
 * of the tool title (e.g., the column where `cd` starts in `bash cd …`).
 */
function firstVisibleSpace(s: string): number {
  let visiblePos = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\x1b") {
      const next = s[i + 1];
      if (next === "[") {
        const end = s.indexOf("m", i + 2);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      // Unknown escape — bail out
      return -1;
    }
    if (ch === "\n") return -1;
    if (ch === " ") return visiblePos;
    visiblePos += 1;
    i += 1;
  }
  return -1;
}

/**
 * Render the top border of the frame: `╭── <title> ─────`.
 *
 * The title may contain ANSI codes; visible width is measured with
 * pi-tui's `visibleWidth`. Truncated with `…` if it would overflow.
 *
 * Multi-line titles (e.g., a multi-line bash command) render the first
 * line as the top border and remaining lines as rail-prefixed
 * continuation rows in a sub-tree:
 *
 *     ╭── bash cd /…/pi-wierd-stuff && \ ──────────────
 *     │      │ echo "line 1" \
 *     │      ╰ echo "line 2"
 *
 * Each continuation row is composed of:
 *   • the outer frame rail `│` (status colour)
 *   • padding sized so the sub-tree connector lines up with the first arg
 *     character of the first row
 *   • a sub-tree connector (`│` for non-last rows, `╰` for the last)
 *   • a single separator space
 *   • the row's content (callers are expected to wrap each line in the
 *     same colour as the first-row args so the sub-tree text matches)
 *
 * Trailing dashes are only emitted on the first row so continuation rows
 * stay clean.
 */
export function frameTop(
  titleAnsi: string,
  status: FrameStatus,
  theme: Theme,
  width: number,
): string {
  const border = (s: string): string =>
    theme.fg(STATUS_TO_THEME_COLOR[status], s);
  const w = Math.max(1, width);
  const titleLines = titleAnsi.split("\n");
  const firstTitle = titleLines[0] ?? "";
  const continuations = titleLines.slice(1);

  // Layout: `╭` (1) + `──` (2) + ` ` (1) + title + ` ` (1) + trailing dashes (≥1)
  const minTrailing = 1;
  const fixed = 1 + 2 + 1 + 1 + minTrailing;
  const maxTitleW = Math.max(0, w - fixed);

  let title = firstTitle;
  let tw = visibleWidth(firstTitle);
  if (tw > maxTitleW) {
    title = truncateToWidth(firstTitle, maxTitleW, "…");
    tw = visibleWidth(title);
  }
  const trailing = Math.max(minTrailing, w - 1 - 2 - 1 - tw - 1);
  const firstLine = `${border("╭──")} ${title} ${border("─".repeat(trailing))}`;

  if (continuations.length === 0) return firstLine;

  // Continuation rows: rail + padding + sub-tree connector + space + content.
  // First line layout:
  //   col 1: `╭`
  //   cols 2-3: `──`
  //   col 4: literal space
  //   cols 5..: title (toolName + space + args…)
  // If the toolName ends at visible-offset N (i.e., the space is at offset N),
  // the first arg char sits at column N + 6 (1-indexed). We align the sub-tree
  // connector two columns before it (at contentCol - 2) and put the content
  // itself at the same column as the first row's first arg char, so the rows
  // read as a tree hanging off the title.
  const toolNameEnd = firstVisibleSpace(firstTitle);
  const contentCol = toolNameEnd >= 0 ? toolNameEnd + 6 : 6;
  const padBetween = " ".repeat(Math.max(0, contentCol - 4));
  const rail = border("│");
  const innerW = Math.max(1, w - contentCol + 1);
  const lastIdx = continuations.length - 1;

  const contLines = continuations.map((line, idx) => {
    const connectorChar = idx === lastIdx ? "╰" : "│";
    const connector = border(connectorChar);
    const fitted =
      visibleWidth(line) > innerW ? truncateToWidth(line, innerW, "…") : line;
    return `${rail}${padBetween}${connector} ${fitted}`;
  });

  return [firstLine, ...contLines].join("\n");
}

/** Render the bottom border of the frame: `╰─────────────`. */
export function frameBottom(
  status: FrameStatus,
  theme: Theme,
  width: number,
): string {
  const w = Math.max(1, width);
  const border = (s: string): string =>
    theme.fg(STATUS_TO_THEME_COLOR[status], s);
  return border(`╰${"─".repeat(Math.max(1, w - 1))}`);
}

/**
 * Render the bottom border with an inline label, mirroring `frameTop`:
 * `╰── <label> ──────`. Used to tuck a result summary (e.g., bash exit
 * status, web result counts) into the frame chrome instead of as the
 * first body line.
 */
export function frameBottomWithLabel(
  labelAnsi: string,
  status: FrameStatus,
  theme: Theme,
  width: number,
): string {
  const w = Math.max(1, width);
  const border = (s: string): string =>
    theme.fg(STATUS_TO_THEME_COLOR[status], s);
  const minTrailing = 1;
  const fixed = 1 + 2 + 1 + 1 + minTrailing;
  const maxLabelW = Math.max(0, w - fixed);

  let label = labelAnsi;
  let lw = visibleWidth(labelAnsi);
  if (lw > maxLabelW) {
    label = truncateToWidth(labelAnsi, maxLabelW, "…");
    lw = visibleWidth(label);
  }
  const trailing = Math.max(minTrailing, w - 1 - 2 - 1 - lw - 1);
  return `${border("╰──")} ${label} ${border("─".repeat(trailing))}`;
}

/**
 * Optional knobs accepted by every body-emitting helper
 * (`frameBodyLines`, `frameResult`, `frameResultWithBottomLabel`,
 * `renderToolError`).
 */
export interface FrameBodyOptions {
  /**
   * Spaces inserted between the left rail (`│`) and the line content.
   * Defaults to `0` (no gap), matching pi-facelift's tight `read` /
   * `bash` / `ls` / `find` / `grep` output. Set to `1` (or more) for a
   * looser layout where every body line reads as `│  <content>`. Inner
   * truncation width is reduced by the same amount so visible width
   * never exceeds the frame.
   */
  paddingX?: number;
}

/**
 * Prefix every line in `text` with the frame's left rail (`│`),
 * optionally followed by `paddingX` spaces. Each logical line is
 * right-truncated to `width - 1 - paddingX` columns so the visible
 * width including the rail never exceeds `width`.
 *
 * Embedded carriage returns (`\r`) are collapsed using terminal-style
 * overwrite semantics: only the content after the last `\r` on a line
 * is kept. Without this, sequences like `git rebase`'s
 * `Rebasing (1/1)\rSuccessfully rebased…` would clobber the rail when
 * the terminal honours `\r` as cursor-reset, leaving the line visibly
 * unprefixed.
 */
export function frameBodyLines(
  text: string,
  status: FrameStatus,
  theme: Theme,
  width: number,
  options?: FrameBodyOptions,
): string {
  const paddingX = Math.max(0, options?.paddingX ?? 0);
  const rail = theme.fg(STATUS_TO_THEME_COLOR[status], "│");
  const pad = " ".repeat(paddingX);
  const w = Math.max(1, width - 1 - paddingX);
  return text
    .split("\n")
    .map((line) => {
      // Terminal-style \r handling: keep only what survives after the last
      // carriage return so the rail isn't overwritten by progress messages.
      const lastCR = line.lastIndexOf("\r");
      const safeLine = lastCR >= 0 ? line.slice(lastCR + 1) : line;
      const fitted =
        safeLine && visibleWidth(safeLine) > w
          ? truncateToWidth(safeLine, w, "")
          : safeLine;
      return `${rail}${pad}${fitted}`;
    })
    .join("\n");
}

/**
 * Wrap `body` as the result-side of the frame: rail-prefixed lines +
 * bottom border. An empty `body` collapses to just the bottom border,
 * mirroring `frameResultWithBottomLabel` so the frame doesn't show an
 * empty rail row.
 */
export function frameResult(
  body: string,
  status: FrameStatus,
  theme: Theme,
  width: number,
  options?: FrameBodyOptions,
): string {
  const body_ = body
    ? `${frameBodyLines(body, status, theme, width, options)}\n`
    : "";
  return `${body_}${frameBottom(status, theme, width)}`;
}

/** Same as `frameResult` but embeds `label` inline in the bottom border. */
export function frameResultWithBottomLabel(
  body: string,
  labelAnsi: string,
  status: FrameStatus,
  theme: Theme,
  width: number,
  options?: FrameBodyOptions,
): string {
  const body_ = body
    ? `${frameBodyLines(body, status, theme, width, options)}\n`
    : "";
  return `${body_}${frameBottomWithLabel(labelAnsi, status, theme, width)}`;
}

/**
 * Convenience: render an error message as the entire result side of an
 * "error"-status frame. Equivalent to:
 *
 *     frameResult(theme.fg("error", message), "error", theme, width, options)
 */
export function renderToolError(
  message: string,
  theme: Theme,
  width: number,
  options?: FrameBodyOptions,
): string {
  return frameResult(
    theme.fg("error", message),
    "error",
    theme,
    width,
    options,
  );
}
