/**
 * @wierdbytes/pi-statusline — per-block renderers + composer.
 *
 * Each `BlockRenderer` is a pure function that turns the shared
 * `RenderInputs` bundle into a "clean" ANSI string with **no leading
 * or trailing separator and no leading space**. An empty string means
 * "skip me" (e.g. git block outside a repo, tokens block with all
 * sub-toggles off).
 *
 * `composeStatusLine` walks `layout.order`, calls each renderer
 * whose `enabled` flag is on, drops empty results, and joins the
 * remaining pieces with the configured separator glyph wrapped in a
 * space on each side. The leading `─ ` divider is always first.
 *
 * The chip and toast formatting helpers + color constants live here
 * too so the toast row renderer (in `index.ts`) and the `chips` block
 * share a single source of truth.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { NotifyLevel, NotifyStatusEvent } from "@wierdbytes/pi-events";
import { basename, dirname } from "node:path";

import type { IconKey, IconSet } from "./icons.ts";
import { resolveIcon } from "./icons.ts";
import type { LayoutConfig } from "./layout-config.ts";

// ─────────────────────────────────────────────────────────────────────
// Color constants (Tokyo Night Storm palette)
// ─────────────────────────────────────────────────────────────────────

export const C_RED = "\x1b[38;2;247;118;142m";
export const C_YELLOW = "\x1b[38;2;224;175;104m";
export const C_GREEN = "\x1b[38;2;158;206;106m";
export const C_CYAN = "\x1b[38;2;125;207;255m";
export const C_BLUE = "\x1b[38;2;122;162;247m";
export const C_PURPLE = "\x1b[38;2;187;154;247m";
export const C_PINK = "\x1b[38;2;215;135;175m";
export const C_ORANGE = "\x1b[38;2;255;158;100m";
export const C_GRAY = "\x1b[38;2;86;95;137m";
export const C_RESET = "\x1b[0m";

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

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const AUTOCOMPACT_BUFFER = 33000;
const BAR_WIDTH = 10;
const CHIP_LABEL_MAX_WIDTH = 16;

// ─────────────────────────────────────────────────────────────────────
// Generic format helpers (shared with the toast line)
// ─────────────────────────────────────────────────────────────────────

/**
 * Collapse any whitespace (newlines, tabs, runs of spaces) in an
 * extension-supplied string down to a single space and trim the
 * result. Used before rendering free-form payload fields
 * (`title` / `message` / `label`) into a single statusline row —
 * a stray `\n` would otherwise survive `truncateToWidth` and break
 * the widget layout.
 */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function shortenPath(cwd: string): string {
  const segments = cwd.split("/");
  if (segments.length <= 3) return cwd;
  const n = segments.length;
  return `…/${segments[n - 3]}/${segments[n - 2]}/${segments[n - 1]}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

export function formatCost(cost: number): string {
  return cost.toFixed(2);
}

export function shortenModelName(model: { id?: string; name?: string } | undefined): string {
  let name = model?.name || model?.id || "no-model";
  if (name.startsWith("Claude ")) name = name.slice(7);
  if (name.startsWith("anthropic/")) name = name.slice("anthropic/".length);
  return name;
}

export function resolveThinkingLabel(
  thinkingLevel: string,
  thinkingLevelMap: ThinkingLevelMap | undefined,
): string {
  const mapped = thinkingLevelMap?.[thinkingLevel as keyof ThinkingLevelMap];
  if (typeof mapped === "string" && mapped.length > 0) return mapped;
  return THINK_LABELS[thinkingLevel] ?? thinkingLevel;
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

// ─────────────────────────────────────────────────────────────────────
// Level / chip / toast formatting helpers (shared with index.ts)
// ─────────────────────────────────────────────────────────────────────

/** Map a notification level to its icon-key in the active set. */
const LEVEL_ICON_KEYS: Record<NotifyLevel, IconKey> = {
  debug: "debug",
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
};

/** Resolve the toast/chip icon for a level under the given set. */
export function levelIcon(set: IconSet, level: NotifyLevel): string {
  return resolveIcon(set, LEVEL_ICON_KEYS[level]);
}

/** ANSI color for a notification level. */
export function levelColor(level: NotifyLevel | undefined): string {
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
function chipIcon(status: NotifyStatusEvent, set: IconSet): string {
  if (status.icon) return status.icon;
  // For chips, fall back to a level-derived icon. "error" state without
  // explicit icon gets a warning glyph regardless of the optional `level`
  // field so the user always sees something is wrong.
  if (status.state === "error") return levelIcon(set, "warning");
  return levelIcon(set, status.level ?? "info");
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
function formatChipProgress(progress: NotifyStatusEvent["progress"]): string {
  if (!progress) return "";
  const { current, total, unit } = progress;
  if (typeof total === "number" && total > 0) {
    const num = `${current}/${total}`;
    return unit ? ` ${num}${unit}` : ` ${num}`;
  }
  return unit ? ` ${current}${unit}` : ` ${current}`;
}

/** Render a single chip as `<icon> <colored label><progress>`. */
export function formatChip(status: NotifyStatusEvent, set: IconSet): string {
  const icon = chipIcon(status, set);
  const color = chipColor(status);
  // Strip newlines / tabs from `label` before truncating so a
  // multi-line payload from any emitter can never split a chip
  // across rows.
  const label = truncateToWidth(oneLine(status.label), CHIP_LABEL_MAX_WIDTH, "…");
  const progressSuffix = formatChipProgress(status.progress);
  return `${icon} ${color}${label}${C_RESET}${progressSuffix}`;
}

// ─────────────────────────────────────────────────────────────────────
// Block registry
// ─────────────────────────────────────────────────────────────────────

/** Stable list of all known block ids. Add to this when adding a
 *  new renderer and the migration path picks it up automatically. */
export const KNOWN_BLOCK_IDS = [
  "model",
  "path",
  "git",
  "context",
  "cost",
  "tokens",
  "chips",
  "stash",
] as const;

export type BlockId = (typeof KNOWN_BLOCK_IDS)[number];

/** Runtime set used by config normalisation. */
export const KNOWN_BLOCK_ID_SET: ReadonlySet<BlockId> = new Set(KNOWN_BLOCK_IDS);

/** Shared bundle every block renderer reads from. */
export interface RenderInputs {
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
  chips: NotifyStatusEvent[];
  iconSet: IconSet;
  layout: LayoutConfig;
}

export type BlockRenderer = (inputs: RenderInputs) => string;

// ─────────────────────────────────────────────────────────────────────
// Per-block renderers
// ─────────────────────────────────────────────────────────────────────

/**
 * `model` block — icon + display name, with an optional inline
 * thinking-level segment attached when (a) the active model is
 * reasoning-capable and (b) `layout.model.showThinking === true`.
 * Thinking lives inside this block on purpose: it's logically tied to
 * the model and never gets its own `│` separator.
 */
const renderModel: BlockRenderer = (inputs) => {
  const head = `${C_PINK}${resolveIcon(inputs.iconSet, "model")} ${inputs.modelName}${C_RESET}`;
  if (!inputs.modelReasoning || !inputs.layout.model.showThinking) return head;
  const label = resolveThinkingLabel(inputs.thinkingLevel, inputs.thinkingLevelMap);
  const color = THINK_COLORS[inputs.thinkingLevel] ?? C_GRAY;
  return `${head} ${color}${resolveIcon(inputs.iconSet, "thinking")} ${label}${C_RESET}`;
};

/** `path` block — `…/parent/dir` with the current directory accented. */
const renderPath: BlockRenderer = (inputs) => {
  const shortDir = shortenPath(inputs.cwd);
  const dirParent = dirname(shortDir);
  const dirName = basename(shortDir) || shortDir;
  return `${C_GRAY}${dirParent}${C_RESET}${C_PURPLE}/${dirName}${C_RESET}`;
};

/** `git` block — branch + clean/dirty mark; empty outside a repo. */
const renderGit: BlockRenderer = (inputs) => {
  if (!inputs.branch) return "";
  const mark = inputs.dirty ? `${C_RED}✗${C_RESET}` : `${C_GREEN}✓${C_RESET}`;
  return `${C_CYAN}${inputs.branch} ${mark}`;
};

/** `context` block — `pct%: used[bar]remaining`; empty when no context window. */
const renderContext: BlockRenderer = (inputs) => {
  if (inputs.contextWindow <= 0) return "";
  const threshold = Math.max(1, inputs.contextWindow - AUTOCOMPACT_BUFFER);
  let pct = Math.floor((inputs.current * 100) / threshold);
  let remaining = threshold - inputs.current;
  if (remaining < 0) {
    remaining = 0;
    pct = 100;
  }
  if (pct < 0) pct = 0;
  const color = pctColorFor(pct);
  const bar = buildBar(pct, color);
  return (
    `${color}${pct}%${C_RESET}: ${formatTokens(inputs.current)}` +
    `${C_GRAY}[${C_RESET}${bar}${C_GRAY}]${C_RESET}${formatTokens(remaining)}`
  );
};

/** `cost` block — session total in USD; empty when zero. */
const renderCost: BlockRenderer = (inputs) => {
  if (inputs.cost <= 0) return "";
  return `${C_GRAY}\$${formatCost(inputs.cost)}${C_RESET}`;
};

/**
 * `tokens` block — `↑in ↓out R W`. Each counter is gated by both the
 * sub-toggle in `layout.tokens.*` AND a `> 0` check, so disabling a
 * counter hides it even when usage exists. Returns "" when every
 * gated counter is empty.
 */
const renderTokens: BlockRenderer = (inputs) => {
  const t = inputs.layout.tokens;
  const segments: string[] = [];
  if (t.input && inputs.totalInput > 0) segments.push(`↑${formatTokens(inputs.totalInput)}`);
  if (t.output && inputs.totalOutput > 0) segments.push(`↓${formatTokens(inputs.totalOutput)}`);
  if (t.cacheRead && inputs.totalCacheRead > 0) segments.push(`R${formatTokens(inputs.totalCacheRead)}`);
  if (t.cacheWrite && inputs.totalCacheWrite > 0) segments.push(`W${formatTokens(inputs.totalCacheWrite)}`);
  if (segments.length === 0) return "";
  return `${C_GRAY}${segments.join(" ")}${C_RESET}`;
};

/**
 * `chips` block — notify-status lane. Renders the active chips joined
 * by ` · `. Returns "" when no chips are active.
 */
const renderChips: BlockRenderer = (inputs) => {
  if (inputs.chips.length === 0) return "";
  return inputs.chips.map((c) => formatChip(c, inputs.iconSet)).join(` ${C_GRAY}·${C_RESET} `);
};

/** `stash` block — `📦 N`; empty when nothing stashed. */
const renderStash: BlockRenderer = (inputs) => {
  if (inputs.stashCount <= 0) return "";
  return `${C_YELLOW}${resolveIcon(inputs.iconSet, "stash")} ${inputs.stashCount}${C_RESET}`;
};

/** Registry consulted by `composeStatusLine`. */
export const BLOCK_RENDERERS: Record<BlockId, BlockRenderer> = {
  model: renderModel,
  path: renderPath,
  git: renderGit,
  context: renderContext,
  cost: renderCost,
  tokens: renderTokens,
  chips: renderChips,
  stash: renderStash,
};

// ─────────────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk `layout.order`, render each enabled block, drop empty results,
 * and join with the configured separator glyph wrapped in spaces. The
 * leading `─ ` divider is always first; a trailing space caps the row
 * so subsequent truncation logic in `renderStatusContent` matches the
 * historical output's tail.
 */
export function composeStatusLine(layout: LayoutConfig, inputs: RenderInputs): string {
  const parts: string[] = [];
  for (const id of layout.order) {
    if (!layout.enabled[id]) continue;
    const renderer = BLOCK_RENDERERS[id];
    if (!renderer) continue;
    const piece = renderer(inputs);
    if (piece.length === 0) continue;
    parts.push(piece);
  }
  const sep = ` ${C_GRAY}${layout.separator}${C_RESET} `;
  return `${C_GRAY}─${C_RESET} ${parts.join(sep)} `;
}
