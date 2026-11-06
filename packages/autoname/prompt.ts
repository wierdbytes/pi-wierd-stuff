/**
 * Prompt text and output clean-up for the naming model. Pure.
 */

import type { NamingInput } from "./conversation.ts";

export const KEEP = "KEEP";

export function systemPrompt(maxLength: number, current?: string): string {
  const lines = [
    "You name coding-agent sessions. The name is shown in a terminal tab and a session list.",
    "Output only the name, nothing else:",
    `- 2 to 6 words, at most ${maxLength} characters;`,
    "- the same language as the user's requests;",
    "- sentence case, no quotes, no markdown, no emoji, no trailing punctuation;",
    "- name the concrete subject (feature, bug, module, file, tool), not generic words like \"Help\", \"Question\" or \"Task\".",
  ];
  if (current) {
    lines.push(
      "",
      `The current name is: ${current}`,
      `If it still describes what the conversation is about now, output exactly ${KEEP}.`,
      "Otherwise output a new name.",
    );
  }
  return lines.join("\n");
}

export function userPrompt(input: NamingInput): string {
  const parts = [`<first_request>\n${input.first}\n</first_request>`];
  if (input.recent.length > 0) {
    parts.push(
      `<recent_requests>\n${input.recent.map((r) => `- ${r}`).join("\n")}\n</recent_requests>`,
    );
  }
  if (input.assistant) parts.push(`<assistant_reply>\n${input.assistant}\n</assistant_reply>`);
  return parts.join("\n\n");
}

// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x09\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Cut to `max` characters, preferring a word boundary, ending with `…` when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const atBoundary = /\s/.test(text[max - 1] ?? "");
  const space = head.lastIndexOf(" ");
  const cut = atBoundary || space < max * 0.5 ? head : head.slice(0, space);
  return `${cut.replace(/[\s,.;:–—-]+$/u, "")}…`;
}

/**
 * Turn raw model output into a name, or `undefined` when nothing usable is
 * left. `KEEP` is returned as-is so callers can tell it apart.
 */
export function normalizeName(raw: string, maxLength: number): string | undefined {
  const line = raw
    .replace(CONTROL, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  if (/^KEEP[.!]?$/i.test(line)) return KEEP;
  let name = line
    .replace(/^(?:#+\s*|[-*•]\s+)/, "")
    .replace(/^(?:session\s+)?(?:title|name)\s*[:：]\s*/i, "")
    .replace(/^["'`«“„*_]+|["'`»”*_]+$/gu, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,。！？]+$/u, "")
    .trim();
  if (!name) return undefined;
  name = truncate(name, maxLength);
  return name || undefined;
}

/** Name from the first prompt line: used when the model call fails. */
export function fallbackName(firstRequest: string, maxLength: number): string | undefined {
  const line = firstRequest
    .split(/\r?\n/)
    .map((l) => l.replace(/^\/\S+\s*/, "").replace(/[`*_#>]/g, "").trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return normalizeName(line, maxLength);
}

/** Fill the terminal title template. `{name}` is required, `{cwd}` is the folder name. */
export function renderTitle(template: string, vars: { name: string; cwd: string }): string {
  return template
    .replace(/\{name\}/g, vars.name)
    .replace(/\{cwd\}/g, vars.cwd)
    .trim();
}

/** What pi itself puts in the title (`π - <name> - <cwd>`), to restore it. */
export function piDefaultTitle(name: string | undefined, cwd: string): string {
  return name ? `π - ${name} - ${cwd}` : `π - ${cwd}`;
}
