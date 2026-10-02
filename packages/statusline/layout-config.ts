/**
 * @wierdbytes/pi-statusline — layout configuration (v2 schema slice).
 *
 * Owns the per-block visibility, ordering, sub-toggle slices, and
 * separator glyph. Lives alongside `display`, `subagents`, and
 * `toastTimeouts` inside `EventsConfig` (see `./events-config.ts`).
 *
 * The renderer walks `order`, calls each block's renderer when its
 * `enabled` flag is on, and joins non-empty results with `separator`.
 * Sub-toggles (`model.showThinking`, `cache.*`) gate **content
 * inside** a single block — they never change ordering, never
 * introduce a new separator.
 *
 * Normalisation rules (applied on every load, hand-edit, or migration):
 *   - Unknown block ids in `order` are dropped silently.
 *   - Known block ids missing from `order` are appended to the tail
 *     so a future release adding a new block surfaces it on next load.
 *   - Duplicate ids in `order` are de-duplicated (first wins).
 *   - `separator` is clamped to a 1–2 character non-empty string;
 *     anything else falls back to the default `│`.
 *   - `enabled[id]` defaults to `true` for any known id missing from
 *     the persisted record.
 *   - The retired `tokens` block (≤ 0.7.x) is migrated to `cache`:
 *     it takes over `tokens`' slot in `order` and its `enabled` flag.
 *     The old `tokens.*` counter sub-toggles are dropped.
 */

import { type BlockId, KNOWN_BLOCK_IDS, KNOWN_BLOCK_ID_SET } from "./blocks.ts";

/** Sub-toggles inside the `model` block. Independent of `enabled.model`. */
export interface ModelSubToggles {
  /** Show the inline thinking-level segment (only relevant for
   *  reasoning-capable models). Default: true. */
  showThinking: boolean;
}

/** Sub-toggles inside the `cache` block. Each defaults to true. */
export interface CacheSubToggles {
  /** Show the `99.9% (read/uncached)` hit-rate segment. */
  hitRate: boolean;
  /** Show the `-$0.86` / `+$0.15` savings segment. */
  savings: boolean;
  /** Show the cache-expiry countdown segment. */
  timer: boolean;
}

/** Block id retired in 0.8.0; migrated to `cache` on load. */
const LEGACY_TOKENS_ID = "tokens";

/** Persisted layout slice. */
export interface LayoutConfig {
  /** Ordered list of block ids. Drives `composeStatusLine`. */
  order: BlockId[];
  /** Per-block visibility. */
  enabled: Record<BlockId, boolean>;
  /** Model sub-toggles (thinking segment). */
  model: ModelSubToggles;
  /** Cache block sub-toggles. */
  cache: CacheSubToggles;
  /** Separator glyph rendered between visible blocks. */
  separator: string;
}

/** Default separator glyph (gray box-drawing vertical bar). */
export const DEFAULT_SEPARATOR = "│";

/** Built-in defaults — used by the migration path and `/statusline layout reset`. */
export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = Object.freeze({
  order: [...KNOWN_BLOCK_IDS],
  enabled: Object.freeze({
    model: true,
    path: true,
    git: true,
    context: true,
    cost: true,
    quotas: true,
    cache: true,
    chips: true,
    stash: true,
  }) as Record<BlockId, boolean>,
  model: Object.freeze({ showThinking: true }) as ModelSubToggles,
  cache: Object.freeze({ hitRate: true, savings: true, timer: true }) as CacheSubToggles,
  separator: DEFAULT_SEPARATOR,
}) as LayoutConfig;

/** Return a deeply-cloned mutable copy of the defaults. */
export function cloneDefaultLayout(): LayoutConfig {
  return {
    order: [...DEFAULT_LAYOUT_CONFIG.order],
    enabled: { ...DEFAULT_LAYOUT_CONFIG.enabled },
    model: { ...DEFAULT_LAYOUT_CONFIG.model },
    cache: { ...DEFAULT_LAYOUT_CONFIG.cache },
    separator: DEFAULT_LAYOUT_CONFIG.separator,
  };
}

/**
 * Normalise a (potentially partial / malformed) layout slice against
 * the defaults. Returns a fully-populated `LayoutConfig`:
 *
 *   - `order` is de-duplicated, unknown ids dropped, missing known ids
 *     appended to the tail in `KNOWN_BLOCK_IDS` order.
 *   - `enabled` keys missing for known ids default to `true`; extra
 *     keys are dropped.
 *   - `model` / `cache` sub-toggles default to `true` per key.
 *   - legacy `tokens` id is renamed to `cache` (see module docs).
 *   - `separator` is validated/clamped.
 */
export function normaliseLayoutConfig(raw: Partial<LayoutConfig> | undefined): LayoutConfig {
  const merged = cloneDefaultLayout();
  if (!raw || typeof raw !== "object") return merged;

  // ── order ───────────────────────────────────────────────────────────
  if (Array.isArray(raw.order)) {
    const seen = new Set<BlockId>();
    const sanitized: BlockId[] = [];
    for (const rawCandidate of raw.order as unknown[]) {
      if (typeof rawCandidate !== "string") continue;
      const candidate = rawCandidate === LEGACY_TOKENS_ID ? "cache" : rawCandidate;
      if (!KNOWN_BLOCK_ID_SET.has(candidate as BlockId)) continue;
      const id = candidate as BlockId;
      if (seen.has(id)) continue;
      seen.add(id);
      sanitized.push(id);
    }
    // Append any known ids missing from the persisted order so a new
    // block added in a future release surfaces automatically.
    for (const id of KNOWN_BLOCK_IDS) {
      if (!seen.has(id)) sanitized.push(id);
    }
    merged.order = sanitized;
  }

  // ── enabled ─────────────────────────────────────────────────────────
  if (raw.enabled && typeof raw.enabled === "object") {
    const src = raw.enabled as Record<string, unknown>;
    for (const id of KNOWN_BLOCK_IDS) {
      if (typeof src[id] === "boolean") merged.enabled[id] = src[id] as boolean;
    }
    if (typeof src.cache !== "boolean" && typeof src[LEGACY_TOKENS_ID] === "boolean") {
      merged.enabled.cache = src[LEGACY_TOKENS_ID] as boolean;
    }
  }

  // ── model sub-toggles ───────────────────────────────────────────────
  if (raw.model && typeof raw.model === "object") {
    const src = raw.model as unknown as Record<string, unknown>;
    if (typeof src.showThinking === "boolean") merged.model.showThinking = src.showThinking;
  }

  // ── cache sub-toggles ───────────────────────────────────────────────
  if (raw.cache && typeof raw.cache === "object") {
    const src = raw.cache as unknown as Record<string, unknown>;
    if (typeof src.hitRate === "boolean") merged.cache.hitRate = src.hitRate;
    if (typeof src.savings === "boolean") merged.cache.savings = src.savings;
    if (typeof src.timer === "boolean") merged.cache.timer = src.timer;
  }

  // ── separator ───────────────────────────────────────────────────────
  merged.separator = clampSeparator(raw.separator);

  return merged;
}

/**
 * Clamp the separator glyph to a non-empty 1–2 char string.
 * Falls back to `DEFAULT_SEPARATOR` for anything else (empty string,
 * non-string, oversized payload).
 */
export function clampSeparator(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SEPARATOR;
  // Strip newlines/tabs defensively — a separator with a newline
  // would corrupt the single-row layout.
  const cleaned = value.replace(/[\r\n\t]/g, "");
  if (cleaned.length === 0) return DEFAULT_SEPARATOR;
  // We only display ~1 char on most terminals; allow up to 2 so users
  // can pass things like `" "` (a wider visual gap) or `"::"`.
  return cleaned.length > 2 ? cleaned.slice(0, 2) : cleaned;
}

/** Built-in separator option labels for the settings modal. */
export const SEPARATOR_OPTIONS = ["│", "·", "▎", ":", " "] as const;
export type SeparatorOption = (typeof SEPARATOR_OPTIONS)[number];
export const SEPARATOR_LABELS: Record<SeparatorOption, string> = {
  "│": "│ — vertical bar (default)",
  "·": "· — middle dot",
  "▎": "▎ — heavy left bar",
  ":": ": — colon",
  " ": "(space) — no glyph",
};
