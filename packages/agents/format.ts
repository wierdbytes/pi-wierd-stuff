/** What the parent's model reads about a sub-agent. Plain text, no ANSI. */

import type { AgentSnapshot } from "./manager.ts";

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${String(s % 60).padStart(2, "0")}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${String(m % 60).padStart(2, "0")}m` : ""}`;
}

export const elapsed = (s: AgentSnapshot, now = Date.now()): number => (s.endedAt ?? now) - s.startedAt;

export function activityText(s: AgentSnapshot): string | undefined {
  const a = s.activity;
  if (!a || a.tools === 0) return undefined;
  const last = a.tool ? `, last: ${a.tool}${a.detail ? ` ${a.detail}` : ""}` : "";
  return `${a.tools} tool call${a.tools === 1 ? "" : "s"}${last}`;
}

/** `Agent "Find auth code" [find-auth-code · t8c]` */
export const label = (s: AgentSnapshot): string => `Agent "${s.description}" [${s.id} · ${s.address}]`;

export function statusLine(s: AgentSnapshot, now = Date.now()): string {
  const took = duration(elapsed(s, now));
  const act = activityText(s);
  switch (s.status) {
    case "running":
      return `${label(s)} is still working (${took}${act ? `, ${act}` : ""}).`;
    case "blocked":
      return `${label(s)} is blocked waiting for a person${s.hcMessage ? ` (${s.hcMessage})` : ""}. It is in herdr under this agent; ask the user to answer it there.`;
    case "completed":
      return `${label(s)} completed in ${took}${s.activity?.tools ? ` (${s.activity.tools} tool calls)` : ""}${s.error === "interrupted" ? ", interrupted by a person" : ""}.`;
    case "failed":
      return `${label(s)} failed after ${took}: ${s.error ?? "unknown error"}`;
    case "stopped":
      return `${label(s)} was stopped after ${took}.`;
  }
}

const NEXT_STEPS =
  "It stays open, idle, in herdr: steer_subagent sends it a follow-up, stop_subagent closes it.";

export function forModel(s: AgentSnapshot, now = Date.now()): string {
  const parts = [statusLine(s, now)];
  if (s.status === "completed" || s.status === "failed" || s.status === "stopped") {
    if (s.result) parts.push("", s.result);
    else if (s.status === "completed") parts.push("", "(no final message)");
    if (s.status !== "stopped" && s.live) parts.push("", NEXT_STEPS);
  }
  return parts.join("\n");
}

export function startedText(s: AgentSnapshot): string {
  return [
    `Started ${label(s)} in the background${s.model ? ` on ${s.model}${s.thinking ? ` @${s.thinking}` : ""}` : ""}.`,
    `You'll get its result as a message when it finishes; get_subagent_result with wait: true blocks for it, steer_subagent sends it more instructions.`,
  ].join("\n");
}

export function notificationText(list: readonly AgentSnapshot[], now = Date.now()): string {
  return list
    .map((s) => `<subagent id="${s.id}" terminal="${s.address}" status="${s.status}">\n${forModel(s, now)}\n</subagent>`)
    .join("\n\n");
}
