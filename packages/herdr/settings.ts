/**
 * `~/.pi/agent/@wierdbytes/pi-herdr/settings.json`. Every key is optional;
 * a missing or broken file means the defaults.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface HerdrSettings {
  /** Run bash commands (the model's and `!`) in herdr-core terminals under pi's. */
  bash: boolean;
}

export const DEFAULT_SETTINGS: HerdrSettings = { bash: true };

export const settingsPath = (): string => join(getAgentDir(), "@wierdbytes", "pi-herdr", "settings.json");

export function parseSettings(raw: unknown): HerdrSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { bash: typeof o.bash === "boolean" ? o.bash : DEFAULT_SETTINGS.bash };
}

export function loadSettings(path = settingsPath()): HerdrSettings {
  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
