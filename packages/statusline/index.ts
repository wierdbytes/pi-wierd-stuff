import {
  copyToClipboard,
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import type { EditorComponent } from "@mariozechner/pi-tui";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;
import type { AssistantMessage, Model, ThinkingLevelMap } from "@mariozechner/pi-ai";
import type { Component, EditorTheme, SelectItem, TUI } from "@mariozechner/pi-tui";
import { isKeyRelease, matchesKey, SelectList, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { NotifyLevel, NotifyStatusEvent, NotifyToastEvent } from "pi-wierd-events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { getGitStatus, invalidateGitStatus } from "./git-status.ts";
import {
  type EventsConfig,
  loadEventsConfig,
  setToastTimeout,
} from "./events-config.ts";
import { type ActiveToast, EventsTracker } from "./events-tracker.ts";
import { renderFixedEditorCluster } from "./fixed-editor/cluster.ts";
import { emergencyTerminalModeReset, TerminalSplitCompositor } from "./fixed-editor/terminal-split.ts";

const C_RED = "\x1b[38;2;247;118;142m";
const C_YELLOW = "\x1b[38;2;224;175;104m";
const C_GREEN = "\x1b[38;2;158;206;106m";
const C_CYAN = "\x1b[38;2;125;207;255m";
const C_BLUE = "\x1b[38;2;122;162;247m";
const C_PURPLE = "\x1b[38;2;187;154;247m";
const C_PINK = "\x1b[38;2;215;135;175m";
const C_ORANGE = "\x1b[38;2;255;158;100m";
const C_GRAY = "\x1b[38;2;86;95;137m";
const C_RESET = "\x1b[0m";

const THINK_COLORS: Record<string, string> = {
  off: C_GRAY,
  minimal: C_GRAY,
  low: C_BLUE,
  medium: C_CYAN,
  high: C_ORANGE,
  xhigh: C_RED,
};

const THINK_LABELS: Record<string, string> = {
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
};

const AUTOCOMPACT_BUFFER = 33000;
const BAR_WIDTH = 10;
const PROMPT_PADDING = 0;

function shortenPath(cwd: string): string {
  const segments = cwd.split("/");
  if (segments.length <= 3) return cwd;
  const n = segments.length;
  return `…/${segments[n - 3]}/${segments[n - 2]}/${segments[n - 1]}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function formatCost(cost: number): string {
  return cost.toFixed(2);
}

function buildBar(pct: number, pctColor: string): string {
  const clamped = Math.max(0, Math.min(100, pct));
  let filled = Math.floor((clamped * BAR_WIDTH) / 100);
  if (filled > BAR_WIDTH) filled = BAR_WIDTH;
  if (filled < 0) filled = 0;
  const empty = BAR_WIDTH - filled;
  return `${pctColor}${"▓".repeat(filled)}${C_GRAY}${"░".repeat(empty)}${C_RESET}`;
}

function pctColorFor(pct: number): string {
  if (pct > 80) return C_RED;
  if (pct > 60) return C_YELLOW;
  return C_GREEN;
}

function shortenModelName(model: { id?: string; name?: string } | undefined): string {
  let name = model?.name || model?.id || "no-model";
  if (name.startsWith("Claude ")) name = name.slice(7);
  if (name.startsWith("anthropic/")) name = name.slice("anthropic/".length);
  return name;
}

function resolveThinkingLabel(
  thinkingLevel: string,
  thinkingLevelMap: ThinkingLevelMap | undefined,
): string {
  const mapped = thinkingLevelMap?.[thinkingLevel as keyof ThinkingLevelMap];
  if (typeof mapped === "string" && mapped.length > 0) return mapped;
  return THINK_LABELS[thinkingLevel] ?? thinkingLevel;
}

/** Maximum visible width for a single chip's label (icon excluded). */
const CHIP_LABEL_MAX_WIDTH = 16;

/**
 * Collapse any whitespace (newlines, tabs, runs of spaces) in an
 * extension-supplied string down to a single space and trim the
 * result. Used before rendering free-form payload fields
 * (`title` / `message` / `label`) into a single statusline row —
 * a stray `\n` would otherwise survive `truncateToWidth` and break
 * the widget layout. The full original text is still kept in the
 * tracker's log for `/wierd-status events log`.
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Default toast-row icon when the payload omits one — keyed by level. */
const LEVEL_ICONS: Record<NotifyLevel, string> = {
  debug: "🔍",
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
};

/** ANSI color for a notification level. */
function levelColor(level: NotifyLevel | undefined): string {
  switch (level) {
    case "error":
      return C_RED;
    case "warning":
      return C_YELLOW;
    case "success":
      return C_GREEN;
    case "debug":
      return C_GRAY;
    case "info":
    default:
      return C_BLUE;
  }
}

/** Pick a chip icon, preferring the payload's icon, then a level default. */
function chipIcon(status: NotifyStatusEvent): string {
  if (status.icon) return status.icon;
  // For chips, fall back to a level-derived icon. "error" state without
  // explicit icon gets a warning glyph regardless of the optional `level`
  // field so the user always sees something is wrong.
  if (status.state === "error") return LEVEL_ICONS.warning;
  return LEVEL_ICONS[status.level ?? "info"];
}

/** Color hint for a chip — `state: "error"` always wins over the
 *  level so error chips render red even when no level is set. */
function chipColor(status: NotifyStatusEvent): string {
  if (status.state === "error") return C_RED;
  if (status.level) return levelColor(status.level);
  return C_CYAN;
}

/** Build the inline progress suffix for a chip. Width-aware: drops
 *  the unit / total when budget is tight. */
function formatChipProgress(
  progress: NotifyStatusEvent["progress"],
): string {
  if (!progress) return "";
  const { current, total, unit } = progress;
  if (typeof total === "number" && total > 0) {
    const num = `${current}/${total}`;
    return unit ? ` ${num}${unit}` : ` ${num}`;
  }
  return unit ? ` ${current}${unit}` : ` ${current}`;
}

/** Render a single chip as `<icon> <colored label><progress>`. */
function formatChip(status: NotifyStatusEvent): string {
  const icon = chipIcon(status);
  const color = chipColor(status);
  // Strip newlines / tabs from `label` before truncating so a
  // multi-line payload from any emitter can never split a chip
  // across rows.
  const label = truncateToWidth(oneLine(status.label), CHIP_LABEL_MAX_WIDTH, "…");
  const progressSuffix = formatChipProgress(status.progress);
  return `${icon} ${color}${label}${C_RESET}${progressSuffix}`;
}

/** Render the chips segment, including the `│` separator. Empty when no chips. */
function buildChipsSegment(chips: NotifyStatusEvent[]): string {
  if (chips.length === 0) return "";
  const rendered = chips.map(formatChip).join(` ${C_GRAY}·${C_RESET} `);
  return ` ${C_GRAY}│${C_RESET} ${rendered}`;
}

/**
 * Render the toast row. Returns a width-padded line so it occupies a
 * full terminal row.
 *
 * Layout: `<icon> <colored source>:<reset> <title> [— <message>]`
 *   - `source` is always shown as the colored prefix so the user
 *     immediately knows which extension fired the toast.
 *   - `title` is the primary content (when present).
 *   - `message` is appended after a gray `—` separator when both are
 *     set; if `title` is omitted, `message` becomes the headline.
 *
 * The optional `×` hint is appended for sticky toasts (lifetime 0)
 * so the user knows the toast stays until dismissed.
 */
function buildToastLine(active: ActiveToast, width: number): string {
  const event = active.event;
  const level = event.level ?? "info";
  const color = levelColor(level);
  const icon = event.icon || LEVEL_ICONS[level];
  const sticky = !Number.isFinite(active.expiresAt);
  const hint = sticky ? ` ${C_GRAY}×${C_RESET}` : "";

  // Sanitize free-form payload fields before composition: a stray
  // newline would otherwise survive `truncateToWidth` and corrupt
  // the single-row toast layout. Source is also collapsed defensively
  // even though it's almost always a package name.
  const safeSource = oneLine(event.source);
  const safeTitle = event.title ? oneLine(event.title) : "";
  const safeMessage = oneLine(event.message);

  const head = `${color}${safeSource}${C_RESET}${C_GRAY}:${C_RESET}`;
  let tail: string;
  if (safeTitle && safeMessage) {
    tail = `${safeTitle} ${C_GRAY}—${C_RESET} ${safeMessage}`;
  } else if (safeTitle) {
    tail = safeTitle;
  } else {
    tail = safeMessage;
  }

  const body = `${icon} ${head} ${tail}${hint}`;
  const truncated = truncateToWidth(body, width, "…");
  const fillWidth = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(fillWidth);
}

function buildStatusLine(opts: {
  cwd: string;
  branch: string | null;
  dirty: boolean;
  current: number;
  contextWindow: number;
  cost: number;
  modelName: string;
  thinkingLevel: string;
  thinkingLevelMap: ThinkingLevelMap | undefined;
  modelReasoning: boolean;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  stashCount: number;
  chipsSegment: string;
}): string {
  const {
    cwd,
    branch,
    dirty,
    current,
    contextWindow,
    cost,
    modelName,
    thinkingLevel,
    thinkingLevelMap,
    modelReasoning,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    stashCount,
    chipsSegment,
  } = opts;

  const modelPart = `🤖 ${C_PINK}${modelName}${C_RESET}`;

  let thinkPart = "";
  if (modelReasoning) {
    const label = resolveThinkingLabel(thinkingLevel, thinkingLevelMap);
    const color = THINK_COLORS[thinkingLevel] ?? C_GRAY;
    thinkPart = ` 🧠 ${color}${label}${C_RESET}`;
  }

  const shortDir = shortenPath(cwd);
  const dirParent = dirname(shortDir);
  const dirName = basename(shortDir) || shortDir;
  const dirPart = `${C_GRAY}${dirParent}${C_RESET}${C_PURPLE}/${dirName}${C_RESET}`;

  let gitPart = "";
  if (branch) {
    const mark = dirty ? `${C_RED}✗${C_RESET}` : `${C_GREEN}✓${C_RESET}`;
    gitPart = ` ${C_GRAY}│${C_RESET}${C_CYAN} ${branch} ${mark}`;
  }

  let contextPart = "";
  if (contextWindow > 0) {
    const threshold = Math.max(1, contextWindow - AUTOCOMPACT_BUFFER);
    let pct = Math.floor((current * 100) / threshold);
    let remaining = threshold - current;
    if (remaining < 0) {
      remaining = 0;
      pct = 100;
    }
    if (pct < 0) pct = 0;
    const color = pctColorFor(pct);
    const bar = buildBar(pct, color);
    contextPart =
      ` ${C_GRAY}│${C_RESET} ${color}${pct}%${C_RESET}: ${formatTokens(current)}` +
      `${C_GRAY}[${C_RESET}${bar}${C_GRAY}]${C_RESET}${formatTokens(remaining)}`;
  }

  let costPart = "";
  if (cost > 0) {
    costPart = ` ${C_GRAY}│ \$${formatCost(cost)}${C_RESET}`;
  }

  const tokenSegments: string[] = [];
  if (totalInput) tokenSegments.push(`↑${formatTokens(totalInput)}`);
  if (totalOutput) tokenSegments.push(`↓${formatTokens(totalOutput)}`);
  if (totalCacheRead) tokenSegments.push(`R${formatTokens(totalCacheRead)}`);
  if (totalCacheWrite) tokenSegments.push(`W${formatTokens(totalCacheWrite)}`);
  const tokensPart = tokenSegments.length
    ? ` ${C_GRAY}│ ${tokenSegments.join(" ")}${C_RESET}`
    : "";

  const stashPart = stashCount > 0 ? ` ${C_GRAY}│${C_RESET} ${C_YELLOW}📦 ${stashCount}${C_RESET}` : "";

  return `${C_GRAY}─${C_RESET} ${modelPart}${thinkPart} ${C_GRAY}│${C_RESET} ${dirPart}${gitPart}${contextPart}${costPart}${tokensPart}${chipsSegment}${stashPart} `;
}

function gatherStats(ctx: ExtensionContext) {
  let cost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let lastAssistant: AssistantMessage | undefined;

  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      const m = e.message as AssistantMessage;
      cost += m.usage.cost.total;
      totalInput += m.usage.input;
      totalOutput += m.usage.output;
      totalCacheRead += m.usage.cacheRead;
      totalCacheWrite += m.usage.cacheWrite;
      if (
        m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite > 0
      ) {
        lastAssistant = m;
      }
    }
  }

  return { cost, totalInput, totalOutput, totalCacheRead, totalCacheWrite, lastAssistant };
}

function renderStatusContent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  width: number,
  stashCount: number,
  events: { chips: NotifyStatusEvent[]; toast: ActiveToast | null },
): string[] {
  const stats = gatherStats(ctx);
  const contextWindow =
    ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const current = stats.lastAssistant
    ? stats.lastAssistant.usage.input +
      stats.lastAssistant.usage.cacheRead +
      stats.lastAssistant.usage.cacheWrite
    : 0;
  const git = getGitStatus(ctx.cwd);

  const model = ctx.model as Model<any> | undefined;
  const status = buildStatusLine({
    cwd: ctx.cwd,
    branch: git.branch,
    dirty: git.dirty,
    current,
    contextWindow,
    cost: stats.cost,
    modelName: shortenModelName(ctx.model),
    thinkingLevel: pi.getThinkingLevel?.() ?? "off",
    thinkingLevelMap: model?.thinkingLevelMap,
    modelReasoning: ctx.model?.reasoning ?? false,
    totalInput: stats.totalInput,
    totalOutput: stats.totalOutput,
    totalCacheRead: stats.totalCacheRead,
    totalCacheWrite: stats.totalCacheWrite,
    stashCount,
    chipsSegment: buildChipsSegment(events.chips),
  });

  const truncated = truncateToWidth(status, width);
  const fillWidth = Math.max(0, width - visibleWidth(truncated));
  const statusLine = truncated + `${C_GRAY}${"─".repeat(fillWidth)}${C_RESET}`;

  if (events.toast) {
    return [buildToastLine(events.toast, width), statusLine];
  }
  return [statusLine];
}

function makeEditorFactory(
  ctx: ExtensionContext,
  setActiveTui: (tui: TUI | undefined) => void,
  setCurrentEditor: (editor: any) => void,
  onEditorMounted: (editor: any) => void,
): EditorFactory {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
    setActiveTui(tui);

    class WierdStatuslineEditor extends CustomEditor {
      constructor() {
        super(tui, theme, keybindings, { paddingX: PROMPT_PADDING });
      }

      setPaddingX(_value: number): void {
        super.setPaddingX(PROMPT_PADDING);
      }

      render(width: number): string[] {
        const lines = super.render(width);
        if (lines.length === 0) return lines;

        const stripAnsi = (s: string) =>
          s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
        const isBorder = (s: string) => /^[─━]+\s*$/.test(s);

        if (isBorder(stripAnsi(lines[0]))) lines.shift();

        for (let i = lines.length - 1; i >= 0; i--) {
          if (isBorder(stripAnsi(lines[i]))) {
            lines.splice(i, 1);
            break;
          }
        }

        return lines;
      }
    }

    const editor = new WierdStatuslineEditor();
    const originalRender = editor.render.bind(editor);
    editor.render = (width: number): string[] => {
      const lines = originalRender(width);
      onEditorMounted(editor);
      return lines;
    };
    setCurrentEditor(editor);
    return editor;
  };
}

class EmptyFooter implements Component {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

function hidePiFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter(() => new EmptyFooter());
}

function restorePiFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter(undefined);
}

function installStatusWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getStashCount: () => number,
  getEventsSnapshot: () => { chips: NotifyStatusEvent[]; toast: ActiveToast | null },
) {
  ctx.ui.setWidget(
    "wierd-statusline",
    () => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return renderStatusContent(
          pi,
          ctx,
          width,
          getStashCount(),
          getEventsSnapshot(),
        );
      },
    }),
    { placement: "aboveEditor" },
  );
}

function isStashShortcutInput(data: string): boolean {
  if (isKeyRelease(data)) return false;
  return (
    data === "ß" ||
    data === "\x1bs" ||
    data === "\x1bS" ||
    /^\x1b\[(?:83|115)(?::\d*)?(?::\d*)?;3(?::\d+)?u$/.test(data) ||
    data === "\x1b[27;3;115~" ||
    data === "\x1b[27;3;83~" ||
    matchesKey(data, "alt+s")
  );
}

function isStashHistoryShortcutInput(data: string): boolean {
  if (isKeyRelease(data)) return false;
  return (
    matchesKey(data, "ctrl+alt+s") ||
    /^\x1b\[(?:115|83)(?::\d*)?(?::\d*)?;7(?::\d+)?u$/.test(data) ||
    data === "\x1b[27;7;115~" ||
    data === "\x1b[27;7;83~"
  );
}

function hasNonWhitespaceText(text: string): boolean {
  return text.trim().length > 0;
}

const STASH_HISTORY_LIMIT = 12;
const STASH_PREVIEW_WIDTH = 72;

function getStashHistoryPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "wierd-statusline", "stash-history.json");
}

function normalizeStashHistoryEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const history: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (!hasNonWhitespaceText(entry)) continue;
    if (history[history.length - 1] === entry) continue;
    history.push(entry);
    if (history.length >= STASH_HISTORY_LIMIT) break;
  }
  return history;
}

function readPersistedStashHistory(): string[] {
  const path = getStashHistoryPath();
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return normalizeStashHistoryEntries((parsed as { history?: unknown }).history);
  } catch {
    return [];
  }
}

function persistStashHistory(history: string[]): void {
  const path = getStashHistoryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, history: history.slice(0, STASH_HISTORY_LIMIT) }, null, 2) + "\n",
    );
  } catch {
    // Stash history persistence is best-effort.
  }
}

function pushStashHistoryEntry(history: string[], text: string): boolean {
  if (!hasNonWhitespaceText(text)) return false;
  if (history[0] === text) return false;
  const existingIndex = history.indexOf(text);
  if (existingIndex >= 0) history.splice(existingIndex, 1);
  history.unshift(text);
  if (history.length > STASH_HISTORY_LIMIT) history.length = STASH_HISTORY_LIMIT;
  return true;
}

function buildStashPreview(text: string, maxWidth: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty)";
  return truncateToWidth(compact, maxWidth, "…");
}

function overlaySelectListTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

async function showStashHistoryOverlay(
  ctx: ExtensionContext,
  history: string[],
  onDelete: (text: string) => void,
): Promise<string | null> {
  const entries = [...history];
  const buildItems = (): SelectItem[] =>
    entries.map((entry, index) => ({
      value: String(index),
      label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
    }));

  const selected = await ctx.ui.custom<SelectItem | null>(
    (tui, theme, _keybindings, done) => {
      const maxVisible = Math.min(Math.max(entries.length, 1), 10);
      let selectList = new SelectList(buildItems(), maxVisible, overlaySelectListTheme(theme));
      selectList.onSelect = (item) => done(item);
      selectList.onCancel = () => done(null);

      const border = (text: string) => theme.fg("dim", text);
      const wrapRow = (text: string, innerWidth: number): string =>
        `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;

      const rebuild = (focusIndex: number) => {
        if (entries.length === 0) {
          done(null);
          return;
        }
        const next = new SelectList(buildItems(), Math.min(entries.length, 10), overlaySelectListTheme(theme));
        next.onSelect = (item) => done(item);
        next.onCancel = () => done(null);
        next.setSelectedIndex(Math.max(0, Math.min(focusIndex, entries.length - 1)));
        selectList = next;
        tui.requestRender();
      };

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(1, width - 2);
          const lines: string[] = [];
          lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
          lines.push(wrapRow(theme.fg("accent", theme.bold("Stash history")), innerWidth));
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          for (const line of selectList.render(innerWidth)) lines.push(wrapRow(line, innerWidth));
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          lines.push(
            wrapRow(theme.fg("dim", "↑↓ navigate • enter insert • d delete • esc cancel"), innerWidth),
          );
          lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
          return lines;
        },
        invalidate(): void {
          selectList.invalidate();
        },
        handleInput(data: string): void {
          if (data === "d" || data === "D") {
            const item = selectList.getSelectedItem();
            if (!item) return;
            const idx = Number.parseInt(item.value, 10);
            const text = entries[idx];
            if (text === undefined) return;
            entries.splice(idx, 1);
            onDelete(text);
            rebuild(idx);
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: () => ({ anchor: "center" }),
    },
  );

  if (!selected) return null;
  const i = Number.parseInt(selected.value, 10);
  return entries[i] ?? null;
}

async function insertStashHistoryEntry(ctx: ExtensionContext, selected: string): Promise<boolean> {
  const currentText = ctx.ui.getEditorText();
  if (!hasNonWhitespaceText(currentText)) {
    ctx.ui.setEditorText(selected);
    ctx.ui.notify("Inserted prompt", "info");
    return true;
  }

  const action = await ctx.ui.select("Insert prompt", ["Replace", "Append", "Cancel"]);
  if (action === "Replace") {
    ctx.ui.setEditorText(selected);
    ctx.ui.notify("Replaced editor with prompt", "info");
    return true;
  }
  if (action === "Append") {
    const separator = currentText.endsWith("\n") || selected.startsWith("\n") ? "" : "\n";
    ctx.ui.setEditorText(`${currentText}${separator}${selected}`);
    ctx.ui.notify("Appended prompt", "info");
    return true;
  }
  return false;
}

function findContainerWithChild(tui: any, child: any): { container: any; index: number } | null {
  const children = Array.isArray(tui?.children) ? tui.children : [];
  const index = children.findIndex(
    (candidate: any) => Array.isArray(candidate?.children) && candidate.children.includes(child),
  );
  if (index === -1) return null;
  return { container: children[index], index };
}

export default function (pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  const setActiveTui = (tui: TUI | undefined) => {
    activeTui = tui;
  };

  let currentEditor: any = null;
  const setCurrentEditor = (editor: any) => {
    currentEditor = editor;
  };

  const tryInstallFixedEditor = () => {
    if (!statuslineEnabled || !fixedEditorEnabled) return;
    if (fixedEditorCompositor) return;
    if (!activeTui || !currentCtx || !currentEditor) return;
    if (!findContainerWithChild(activeTui, currentEditor)) return;
    installFixedEditorCompositor(currentCtx, activeTui);
  };

  let fixedEditorCompositor: TerminalSplitCompositor | null = null;
  let fixedEditorContainer: any = null;
  let fixedStatusContainer: any = null;
  let fixedWidgetContainerAbove: any = null;
  let fixedWidgetContainerBelow: any = null;
  let fixedFooterComponent: any = null;
  let currentCtx: ExtensionContext | undefined;

  let footerHidden = true;
  let statuslineEnabled = true;
  let fixedEditorEnabled = true;
  let mouseScrollEnabled = true;

  let stashedEditorText: string | null = null;
  let stashedPromptHistory: string[] = readPersistedStashHistory();
  let stashShortcutUnsubscribe: (() => void) | null = null;

  const getStashCount = () => stashedPromptHistory.length;

  // ───────────────────────── events tracker ─────────────────────────
  //
  // The tracker subscribes **eagerly at extension load time** — not
  // from `enableStatusline` — so we don't miss `notify:*` events that
  // sibling extensions emit from their own `session_start` handlers
  // when they happen to be loaded before us. Otherwise we'd race the
  // load order and the statusline could come up showing no chips even
  // though voice / web / etc. already announced their state.
  //
  // Rendering (`onChange → activeTui.requestRender()`) is still bound
  // to the statusline being mounted, since there's nothing to repaint
  // when the user has run `/wierd-status off`.

  let eventsConfig: EventsConfig = loadEventsConfig();
  const eventsTracker = new EventsTracker(pi, () => eventsConfig);
  eventsTracker.start();
  let eventsTrackerOff: (() => void) | null = null;

  const getEventsSnapshot = () => {
    const snap = eventsTracker.getSnapshot();
    return { chips: snap.chips, toast: snap.toast };
  };

  const removeStashEntry = (text: string) => {
    const idx = stashedPromptHistory.indexOf(text);
    if (idx >= 0) {
      stashedPromptHistory.splice(idx, 1);
      persistStashHistory(stashedPromptHistory);
    }
    if (stashedEditorText === text) stashedEditorText = null;
  };

  const popLatestStash = (): string | null => {
    const text = stashedEditorText ?? stashedPromptHistory[0] ?? null;
    if (text !== null) removeStashEntry(text);
    return text;
  };

  const stashOrRestoreEditorText = (ctx: ExtensionContext) => {
    const rawText = ctx.ui.getEditorText();

    if (!hasNonWhitespaceText(rawText)) {
      const popped = popLatestStash();
      if (popped === null) {
        ctx.ui.notify("Nothing to stash", "info");
        return;
      }
      ctx.ui.setEditorText(popped);
      ctx.ui.notify("Stash restored", "info");
      activeTui?.requestRender();
      return;
    }

    const hadStash = stashedEditorText !== null;
    stashedEditorText = rawText;
    if (pushStashHistoryEntry(stashedPromptHistory, rawText)) {
      persistStashHistory(stashedPromptHistory);
    }
    ctx.ui.setEditorText("");
    ctx.ui.notify(hadStash ? "Stash updated" : "Text stashed", "info");
    activeTui?.requestRender();
  };

  const openStashHistoryPicker = async (ctx: ExtensionContext) => {
    if (stashedPromptHistory.length === 0) {
      ctx.ui.notify("No stashed prompts yet", "info");
      return;
    }
    const selected = await showStashHistoryOverlay(
      ctx,
      [...stashedPromptHistory],
      removeStashEntry,
    );
    if (selected && (await insertStashHistoryEntry(ctx, selected))) {
      removeStashEntry(selected);
    }
    activeTui?.requestRender();
  };

  function teardownFixedEditorCompositor(options?: { resetExtendedKeyboardModes?: boolean }) {
    const hadCompositor = fixedEditorCompositor !== null;
    fixedEditorCompositor?.dispose(options);
    if (!hadCompositor && options?.resetExtendedKeyboardModes) {
      try {
        process.stdout.write(emergencyTerminalModeReset());
      } catch {
        // Shutdown cleanup cannot surface useful terminal write failures.
      }
    }
    fixedEditorCompositor = null;
    fixedEditorContainer = null;
    fixedStatusContainer = null;
    fixedWidgetContainerAbove = null;
    fixedWidgetContainerBelow = null;
    fixedFooterComponent = null;
  }

  function installFixedEditorCompositor(ctx: ExtensionContext, tui: any) {
    teardownFixedEditorCompositor();

    if (!ctx.hasUI || !fixedEditorEnabled) return;
    if (!tui?.terminal || typeof tui.terminal.write !== "function") return;
    if (!currentEditor) return;

    const editorContainerMatch = findContainerWithChild(tui, currentEditor);
    if (!editorContainerMatch) return;

    const tuiChildren = Array.isArray(tui.children) ? tui.children : [];
    fixedEditorContainer = editorContainerMatch.container;
    const statusContainerCandidate = tuiChildren[editorContainerMatch.index - 2] ?? null;
    fixedStatusContainer =
      statusContainerCandidate && typeof statusContainerCandidate.render === "function"
        ? statusContainerCandidate
        : null;
    fixedWidgetContainerAbove = tuiChildren[editorContainerMatch.index - 1] ?? null;
    fixedWidgetContainerBelow = tuiChildren[editorContainerMatch.index + 1] ?? null;
    const footerCandidate = tuiChildren[editorContainerMatch.index + 2] ?? null;
    fixedFooterComponent =
      footerCandidate && typeof footerCandidate.render === "function" ? footerCandidate : null;

    const compositor: TerminalSplitCompositor = new TerminalSplitCompositor({
      tui,
      terminal: tui.terminal,
      mouseScroll: mouseScrollEnabled,
      onCopySelection: (text) => {
        void copyToClipboard(text).catch(() => {});
      },
      getShowHardwareCursor: () =>
        typeof tui.getShowHardwareCursor === "function" && tui.getShowHardwareCursor(),
      renderCluster: (width, terminalRows) => {
        const statusContainerLines = fixedStatusContainer
          ? compositor.renderHidden(fixedStatusContainer, width).filter((line) => visibleWidth(line) > 0)
          : [];
        const aboveWidgetLines = fixedWidgetContainerAbove
          ? compositor.renderHidden(fixedWidgetContainerAbove, width)
          : [];
        const belowWidgetLines = fixedWidgetContainerBelow
          ? compositor.renderHidden(fixedWidgetContainerBelow, width)
          : [];
        const footerLines = fixedFooterComponent
          ? compositor.renderHidden(fixedFooterComponent, width).filter((line) => visibleWidth(line) > 0)
          : [];
        return renderFixedEditorCluster({
          width,
          terminalRows,
          statusLines: [...statusContainerLines, ...aboveWidgetLines],
          editorLines: fixedEditorContainer ? compositor.renderHidden(fixedEditorContainer, width) : [],
          secondaryLines: [...belowWidgetLines, ...footerLines],
        });
      },
    });

    fixedEditorCompositor = compositor;
    if (fixedStatusContainer?.render) compositor.hideRenderable(fixedStatusContainer);
    if (fixedWidgetContainerAbove?.render) compositor.hideRenderable(fixedWidgetContainerAbove);
    compositor.hideRenderable(fixedEditorContainer);
    if (fixedWidgetContainerBelow?.render) compositor.hideRenderable(fixedWidgetContainerBelow);
    if (fixedFooterComponent?.render) compositor.hideRenderable(fixedFooterComponent);
    compositor.install();
    tui.requestRender(true);
  }

  pi.on("thinking_level_select", async () => {
    activeTui?.requestRender();
  });

  pi.on("tool_result", async () => {
    invalidateGitStatus();
    activeTui?.requestRender();
  });

  pi.on("session_shutdown", async () => {
    teardownFixedEditorCompositor({ resetExtendedKeyboardModes: true });
    stashShortcutUnsubscribe?.();
    stashShortcutUnsubscribe = null;
    // Drop only the render hook — do NOT dispose the events tracker.
    //
    // pi can run multiple sessions inside one extension-host process
    // (`session_shutdown` followed by another `session_start`).
    // Disposing here would tear down the bus subscription too, and a
    // subsequent session_start only re-attaches the render hook — so
    // chips and toasts would silently stop arriving for every session
    // after the first. The tracker is process-scoped on purpose; its
    // tick timer is `unref`'d so it never blocks process exit.
    eventsTrackerOff?.();
    eventsTrackerOff = null;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (stashedEditorText === null) return;
    if (ctx.ui.getEditorText().trim() === "") {
      const popped = popLatestStash();
      if (popped !== null) {
        ctx.ui.setEditorText(popped);
        ctx.ui.notify("Stash restored", "info");
        activeTui?.requestRender();
      }
    } else {
      ctx.ui.notify("Stash preserved — clear editor then Alt+S to restore", "info");
    }
  });

  const enableStatusline = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    installStatusWidget(pi, ctx, getStashCount, getEventsSnapshot);
    ctx.ui.setEditorComponent(makeEditorFactory(ctx, setActiveTui, setCurrentEditor, tryInstallFixedEditor));
    if (footerHidden) hidePiFooter(ctx);
    else restorePiFooter(ctx);

    // The tracker is already collecting events (started eagerly at
    // extension load); here we only attach the render hook so chip /
    // toast changes repaint the statusline. Calling `requestRender()`
    // once now also flushes any state the tracker accumulated before
    // the UI was mounted.
    eventsTrackerOff?.();
    eventsTrackerOff = eventsTracker.onChange(() => {
      activeTui?.requestRender();
    });
    activeTui?.requestRender();

    stashShortcutUnsubscribe?.();
    stashShortcutUnsubscribe =
      typeof ctx.ui.onTerminalInput === "function"
        ? ctx.ui.onTerminalInput((data) => {
            if (!statuslineEnabled || !ctx.hasUI || activeTui?.hasOverlay?.()) return undefined;
            if (isStashShortcutInput(data)) {
              stashOrRestoreEditorText(ctx);
              activeTui?.requestRender();
              return { consume: true };
            }
            if (isStashHistoryShortcutInput(data)) {
              void openStashHistoryPicker(ctx);
              return { consume: true };
            }
            return undefined;
          })
        : null;
  };

  const disableStatusline = (ctx: ExtensionContext) => {
    teardownFixedEditorCompositor();
    ctx.ui.setWidget("wierd-statusline", undefined);
    ctx.ui.setEditorComponent(undefined);
    restorePiFooter(ctx);
    stashShortcutUnsubscribe?.();
    stashShortcutUnsubscribe = null;
    // Detach the render hook only; keep the tracker subscribed to the
    // bus so we don't miss events while the statusline is hidden —
    // when it comes back, the latest chip / toast state is already
    // there waiting to be rendered.
    eventsTrackerOff?.();
    eventsTrackerOff = null;
    currentEditor = null;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (statuslineEnabled) enableStatusline(ctx);
  });

  const handleEventsSubcommand = (
    ctx: ExtensionContext,
    tokens: string[],
  ): void => {
    const sub = tokens[1];

    if (!sub || sub === "status") {
      const snap = eventsTracker.getSnapshot();
      const lines = [
        `chips:    ${snap.chips.length}`,
        `toast:    ${snap.toast ? `${snap.toast.event.level ?? "info"} — ${snap.toast.event.message}` : "(none)"}`,
        `log:      ${eventsTracker.getLog().length} entries`,
        `timeouts: ${Object.entries(eventsConfig.toastTimeouts)
          .map(([level, ms]) => `${level}=${ms === 0 ? "sticky" : `${ms}ms`}`)
          .join(" ")}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    if (sub === "log") {
      const log = eventsTracker.getLog().slice(0, 16);
      if (log.length === 0) {
        ctx.ui.notify("events: log is empty", "info");
        return;
      }
      const formatted = log
        .map((e) => {
          const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 19) : "--:--:--";
          const level = e.level ?? "info";
          const title = e.title || e.source;
          return `${ts} [${level}] ${title}: ${e.message}`;
        })
        .join("\n");
      ctx.ui.notify(formatted, "info");
      return;
    }

    if (sub === "clear") {
      eventsTracker.clearAll();
      ctx.ui.notify("events: cleared chips and toast", "info");
      return;
    }

    if (sub === "toast-ms") {
      const levelArg = tokens[2];
      const msArg = tokens[3];

      // Bare `events toast-ms` prints the current map.
      if (!levelArg) {
        const lines = Object.entries(eventsConfig.toastTimeouts).map(
          ([level, ms]) => `  ${level.padEnd(8)} ${ms === 0 ? "sticky" : `${ms}ms`}`,
        );
        ctx.ui.notify(`toast timeouts:\n${lines.join("\n")}`, "info");
        return;
      }

      const validLevels: NotifyLevel[] = ["debug", "info", "success", "warning", "error"];
      if (!validLevels.includes(levelArg as NotifyLevel)) {
        ctx.ui.notify(
          `events toast-ms: unknown level '${levelArg}'. Expected one of: ${validLevels.join(", ")}.`,
          "warning",
        );
        return;
      }
      if (!msArg) {
        ctx.ui.notify(
          "Usage: /wierd-status events toast-ms <level> <ms>  (use 0 for sticky)",
          "warning",
        );
        return;
      }
      const ms = Number.parseInt(msArg, 10);
      if (!Number.isFinite(ms) || ms < 0) {
        ctx.ui.notify(
          `events toast-ms: invalid duration '${msArg}'. Expected a non-negative integer.`,
          "warning",
        );
        return;
      }
      eventsConfig = setToastTimeout(eventsConfig, levelArg as NotifyLevel, ms);
      ctx.ui.notify(
        `events: ${levelArg} toasts now ${ms === 0 ? "sticky until dismissed" : `expire in ${ms}ms`}`,
        "info",
      );
      return;
    }

    ctx.ui.notify(
      "Usage: /wierd-status events [status | log | clear | toast-ms [<level> <ms>]]",
      "info",
    );
  };

  pi.registerCommand("wierd-status", {
    description:
      "Wierd statusline controls. Subcommands: 'on' | 'off' | 'toggle' | 'footer on|off|toggle' | 'fixed-editor on|off|toggle' | 'mouse-scroll on|off|toggle' | 'events [status|log|clear|toast-ms]'",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = tokens[0];

      if (cmd === "on" || cmd === "off" || cmd === "toggle") {
        const next = cmd === "toggle" ? !statuslineEnabled : cmd === "on";
        statuslineEnabled = next;
        if (statuslineEnabled) enableStatusline(ctx);
        else disableStatusline(ctx);
        ctx.ui.notify(`wierd statusline ${statuslineEnabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (cmd === "footer") {
        const action = tokens[1] ?? "toggle";
        if (action === "toggle") footerHidden = !footerHidden;
        else if (action === "on") footerHidden = false;
        else if (action === "off") footerHidden = true;
        else {
          ctx.ui.notify(`Unknown footer action: ${action}`, "warning");
          return;
        }
        if (statuslineEnabled) {
          if (footerHidden) hidePiFooter(ctx);
          else restorePiFooter(ctx);
          // Footer toggle replaces the component in tui.children, so the
          // compositor's captured reference is stale; reinstall to capture
          // the new footer (or EmptyFooter) and render it under the editor.
          if (fixedEditorEnabled && activeTui) {
            installFixedEditorCompositor(ctx, activeTui);
          }
        }
        ctx.ui.notify(`pi footer ${footerHidden ? "hidden" : "shown"}`, "info");
        return;
      }

      if (cmd === "fixed-editor") {
        const action = tokens[1] ?? "toggle";
        if (action === "toggle") fixedEditorEnabled = !fixedEditorEnabled;
        else if (action === "on") fixedEditorEnabled = true;
        else if (action === "off") fixedEditorEnabled = false;
        else {
          ctx.ui.notify(`Unknown fixed-editor action: ${action}`, "warning");
          return;
        }
        if (statuslineEnabled && activeTui) {
          if (fixedEditorEnabled) {
            installFixedEditorCompositor(ctx, activeTui);
          } else {
            teardownFixedEditorCompositor();
            activeTui.requestRender(true);
          }
        }
        ctx.ui.notify(`fixed editor ${fixedEditorEnabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (cmd === "events") {
        handleEventsSubcommand(ctx, tokens);
        return;
      }

      if (cmd === "mouse-scroll") {
        const action = tokens[1] ?? "toggle";
        if (action === "toggle") mouseScrollEnabled = !mouseScrollEnabled;
        else if (action === "on") mouseScrollEnabled = true;
        else if (action === "off") mouseScrollEnabled = false;
        else {
          ctx.ui.notify(`Unknown mouse-scroll action: ${action}`, "warning");
          return;
        }
        if (statuslineEnabled && fixedEditorEnabled && activeTui) {
          installFixedEditorCompositor(ctx, activeTui);
        }
        ctx.ui.notify(`mouse scroll ${mouseScrollEnabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /wierd-status <on|off|toggle> | footer <on|off|toggle> | fixed-editor <on|off|toggle> | mouse-scroll <on|off|toggle> | events [status|log|clear|toast-ms]",
        "info",
      );
    },
  });
}
