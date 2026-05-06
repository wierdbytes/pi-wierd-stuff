/**
 * pi-wierd-statusline — persistent config for the events tracker.
 *
 * Stored at `~/.pi/agent/wierd-statusline/events.json` so it lives
 * alongside the existing stash-history file.
 *
 * Schema is small on purpose — the only knobs the user can tune today
 * are per-level toast lifetimes and the stale-chip safety-net window.
 */

import type { NotifyLevel } from "pi-wierd-events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Toast lifetime in ms keyed by level. `0` means sticky-until-dismissed. */
export type ToastTimeoutMap = Record<NotifyLevel, number>;

/** Persisted schema. Bumped via `version` on incompatible changes. */
export interface EventsConfig {
  version: 1;
  /** Per-level toast lifetime in ms. `0` means sticky. */
  toastTimeouts: ToastTimeoutMap;
}

/** Built-in defaults — used when the config file is missing or invalid. */
export const DEFAULT_EVENTS_CONFIG: EventsConfig = Object.freeze({
  version: 1,
  toastTimeouts: Object.freeze({
  debug: 1000,
  info: 3000,
  success: 2000,
  warning: 5000,
  error: 0, // sticky until dismissed
  }) as ToastTimeoutMap,
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
 */
export function loadEventsConfig(): EventsConfig {
  const path = getEventsConfigPath();
  if (!existsSync(path)) return cloneDefaults();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<EventsConfig>;
    return mergeWithDefaults(raw);
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

/** Internal: deep-clone the frozen defaults so callers can mutate. */
function cloneDefaults(): EventsConfig {
  return {
    version: 1,
    toastTimeouts: { ...DEFAULT_EVENTS_CONFIG.toastTimeouts },
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

  return merged;
}
