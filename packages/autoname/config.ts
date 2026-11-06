/**
 * Persistent config for @wierdbytes/pi-autoname.
 *
 * Stored at `~/.pi/agent/@wierdbytes/pi-autoname/settings.json` (or under
 * `PI_CODING_AGENT_DIR` when pi is pointed elsewhere). Missing / unknown /
 * malformed fields fall back to defaults, so a hand-edited file can never
 * break the extension.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Where the generated name goes. */
export type Target = "both" | "session" | "title";
export const TARGETS: readonly Target[] = ["both", "session", "title"];

/**
 * When the name is (re)generated:
 * - `first`  — once, after the first settled turn; never touched again.
 * - `auto`   — after every settled turn the model answers KEEP or a new name.
 * - `follow` — regenerated after every settled turn.
 */
export type Mode = "first" | "auto" | "follow";
export const MODES: readonly Mode[] = ["first", "auto", "follow"];

/** Mirrors pi-ai's `ModelThinkingLevel`; kept local so this module has no pi-ai runtime import. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_MODEL = "anthropic/claude-haiku-5-5";
export const DEFAULT_TEMPLATE = "{name}";

export interface AutonameConfig {
  enabled: boolean;
  target: Target;
  mode: Mode;
  /** `<provider>/<id>`; `""` means the session's current model. */
  model: string;
  thinking: ThinkingLevel;
  /** Max characters of a generated name. */
  maxLength: number;
  /** Terminal title template: `{name}`, `{cwd}` (folder basename). */
  titleTemplate: string;
  /** Name the session from the first prompt line when the model call fails. */
  fallback: boolean;
}

export const MIN_LENGTH = 10;
export const MAX_LENGTH = 120;

export function defaults(): AutonameConfig {
  return {
    enabled: true,
    target: "both",
    mode: "first",
    model: DEFAULT_MODEL,
    thinking: "off",
    maxLength: 50,
    titleTemplate: DEFAULT_TEMPLATE,
    fallback: true,
  };
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

export function sanitize(raw: unknown): AutonameConfig {
  const cfg = defaults();
  if (!raw || typeof raw !== "object") return cfg;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled === "boolean") cfg.enabled = o.enabled;
  if (oneOf(TARGETS, o.target)) cfg.target = o.target;
  if (oneOf(MODES, o.mode)) cfg.mode = o.mode;
  if (typeof o.model === "string") cfg.model = o.model.trim();
  if (oneOf(THINKING_LEVELS, o.thinking)) cfg.thinking = o.thinking;
  if (typeof o.maxLength === "number" && Number.isFinite(o.maxLength)) {
    cfg.maxLength = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.round(o.maxLength)));
  }
  if (typeof o.titleTemplate === "string" && o.titleTemplate.includes("{name}")) {
    cfg.titleTemplate = o.titleTemplate;
  }
  if (typeof o.fallback === "boolean") cfg.fallback = o.fallback;
  return cfg;
}

export function configPath(): string {
  return join(getAgentDir(), "@wierdbytes", "pi-autoname", "settings.json");
}

export function loadConfig(path: string = configPath()): AutonameConfig {
  try {
    if (!existsSync(path)) return defaults();
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return defaults();
  }
}

export function saveConfig(cfg: AutonameConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sanitize(cfg), null, 2) + "\n", "utf-8");
}
