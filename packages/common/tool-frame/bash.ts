/**
 * @wierdbytes/pi-common/tool-frame/bash — the `bash` tool drawn in the
 * open-right tool frame, as pi-facelift draws it:
 *
 *     ╭── bash npm test ─────────────────────── t14s ─
 *     │ 12 passed
 *     ╰── 3.2s ✓ exit 0 (4 lines) ──────────────────
 *
 * The command sits in the top border (multi-line commands as a sub-tree
 * under it), the output is rail-prefixed, and the bottom border carries
 * the elapsed time (ticking while it runs), `✓ exit 0` / `✗ exit N` /
 * `⚡ timed out` / `⚡ aborted`, and the line count.
 *
 * Shared by pi-facelift (which replaces pi's `bash`) and pi-herdr (which
 * runs bash in herdr-core terminals), so both look the same:
 *
 *     pi.registerTool({
 *       ...createBashToolDefinition(cwd),
 *       ...createBashRenderers(),
 *     });
 *
 * Works with any bash result: pi's own (`Command exited with code N`
 * lifted from the text into the bottom border) or one carrying
 * {@link BashResultDetails}.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  formatDuration,
  frameResult,
  frameResultWithBottomLabel,
  frameTop,
  getDefaultFrameWidth,
  getFrameStatus,
} from "./index.ts";

/** Renderer state shared by the call and result renders of one bash call. */
export type BashRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  /** The running label currently drawn in the top border. */
  runningLabel?: string;
  labelRefresh?: ReturnType<typeof setTimeout>;
};

/** Result details pi-facelift's `bash` attaches: the output and the exit code it read from it. */
export type BashResultDetails = {
  _type: "bashResult";
  text: string;
  exitCode: number | null;
  command: string;
};

/**
 * The details pi-facelift attaches to a finished bash result: the text,
 * and the exit code read from pi's `Command exited with code N` (1 for
 * `command not found` / `No such file`, else 0).
 */
export function bashResultDetails(text: string, command: string): BashResultDetails {
  let exitCode: number | null = 0;
  if (text) {
    const exitMatch = text.match(/(?:exit code|exited with(?: code)?|exit status)[:\s]*(\d+)/i);
    if (exitMatch) exitCode = Number(exitMatch[1]);
    if (text.includes("command not found") || text.includes("No such file")) exitCode = 1;
  }
  return { _type: "bashResult", text, exitCode, command };
}

type TextLike = { setText(value: string): void };
type TextCtor<C extends TextLike> = new (text?: string, x?: number, y?: number) => C;

/** The parts of pi's `Theme` the renderers use (a structural subset, so tests can pass a plain object). */
export interface BashTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi?(key: string): string;
}

/** The parts of pi's `ToolRenderContext` the renderers use. */
export interface BashRenderContext {
  lastComponent?: unknown;
  state: BashRenderState;
  expanded: boolean;
  isError: boolean;
  isPartial?: boolean;
  executionStarted?: boolean;
  invalidate: () => void;
}

export interface BashToolArgs {
  command?: string;
  timeout?: number;
}

export interface BashToolResult {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export interface BashRenderersOptions<C extends TextLike> {
  /** The text component to draw into. Default: pi-tui's `Text`. */
  TextComponent?: TextCtor<C>;
  /** Output lines shown while the row is collapsed. Default 80. */
  maxPreviewLines?: number;
  /** Frame width. Default: the terminal's columns. */
  width?: () => number;
  /**
   * A label for the right of the top border while the command runs, read
   * from the details of its partial results (pi-herdr: the herdr-core
   * terminal it runs in). Gone once it finishes.
   */
  runningLabel?: (details: unknown) => string | undefined;
}

export interface BashRenderers<C extends TextLike> {
  renderShell: "self";
  renderCall(args: BashToolArgs, theme: BashTheme, ctx: BashRenderContext): C;
  renderResult(result: BashToolResult, options: { isPartial?: boolean; expanded?: boolean }, theme: BashTheme, ctx: BashRenderContext): C;
}

const FG_DIM = "\x1b[38;2;80;80;80m";
const FG_GREEN = "\x1b[38;2;100;180;120m";
const FG_RED = "\x1b[38;2;200;100;100m";
const FG_YELLOW = "\x1b[38;2;220;180;80m";
const BG_DEFAULT = "\x1b[49m";

const RGB_ANSI = /\x1b\[(?:38|48);2;\d+;\d+;\d+m/;

/**
 * The reset that ends coloured text: back to the theme's tool background
 * where the host paints tool rows with one, so the reset blends in.
 */
function resetFor(theme: BashTheme): string {
  if (!theme.getBgAnsi) return "\x1b[0m";
  const bg = (key: string): string | null => {
    try {
      const ansi = theme.getBgAnsi?.(key);
      return ansi && RGB_ANSI.test(ansi) ? ansi : null;
    } catch {
      return null;
    }
  };
  return `\x1b[0m${bg("toolBg") ?? bg("background") ?? BG_DEFAULT}`;
}

const textOf = (result: BashToolResult): string =>
  result.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n") ?? "";

const asTheme = (theme: BashTheme): Theme => theme as unknown as Theme;

/** `renderShell` / `renderCall` / `renderResult` for a bash tool, in the tool frame. */
export function createBashRenderers<C extends TextLike = Text>(options: BashRenderersOptions<C> = {}): BashRenderers<C> {
  const TextComponent = (options.TextComponent ?? Text) as TextCtor<C>;
  const maxPreviewLines = options.maxPreviewLines ?? 80;
  const width = options.width ?? (() => getDefaultFrameWidth());

  return {
    renderShell: "self",

    renderCall(args, theme, ctx) {
      const cmd = args.command ?? "";
      const t = (ctx.lastComponent as C | undefined) ?? new TextComponent("", 0, 0);
      const state = ctx.state;
      if (ctx.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const timeout = args.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";

      // Multi-line bash commands (shell line continuations with `\`, here-docs,
      // or embedded newlines) need each line wrapped in the accent color
      // separately so the color survives line splitting in `frameTop`. Leading
      // whitespace on continuation lines is dropped — the sub-tree connector
      // already provides visual indentation, so the user's heredoc indent
      // would just push content right and misalign the tree.
      //
      // The full command is always rendered in the title — no length-based
      // truncation in compact mode. `frameTop` still right-truncates any
      // individual line that exceeds the frame width, which is a separate
      // (display-fit) concern from hiding command content.
      const cmdLines = cmd.split("\n");
      const firstCmd = cmdLines[0];
      const restCmd = cmdLines.slice(1).map((line) => line.replace(/^\s+/, ""));
      const firstTitle = `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", firstCmd)}${timeout}`;
      const title = [firstTitle, ...restCmd.map((line) => theme.fg("accent", line))].join("\n");
      // The label belongs to the run: drawn only while it goes on.
      const label = ctx.isPartial && state.runningLabel ? theme.fg("muted", state.runningLabel) : undefined;
      t.setText(frameTop(title, getFrameStatus(ctx), asTheme(theme), width(), { rightLabel: label }));
      return t;
    },

    renderResult(result, opt, theme, ctx) {
      const RST = resetFor(theme);
      const t = (ctx.lastComponent as C | undefined) ?? new TextComponent("", 0, 0);
      const status = getFrameStatus(ctx);
      const frameTheme = asTheme(theme);
      const frameWidth = width();
      const state = ctx.state;

      // Live timer: tick every second while still streaming, freeze on final/error.
      const stillRunning = !!opt.isPartial && !ctx.isError;
      if (state.startedAt !== undefined && stillRunning && !state.interval) {
        state.interval = setInterval(() => ctx.invalidate(), 1000);
      }
      if (!stillRunning) {
        if (state.startedAt !== undefined) state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      // The call row was drawn before this result arrived: when the label
      // changes, draw the row again once this render is done.
      if (options.runningLabel) {
        const label = stillRunning ? options.runningLabel(result.details) : undefined;
        if (label !== state.runningLabel) {
          state.runningLabel = label;
          if (label && !state.labelRefresh) {
            state.labelRefresh = setTimeout(() => {
              state.labelRefresh = undefined;
              ctx.invalidate();
            }, 0);
          }
        }
      }

      // Resolve the body text + status (works for success, error, streaming, fallback).
      const d = result.details as Partial<BashResultDetails> | undefined;
      let bodyText = d?._type === "bashResult" ? (d.text ?? "") : textOf(result);
      let exitCode: number | null = d?._type === "bashResult" ? (d.exitCode ?? null) : null;
      let timedOut = false;
      let aborted = false;

      // pi's bash appends `Command exited with code N` / `Command timed out…` /
      // `Command aborted` to the result text on failure. Lift that line into the
      // bottom-border label so the body stays clean and the summary is consistent.
      const tail = bodyText.match(/(?:\n\n|^)Command (?:exited with code (\d+)|timed out after \d+ seconds|aborted)\s*$/);
      if (tail) {
        if (tail[1]) exitCode = Number(tail[1]);
        else if (/timed out/.test(tail[0])) timedOut = true;
        else if (/aborted/.test(tail[0])) aborted = true;
        bodyText = bodyText.slice(0, tail.index);
      }
      if (exitCode === null && !opt.isPartial && !ctx.isError) exitCode = 0;

      // Build the bottom-border label: `<duration> <icon> exit <N> (<lines>)`.
      const elapsedMs = state.startedAt !== undefined ? (state.endedAt ?? Date.now()) - state.startedAt : undefined;
      const durationStr = elapsedMs !== undefined ? `${FG_DIM}${formatDuration(elapsedMs)}${RST}` : "";

      let summary = "";
      if (!opt.isPartial) {
        if (timedOut) summary = `${FG_YELLOW}⚡ timed out${RST}`;
        else if (aborted) summary = `${FG_YELLOW}⚡ aborted${RST}`;
        else if (exitCode !== null) {
          const isOk = exitCode === 0;
          summary = `${isOk ? FG_GREEN : FG_RED}${isOk ? "✓" : "✗"} exit ${exitCode}${RST}`;
        }
      }

      const lines = bodyText.length > 0 ? bodyText.split("\n") : [];
      const lineCount = lines.length;
      const lineInfo = summary && lineCount > 1 ? ` ${FG_DIM}(${lineCount} lines)${RST}` : "";
      const labelParts = [durationStr, summary].filter(Boolean);
      const label = labelParts.length ? `${labelParts.join(" ")}${lineInfo}` : "";

      // Render body lines (preview-truncated when collapsed).
      const maxShow = ctx.expanded ? lineCount : maxPreviewLines;
      const show = lines.slice(0, Math.max(0, maxShow));
      const out: string[] = [...show];
      if (lineCount > maxShow) {
        out.push(`${FG_DIM}… ${lineCount - maxShow} more lines${RST}`);
      }
      const body = out.join("\n");

      if (label) {
        t.setText(frameResultWithBottomLabel(body, label, status, frameTheme, frameWidth));
      } else {
        t.setText(frameResult(body, status, frameTheme, frameWidth));
      }
      return t;
    },
  };
}
