/**
 * Pull the naming input out of a session branch.
 *
 * Pure: takes session entries (`ctx.sessionManager.getBranch()`), returns
 * plain strings. Only what the user asked and what the assistant said in
 * text goes in; tool calls, tool results, thinking and custom messages
 * never do.
 */

export const FIRST_REQUEST_CHARS = 2000;
export const RECENT_REQUEST_CHARS = 500;
export const RECENT_REQUESTS = 3;
export const ASSISTANT_CHARS = 800;

export interface NamingInput {
  /** The session's first user request. */
  first: string;
  /** Up to `RECENT_REQUESTS` later user requests, oldest first. */
  recent: string[];
  /** The last assistant text reply, if any. */
  assistant: string;
}

interface EntryLike {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
    .map((p) => String((p as { text?: unknown }).text ?? ""))
    .join("\n");
}

/** Collapse injected skill bodies to their name and drop pasted-image paths. */
export function stripInjected(text: string): string {
  return text
    .replace(/<skill\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g, "[skill: $1]")
    .replace(/\S*pi-clipboard-[\w-]+\.(?:png|jpe?g|gif|webp)\S*/g, "")
    .trim();
}

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

export function collectInput(entries: readonly unknown[]): NamingInput | undefined {
  const users: string[] = [];
  let assistant = "";
  for (const raw of entries) {
    const e = raw as EntryLike;
    if (e?.type !== "message" || !e.message) continue;
    const role = e.message.role;
    if (role === "user") {
      const text = stripInjected(textOf(e.message.content));
      if (text) users.push(text);
    } else if (role === "assistant") {
      const text = textOf(e.message.content).trim();
      if (text) assistant = text;
    }
  }
  if (users.length === 0) return undefined;
  return {
    first: clip(users[0], FIRST_REQUEST_CHARS),
    recent: users.slice(1).slice(-RECENT_REQUESTS).map((u) => clip(u, RECENT_REQUEST_CHARS)),
    assistant: clip(assistant, ASSISTANT_CHARS),
  };
}
