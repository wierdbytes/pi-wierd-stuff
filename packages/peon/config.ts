/**
 * Persistent config for @wierdbytes/pi-peon.
 *
 * Lives at `<piAgentDir>/peon/config.json`. Mirrors voice / web's
 * "seeded defaults on first run, sanitise unknown fields" pattern.
 *
 * Persisted shape:
 *   {
 *     activePack: string,            // pack id (e.g. "peon"). May
 *                                    // be unset (uninstalled / pending).
 *     muted: boolean,                // global kill switch.
 *     volume: number,                // 0..1 master volume.
 *     enabledCategories: {[cat]: bool},  // per-event enable; default true.
 *   }
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configPath, ensureStateDir } from "./paths.ts";
import { CESP_CATEGORIES, type CespCategory } from "./pack.ts";

export const DEFAULT_ACTIVE_PACK = "peon";
export const DEFAULT_VOLUME = 0.5;

export interface PeonConfig {
  activePack: string;
  muted: boolean;
  volume: number;
  /** Map of category-id → enabled. Missing keys default to `true`. */
  enabledCategories: Partial<Record<CespCategory, boolean>>;
}

export function envDefaults(): PeonConfig {
  return {
    activePack: DEFAULT_ACTIVE_PACK,
    muted: false,
    volume: DEFAULT_VOLUME,
    enabledCategories: defaultEnabledMap(),
  };
}

export function defaultEnabledMap(): Record<CespCategory, boolean> {
  const map = {} as Record<CespCategory, boolean>;
  for (const cat of CESP_CATEGORIES) map[cat] = true;
  return map;
}

function sanitize(raw: unknown): PeonConfig {
  const defaults = envDefaults();
  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;
  const cfg: PeonConfig = { ...defaults };

  if (typeof obj.activePack === "string" && obj.activePack.trim()) {
    cfg.activePack = obj.activePack.trim();
  }
  if (typeof obj.muted === "boolean") cfg.muted = obj.muted;
  if (typeof obj.volume === "number" && Number.isFinite(obj.volume)) {
    cfg.volume = clampVolume(obj.volume);
  }
  if (obj.enabledCategories && typeof obj.enabledCategories === "object") {
    const ec = obj.enabledCategories as Record<string, unknown>;
    const out: Partial<Record<CespCategory, boolean>> = {};
    for (const cat of CESP_CATEGORIES) {
      const v = ec[cat];
      out[cat] = typeof v === "boolean" ? v : true;
    }
    cfg.enabledCategories = out;
  }
  return cfg;
}

/** Clamp to the spec's [0, 1] master-volume range. */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VOLUME;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function getConfigPath(): string {
  return configPath();
}

export function loadConfig(): PeonConfig {
  const path = configPath();
  try {
    if (!existsSync(path)) return envDefaults();
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return envDefaults();
  }
}

export function saveConfig(cfg: PeonConfig): string {
  ensureStateDir();
  const path = configPath();
  const out: Record<string, unknown> = {
    activePack: cfg.activePack,
    muted: cfg.muted,
    volume: clampVolume(cfg.volume),
    enabledCategories: { ...cfg.enabledCategories },
  };
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf-8");
  return path;
}

export function loadOrInitConfig(): PeonConfig {
  const path = configPath();
  if (!existsSync(path)) {
    const seeded = envDefaults();
    try {
      saveConfig(seeded);
    } catch {
      // Non-fatal; fall through with in-memory defaults.
    }
    return seeded;
  }
  return loadConfig();
}

/** Per-category enable check with a default-true fallback. */
export function isCategoryEnabled(
  cfg: PeonConfig,
  cat: CespCategory,
): boolean {
  const v = cfg.enabledCategories[cat];
  return v !== false;
}
