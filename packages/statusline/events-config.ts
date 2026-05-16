/**
 * @wierdbytes/pi-statusline — persistent config for the events tracker.
 *
 * Stored at `~/.pi/agent/wierd-statusline/events.json` so it lives
 * alongside the existing stash-history file.
 *
 * Schema is small on purpose — the only knobs the user can tune today
 * are per-level toast lifetimes and the stale-chip safety-net window.
 */

import type { NotifyLevel } from "@wierdbytes/pi-events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_ICON_SET, type IconSet, isIconSet } from "./icons.ts";
import {
  cloneDefaultLayout,
  DEFAULT_LAYOUT_CONFIG,
  type LayoutConfig,
  normaliseLayoutConfig,
} from "./layout-config.ts";

/** Toast lifetime in ms keyed by level. `0` means sticky-until-dismissed. */
export type ToastTimeoutMap = Record<NotifyLevel, number>;

/**
 * Display-level toggles for the statusline. These were session-local
 * before but live in the persisted config now so the user's
 * preferences survive a pi restart.
 *
 * Defaults match the original session-local defaults so an upgrade
 * from a config that doesn't have the `display` slice is invisible.
 */
export interface DisplayConfig {
  /** Master switch for the wierd statusline widget itself. */
  statuslineEnabled: boolean;
  /** True ⇒ hide pi's built-in footer (we render our own). */
  footerHidden: boolean;
  /** Pin the editor to the bottom of the terminal via the split compositor. */
  fixedEditorEnabled: boolean;
  /** Allow the fixed-editor compositor to handle mouse-scroll events. */
  mouseScrollEnabled: boolean;
  /** Active icon set for model / thinking / stash / toast-level / chip
   *  glyphs. See `./icons.ts` for the full glyph tables. Default:
   *  `"nerd-font"` — terminal-friendly Nerd Font glyphs (the original
   *  emoji set is still available as `"emoji"`). */
  iconSet: IconSet;
}

/**
 * Settings for the subagents bridge (see `subagents-tracker.ts`).
 *
 * The tracker only renders + emits when `enabled === true`. The
 * `longCompletionMs` threshold suppresses success toasts for fast
 * agents (where the chip already gave the user enough feedback).
 */
export interface SubagentsConfig {
  /** Master switch. When false the tracker stays subscribed but
   *  silently drops every event. Default: true. */
  enabled: boolean;
  /** Minimum duration in ms before a successful completion produces
   *  a toast. Failures always toast (when `toastOnFailure` is on)
   *  regardless of duration. Default: 30_000. */
  longCompletionMs: number;
  /** Toast on terminal-error states (failed / stopped / aborted).
   *  Default: true. */
  toastOnFailure: boolean;
  /** Toast on non-error completions whose `durationMs` ≥
   *  `longCompletionMs`. Default: true. */
  toastOnLongCompletion: boolean;
  /** Toast when a subagent is scheduled (cron / interval / one-shot).
   *  Useful as an audit trail; off by default to avoid noise. */
  toastOnScheduled: boolean;
}

/**
 * Persisted schema. Bumped via `version` on incompatible changes.
 *
 * Migration history:
 *   - v1 → v2: added the `layout` slice. Existing v1 files are
 *     transparently migrated on first load (a fresh `layout` slice
 *     using `DEFAULT_LAYOUT_CONFIG` is injected and the file is
 *     rewritten with `version: 2`).
 */
export interface EventsConfig {
  version: 2;
  /** Per-level toast lifetime in ms. `0` means sticky. */
  toastTimeouts: ToastTimeoutMap;
  /** Subagents bridge settings — see `SubagentsConfig`. */
  subagents: SubagentsConfig;
  /** Display-level toggles — see `DisplayConfig`. */
  display: DisplayConfig;
  /** Block layout (order, visibility, sub-toggles, separator).
   *  Added in v2. */
  layout: LayoutConfig;
}

/** Current schema version written to disk. */
export const EVENTS_CONFIG_VERSION = 2 as const;

/** Built-in defaults — used when the config file is missing or invalid. */
export const DEFAULT_EVENTS_CONFIG: EventsConfig = Object.freeze({
  version: EVENTS_CONFIG_VERSION,
  toastTimeouts: Object.freeze({
  debug: 1000,
  info: 3000,
  success: 2000,
  warning: 5000,
  error: 0, // sticky until dismissed
  }) as ToastTimeoutMap,
  subagents: Object.freeze({
    enabled: true,
    longCompletionMs: 30_000,
    toastOnFailure: true,
    toastOnLongCompletion: true,
    toastOnScheduled: false,
  }) as SubagentsConfig,
  display: Object.freeze({
    statuslineEnabled: true,
    footerHidden: true,
    fixedEditorEnabled: false,
    mouseScrollEnabled: true,
    iconSet: DEFAULT_ICON_SET,
  }) as DisplayConfig,
  layout: DEFAULT_LAYOUT_CONFIG,
}) as EventsConfig;

/** Resolve `~/.pi/agent/wierd-statusline/events.json`. */
export function getEventsConfigPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "wierd-statusline", "events.json");
}

/**
 * Load the persisted config, falling back to `DEFAULT_EVENTS_CONFIG`
 * for missing or malformed data. Always returns a fully populated
 * config object so the tracker doesn't have to deal with `undefined`
 * fields.
 *
 * When the on-disk file is older than `EVENTS_CONFIG_VERSION` (or has
 * no `version` field), we transparently rewrite it with the upgraded
 * payload so subsequent loads skip the migration branch.
 */
export function loadEventsConfig(): EventsConfig {
  const path = getEventsConfigPath();
  if (!existsSync(path)) return cloneDefaults();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<EventsConfig> & {
      version?: number;
    };
    const merged = mergeWithDefaults(raw);
    // If the file was older than the current schema (or unversioned),
    // rewrite it now so future loads short-circuit the migration. This
    // is best-effort — a read-only filesystem just means we'll migrate
    // again on the next launch, which is harmless.
    if (typeof raw.version !== "number" || raw.version < EVENTS_CONFIG_VERSION) {
      saveEventsConfig(merged);
    }
    return merged;
  } catch {
    return cloneDefaults();
  }
}

/**
 * Persist `config` to disk. Best-effort — write failures are swallowed
 * so a read-only filesystem doesn't break the statusline.
 */
export function saveEventsConfig(config: EventsConfig): void {
  const path = getEventsConfigPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch {
    // Persistence is best-effort.
  }
}

/** Set one level's toast timeout and persist. Returns the new config. */
export function setToastTimeout(
  config: EventsConfig,
  level: NotifyLevel,
  ms: number,
): EventsConfig {
  const next: EventsConfig = {
    ...config,
    toastTimeouts: { ...config.toastTimeouts, [level]: Math.max(0, Math.floor(ms)) },
  };
  saveEventsConfig(next);
  return next;
}

/**
 * Patch the `subagents` slice and persist. Pass any subset of
 * `SubagentsConfig` keys; missing keys keep their current value.
 * Numeric values are clamped to non-negative integers.
 */
export function setSubagentsConfig(
  config: EventsConfig,
  patch: Partial<SubagentsConfig>,
): EventsConfig {
  const next: EventsConfig = {
    ...config,
    subagents: {
      ...config.subagents,
      ...patch,
      ...(typeof patch.longCompletionMs === "number"
        ? { longCompletionMs: Math.max(0, Math.floor(patch.longCompletionMs)) }
        : {}),
    },
  };
  saveEventsConfig(next);
  return next;
}

/**
 * Patch the `display` slice and persist. Pass any subset of
 * `DisplayConfig` keys; missing keys keep their current value.
 */
export function setDisplayConfig(
  config: EventsConfig,
  patch: Partial<DisplayConfig>,
): EventsConfig {
  const next: EventsConfig = {
    ...config,
    display: { ...config.display, ...patch },
  };
  saveEventsConfig(next);
  return next;
}

/**
 * Patch the `layout` slice and persist. Sub-objects (`model`,
 * `tokens`) merge field-by-field so callers can pass partial slices
 * (e.g. `{ tokens: { input: false } }` keeps the other counters).
 * The result is run through `normaliseLayoutConfig` so an invalid
 * `order` / `separator` falls back to defaults the same way as a
 * hand-edited file.
 */
export function setLayoutConfig(
  config: EventsConfig,
  patch: Partial<LayoutConfig>,
): EventsConfig {
  const mergedRaw: LayoutConfig = {
    order: patch.order ? [...patch.order] : [...config.layout.order],
    enabled: { ...config.layout.enabled, ...(patch.enabled ?? {}) },
    model: { ...config.layout.model, ...(patch.model ?? {}) },
    tokens: { ...config.layout.tokens, ...(patch.tokens ?? {}) },
    separator: patch.separator ?? config.layout.separator,
  };
  const next: EventsConfig = {
    ...config,
    layout: normaliseLayoutConfig(mergedRaw),
  };
  saveEventsConfig(next);
  return next;
}

/** Internal: deep-clone the frozen defaults so callers can mutate. */
function cloneDefaults(): EventsConfig {
  return {
    version: EVENTS_CONFIG_VERSION,
    toastTimeouts: { ...DEFAULT_EVENTS_CONFIG.toastTimeouts },
    subagents: { ...DEFAULT_EVENTS_CONFIG.subagents },
    display: { ...DEFAULT_EVENTS_CONFIG.display },
    layout: cloneDefaultLayout(),
  };
}

/**
 * Merge a parsed (potentially partial / malformed) JSON object with
 * `DEFAULT_EVENTS_CONFIG`. Drops unknown fields and clamps invalid
 * numeric values back to their defaults so a hand-edited config can't
 * crash the tracker.
 */
function mergeWithDefaults(raw: Partial<EventsConfig>): EventsConfig {
  const merged = cloneDefaults();
  if (!raw || typeof raw !== "object") return merged;

  if (raw.toastTimeouts && typeof raw.toastTimeouts === "object") {
    for (const level of Object.keys(merged.toastTimeouts) as NotifyLevel[]) {
      const value = (raw.toastTimeouts as Record<string, unknown>)[level];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        merged.toastTimeouts[level] = Math.floor(value);
      }
    }
  }

  if (raw.subagents && typeof raw.subagents === "object") {
    // `Partial<EventsConfig>['subagents']` resolves to `SubagentsConfig`,
    // which has no index signature — route through `unknown` so the
    // hand-edited JSON case (extra / missing keys) stays valid.
    const sub = raw.subagents as unknown as Record<string, unknown>;
    if (typeof sub.enabled === "boolean") merged.subagents.enabled = sub.enabled;
    if (
      typeof sub.longCompletionMs === "number" &&
      Number.isFinite(sub.longCompletionMs) &&
      sub.longCompletionMs >= 0
    ) {
      merged.subagents.longCompletionMs = Math.floor(sub.longCompletionMs);
    }
    if (typeof sub.toastOnFailure === "boolean") merged.subagents.toastOnFailure = sub.toastOnFailure;
    if (typeof sub.toastOnLongCompletion === "boolean") {
      merged.subagents.toastOnLongCompletion = sub.toastOnLongCompletion;
    }
    if (typeof sub.toastOnScheduled === "boolean") {
      merged.subagents.toastOnScheduled = sub.toastOnScheduled;
    }
  }

  if (raw.display && typeof raw.display === "object") {
    const disp = raw.display as unknown as Record<string, unknown>;
    if (typeof disp.statuslineEnabled === "boolean") merged.display.statuslineEnabled = disp.statuslineEnabled;
    if (typeof disp.footerHidden === "boolean") merged.display.footerHidden = disp.footerHidden;
    if (typeof disp.fixedEditorEnabled === "boolean") merged.display.fixedEditorEnabled = disp.fixedEditorEnabled;
    if (typeof disp.mouseScrollEnabled === "boolean") merged.display.mouseScrollEnabled = disp.mouseScrollEnabled;
    if (isIconSet(disp.iconSet)) merged.display.iconSet = disp.iconSet;
  }

  // `layout` was added in v2 — absent in v1 files. `normaliseLayoutConfig`
  // gracefully handles `undefined` by returning the defaults, which is
  // exactly the v1→v2 migration we want.
  merged.layout = normaliseLayoutConfig(
    raw.layout && typeof raw.layout === "object" ? (raw.layout as Partial<LayoutConfig>) : undefined,
  );

  return merged;
}
