/**
 * Build the input passed to the summarizer sub-agent from the messages
 * pi hands us in `AgentEndEvent.messages`.
 *
 * Two scopes (selected by `config.scope`, see config.ts):
 *
 *   "last"       — final assistant message only. Concatenate its text
 *                  blocks. Drop ToolCall content, drop ThinkingContent,
 *                  drop images. Cheapest, most focused.
 *
 *   "sinceUser"  — walk backwards from the end until the last `role:
 *                  "user"` (exclusive). Collect assistant text blocks
 *                  + a one-line digest of each tool call. Skip thinking
 *                  blocks and tool-result bodies (their summaries leak
 *                  into the assistant's next text turn anyway).
 *
 * In both cases we hard-cap the output at ~8 000 characters by tail-
 * slicing — anything longer wastes summarizer tokens for a 1–2 sentence
 * playback.
 *
 * `selectSummaryInput` returns `""` (empty string) when there is nothing
 * worth summarising (e.g. assistant turn was tool-only). Callers treat
 * that as "skip TTS this turn".
 */

import type { Scope } from "./config.ts";

const MAX_INPUT_CHARS = 8_000;

// Minimal structural types — we only depend on what we read. Matches
// `@mariozechner/pi-ai` `AssistantMessage` / `UserMessage` /
// `ToolResultMessage` shapes. Using a structural shape keeps tests
// trivial (plain object literals) and avoids a hard runtime dep on
// pi-ai for downstream consumers of `messages.ts`.
export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolCallBlock {
  type: "toolCall";
  name: string;
  arguments?: Record<string, unknown>;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
export type AssistantBlock = TextBlock | ToolCallBlock | ThinkingBlock | { type: string; [k: string]: unknown };

export interface AssistantMessageLike {
  role: "assistant";
  content: AssistantBlock[];
}
export interface UserMessageLike {
  role: "user";
  content: unknown;
}
export interface ToolResultMessageLike {
  role: "toolResult";
  toolName?: string;
  content?: unknown;
  isError?: boolean;
}
export type SummaryMessage =
  | AssistantMessageLike
  | UserMessageLike
  | ToolResultMessageLike
  | { role: string; [k: string]: unknown };

function extractAssistantText(msg: AssistantMessageLike): string {
  const parts: string[] = [];
  for (const block of msg.content ?? []) {
    if (block && (block as { type?: unknown }).type === "text") {
      const text = (block as TextBlock).text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n");
}

function extractToolCallDigests(msg: AssistantMessageLike): string[] {
  const digests: string[] = [];
  for (const block of msg.content ?? []) {
    if (!block || (block as { type?: unknown }).type !== "toolCall") continue;
    const tc = block as ToolCallBlock;
    const name = tc.name || "tool";
    const args = succinctArgs(tc.arguments);
    digests.push(args ? `${name}: ${args}` : name);
  }
  return digests;
}

/**
 * One-line digest of tool-call args. We don't want to dump full file
 * contents or grep regexes verbatim — pick a couple of common keys and
 * truncate. The summarizer doesn't need exact args, just a hint of what
 * happened.
 */
function succinctArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  const interesting = [
    "command",
    "path",
    "file_path",
    "pattern",
    "url",
    "query",
    "old_string",
    "new_string",
  ];
  for (const key of interesting) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return summariseValue(value);
    }
  }
  // Fallback: stringify the whole object, capped.
  try {
    return summariseValue(JSON.stringify(args));
  } catch {
    return "";
  }
}

function summariseValue(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 77) + "…";
}

function tailSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

/**
 * Build the "Assistant output to summarize" payload that goes into the
 * summarizer prompt body. Returns "" when there is nothing meaningful to
 * summarise — caller skips TTS for the turn.
 */
export function selectSummaryInput(messages: SummaryMessage[], scope: Scope): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  if (scope === "last") {
    // Walk backwards to the final assistant message and dump its text.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== "assistant") continue;
      const text = extractAssistantText(msg as AssistantMessageLike).trim();
      return text ? tailSlice(text, MAX_INPUT_CHARS) : "";
    }
    return "";
  }

  // scope === "sinceUser" — collect everything after the last user message.
  // We walk forward from the message just after the last user index and
  // emit assistant text + tool-call digests in order. Tool-result bodies
  // are intentionally skipped — the assistant's next text turn typically
  // restates what mattered.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const start = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const blocks: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "assistant") {
      const text = extractAssistantText(msg as AssistantMessageLike).trim();
      if (text) blocks.push(text);
      const digests = extractToolCallDigests(msg as AssistantMessageLike);
      for (const d of digests) blocks.push(`(used ${d})`);
    }
    // Skip user (already past it) and toolResult.
  }

  const joined = blocks.join("\n").trim();
  if (!joined) return "";
  return tailSlice(joined, MAX_INPUT_CHARS);
}
