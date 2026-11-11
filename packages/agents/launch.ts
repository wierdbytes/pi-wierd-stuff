/**
 * How a sub-agent's terminal starts: its hc name, pi's argv and the
 * environment. Pure functions, so the details stay testable.
 */

import type { AgentsSettings } from "./settings.ts";

/** Env keys the child reads. */
export const ENV = {
  RUN: "PI_AGENTS_RUN",
  DIR: "PI_AGENTS_DIR",
  DEPTH: "PI_AGENTS_DEPTH",
  TRUST: "PI_AGENTS_TRUST",
} as const;

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * hc names are 1-32 of `a-z 0-9 - _`. Cyrillic is transliterated so a
 * Russian description still gives a readable name; `max` leaves room for a
 * `-2` suffix on collisions.
 */
export function slugName(description: string, max = 28): string {
  const s = description
    .toLowerCase()
    .split("")
    .map((ch) => CYRILLIC[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = s.slice(0, max).replace(/-+$/, "");
  return cut || "agent";
}

/** `name`, `name-2`, `name-3`, … within 32 characters. */
export function nameCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base.slice(0, 32);
  const suffix = `-${attempt}`;
  return `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

export interface ChildArgs {
  model?: string;
  thinking?: string;
  tools?: string[];
  excludeTools?: string[];
  sessionName: string;
  prompt: string;
}

/**
 * Options first, then `--` and the task: pi's extension flags may take a
 * value, so a stray flag before the task could swallow it.
 */
export function buildArgv(settings: Pick<AgentsSettings, "command" | "extraArgs">, a: ChildArgs): string[] {
  const argv = [...settings.command];
  if (a.model) argv.push("--model", a.model);
  if (a.thinking) argv.push("--thinking", a.thinking);
  if (a.tools?.length) argv.push("--tools", a.tools.join(","));
  if (a.excludeTools?.length) argv.push("--exclude-tools", a.excludeTools.join(","));
  argv.push("--name", a.sessionName);
  argv.push(...settings.extraArgs);
  // A task starting with "@" would be read as a file to attach.
  const prompt = a.prompt.startsWith("@") ? `Task:\n${a.prompt}` : a.prompt;
  argv.push("--", prompt);
  return argv;
}

/** Keys that describe the parent's own terminal or session, never the child's. */
const DROP_EXACT = new Set([
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "SHLVL",
  "PWD",
  "OLDPWD",
  "_",
  "WINDOWID",
  "TTY",
  "AI_AGENT",
  "PI_CODING_AGENT",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "STARSHIP_SESSION_KEY",
  "LaunchInstanceID",
]);
const DROP_PREFIX = ["HC_", "HERDR_", "PI_AGENTS_", "GHOSTTY_", "KITTY_", "ITERM_", "TMUX", "VSCODE_", "LC_TERMINAL", "WEZTERM_", "ZELLIJ"];

/** The parent's environment minus terminal identity, for a child that should run like its parent. */
export function inheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (DROP_EXACT.has(k)) continue;
    if (DROP_PREFIX.some((p) => k.startsWith(p))) continue;
    // Shell functions exported by bash, and zsh/fzf leftovers that aren't real names.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}
