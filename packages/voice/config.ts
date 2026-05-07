/**
 * Persistent config for @wierdbytes/pi-voice.
 *
 * Stored at `<piAgentDir>/wierd-voice/config.json` (see paths.ts).
 * Pattern mirrors `packages/web/config.ts`: the file is created on first
 * run with environment-seeded defaults; subsequent loads sanitise unknown
 * fields back to the defaults.
 *
 * No env-driven defaults are exposed today (the API-key chain in auth.ts
 * is the only env input).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath as defaultConfigPath, ensureVoiceDir } from "./paths.ts";

export const DEFAULT_VOICE = "Umbriel";
export type Scope = "last" | "sinceUser";
export const DEFAULT_SCOPE: Scope = "last";

/**
 * Allowed values for `summarizerThinkingLevel`. Mirrors
 * `ModelThinkingLevel` from `@earendil-works/pi-ai` — we re-list them here
 * (instead of importing) so this file stays a pure config module with no
 * runtime dependency on pi-ai. The picker validates against pi-ai's
 * `thinkingLevelMap` per-model; this list is just the disk-format
 * whitelist.
 */
export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type SummarizerThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

export interface WierdVoiceConfig {
  /** When true, every `agent_end` is a no-op until cleared. */
  muted: boolean;
  /** One of the prebuilt voice names (see voices.ts). */
  voice: string;
  /** Summarizer input scope — last assistant message or since last user. */
  scope: Scope;
  /** "<provider>/<id>" id passed to `pi --model`. Unset ⇒ session model. */
  summarizerModel?: string;
  /**
   * Reasoning effort passed via `pi --thinking <level>` when spawning the
   * summarizer sub-agent. Unset ⇒ inherit pi's default for the chosen
   * model. Mirrors `fetchThinkingLevel` in packages/web/config.ts.
   */
  summarizerThinkingLevel?: SummarizerThinkingLevel;
}

function isThinkingLevel(value: unknown): value is SummarizerThinkingLevel {
  return (
    typeof value === "string" &&
    (VALID_THINKING_LEVELS as readonly string[]).includes(value)
  );
}

export function envDefaults(): WierdVoiceConfig {
  return {
    muted: false,
    voice: DEFAULT_VOICE,
    scope: DEFAULT_SCOPE,
  };
}

function isScope(value: unknown): value is Scope {
  return value === "last" || value === "sinceUser";
}

function sanitize(raw: unknown): WierdVoiceConfig {
  const defaults = envDefaults();
  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;
  const cfg: WierdVoiceConfig = { ...defaults };

  if (typeof obj.muted === "boolean") cfg.muted = obj.muted;

  if (typeof obj.voice === "string" && obj.voice.trim()) {
    cfg.voice = obj.voice.trim();
  }

  if (isScope(obj.scope)) cfg.scope = obj.scope;

  if (typeof obj.summarizerModel === "string" && obj.summarizerModel.trim()) {
    cfg.summarizerModel = obj.summarizerModel.trim();
  }

  // Anything not in the whitelist (including `""` and unknown levels)
  // falls through to "unset" ⇒ inherit pi's default.
  if (isThinkingLevel(obj.summarizerThinkingLevel)) {
    cfg.summarizerThinkingLevel = obj.summarizerThinkingLevel;
  }

  return cfg;
}

/**
 * Get the path to the persisted config JSON. Wrapper around `paths.ts` so
 * tests and `/wierd-voice status` can show a single canonical location.
 */
export function getConfigPath(): string {
  return defaultConfigPath();
}

/**
 * Load the config from disk. If the file is missing or unreadable, returns
 * environment-seeded defaults without writing.
 */
export function loadConfig(path: string = defaultConfigPath()): WierdVoiceConfig {
  try {
    if (!existsSync(path)) return envDefaults();
    const raw = readFileSync(path, "utf-8");
    return sanitize(JSON.parse(raw));
  } catch {
    return envDefaults();
  }
}

/**
 * Persist config to disk. Creates the parent directory if missing. Strips
 * undefined fields so the file stays clean. Returns the path written to.
 */
export function saveConfig(
  cfg: WierdVoiceConfig,
  path: string = defaultConfigPath(),
): string {
  // Default path lives under voiceDir(); ensure it exists. Tests that
  // pass a custom path get the same parent-create behaviour via mkdirSync.
  if (path === defaultConfigPath()) {
    ensureVoiceDir();
  } else {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const out: Record<string, unknown> = {
    muted: cfg.muted,
    voice: cfg.voice,
    scope: cfg.scope,
  };
  if (cfg.summarizerModel) out.summarizerModel = cfg.summarizerModel;
  if (cfg.summarizerThinkingLevel) {
    out.summarizerThinkingLevel = cfg.summarizerThinkingLevel;
  }

  writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf-8");
  return path;
}

/**
 * Load config, ensuring the file exists. If missing, seeds from env and
 * writes it. Returns the loaded (possibly newly written) config.
 */
export function loadOrInitConfig(
  path: string = defaultConfigPath(),
): WierdVoiceConfig {
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
