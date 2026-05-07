/**
 * Persistent config for @wierdbytes/pi-web.
 *
 * Stored at ~/.pi/agent/wierd-web.json. Holds settings for both web_search
 * and web_fetch tools so the user has a single config surface.
 *
 * On first load (file missing), the config is seeded from environment
 * variables (PI_WIERD_WEB_MODEL, PI_WIERD_WEB_FETCH_MODEL,
 * PI_WIERD_WEB_FETCH_THINKING) and written to disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SEARCH_MODEL = "claude-haiku-4-5";

export interface WierdWebConfig {
  /** Anthropic model used by the web_search tool. */
  searchModel: string;
  /**
   * Provider/model id for the web_fetch sub-agent (e.g. "anthropic/claude-haiku-4-5").
   * If undefined, web_fetch uses the current session model.
   */
  fetchModel?: string;
  /**
   * Thinking level for the web_fetch sub-agent. If undefined, web_fetch uses
   * the current session thinking level.
   */
  fetchThinkingLevel?: string;
}

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "wierd-web.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function envDefaults(): WierdWebConfig {
  const cfg: WierdWebConfig = {
    searchModel: process.env.PI_WIERD_WEB_MODEL?.trim() || DEFAULT_SEARCH_MODEL,
  };
  const fetchModel = process.env.PI_WIERD_WEB_FETCH_MODEL?.trim();
  if (fetchModel) cfg.fetchModel = fetchModel;
  const fetchThinking = process.env.PI_WIERD_WEB_FETCH_THINKING?.trim();
  if (fetchThinking) cfg.fetchThinkingLevel = fetchThinking;
  return cfg;
}

function sanitize(raw: unknown): WierdWebConfig {
  const defaults = envDefaults();
  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;
  const cfg: WierdWebConfig = { searchModel: defaults.searchModel };
  if (typeof obj.searchModel === "string" && obj.searchModel.trim()) {
    cfg.searchModel = obj.searchModel.trim();
  }
  if (typeof obj.fetchModel === "string" && obj.fetchModel.trim()) {
    cfg.fetchModel = obj.fetchModel.trim();
  } else if (defaults.fetchModel) {
    cfg.fetchModel = defaults.fetchModel;
  }
  if (typeof obj.fetchThinkingLevel === "string" && obj.fetchThinkingLevel.trim()) {
    cfg.fetchThinkingLevel = obj.fetchThinkingLevel.trim();
  } else if (defaults.fetchThinkingLevel) {
    cfg.fetchThinkingLevel = defaults.fetchThinkingLevel;
  }
  return cfg;
}

/**
 * Load the config from disk. If the file is missing or unreadable, returns
 * environment-seeded defaults without writing.
 */
export function loadConfig(path: string = CONFIG_PATH): WierdWebConfig {
  try {
    if (!existsSync(path)) return envDefaults();
    const raw = readFileSync(path, "utf-8");
    return sanitize(JSON.parse(raw));
  } catch {
    return envDefaults();
  }
}

/**
 * Persist config to disk. Creates the parent directory if needed.
 * Returns the path written to (for logging).
 */
export function saveConfig(cfg: WierdWebConfig, path: string = CONFIG_PATH): string {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Strip undefined fields so the file stays clean.
  const out: Record<string, unknown> = { searchModel: cfg.searchModel };
  if (cfg.fetchModel) out.fetchModel = cfg.fetchModel;
  if (cfg.fetchThinkingLevel) out.fetchThinkingLevel = cfg.fetchThinkingLevel;
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf-8");
  return path;
}

/**
 * Load config, ensuring the file exists. If missing, seeds from env and
 * writes it. Returns the loaded (possibly newly written) config.
 */
export function loadOrInitConfig(path: string = CONFIG_PATH): WierdWebConfig {
  if (!existsSync(path)) {
    const seeded = envDefaults();
    try {
      saveConfig(seeded, path);
    } catch {
      // Non-fatal: fall back to in-memory defaults if disk write fails.
    }
    return seeded;
  }
  return loadConfig(path);
}
