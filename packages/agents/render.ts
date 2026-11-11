/**
 * TUI rendering in the facelift / tool-frame look:
 *
 *     ╭── Agent Explore Find auth code · sonnet-5-5 @low ─────────
 *     │      ╰ Find where the session cookie is validated…
 *     │ ⠼ working · 5 tool calls · read src/auth/session.ts
 *     ╰── find-auth-code · t8c · 0:12 ──────────────────────────
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  type FrameStatus,
  frameResultWithBottomLabel,
  frameTop,
  getDefaultFrameWidth,
} from "@wierdbytes/pi-common/tool-frame";
import { duration, elapsed } from "./format.ts";
import type { AgentSnapshot, AgentStatus } from "./manager.ts";

const PAD = { paddingX: 1 };
const COLLAPSED_LINES = 8;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export interface AgentToolDetails {
  agent?: AgentSnapshot;
  /** steer_subagent: how the message went in. */
  mode?: "steer" | "follow-up";
  error?: string;
}

const frameStatusOf = (s: AgentStatus): FrameStatus =>
  s === "completed" ? "success" : s === "failed" || s === "stopped" ? "error" : "pending";

const ICON: Record<AgentStatus, string> = {
  running: "◌",
  blocked: "◆",
  completed: "✓",
  failed: "✗",
  stopped: "■",
};

const COLOR: Record<AgentStatus, "warning" | "success" | "error" | "muted"> = {
  running: "warning",
  blocked: "warning",
  completed: "success",
  failed: "error",
  stopped: "muted",
};

const shortModel = (m: string | undefined): string | undefined => (m ? (m.split("/").pop() ?? m) : undefined);

export function modelChip(model: string | undefined, thinking: string | undefined): string | undefined {
  const m = shortModel(model);
  if (!m && !thinking) return undefined;
  return `${m ?? "inherit"}${thinking ? ` @${thinking}` : ""}`;
}

function firstLine(s: string | undefined, max = 200): string {
  return (s ?? "").trim().split("\n")[0]!.slice(0, max);
}

function frameStatusFromCtx(ctx: unknown): FrameStatus {
  const c = (ctx ?? {}) as { isError?: boolean; isPartial?: boolean };
  return c.isError ? "error" : c.isPartial ? "pending" : "success";
}

/** The body + bottom label for one agent. */
export function agentBody(
  s: AgentSnapshot,
  theme: Theme,
  expanded: boolean,
  now = Date.now(),
): { body: string; bottom: string; status: FrameStatus } {
  const lines: string[] = [];
  const act = s.activity;
  if (s.status === "running" || s.status === "blocked") {
    const head =
      s.status === "running"
        ? theme.fg("warning", `${SPINNER[Math.floor(now / 100) % SPINNER.length]} working`)
        : theme.fg("warning", `◆ needs a person${s.hcMessage ? `: ${s.hcMessage}` : ""} — open it in herdr`);
    const tools = act?.tools ? theme.fg("dim", ` · ${act.tools} tool call${act.tools === 1 ? "" : "s"}`) : "";
    lines.push(`${head}${tools}`);
    if (act?.tool) lines.push(theme.fg("dim", `  ${act.tool}${act.detail ? ` ${act.detail}` : ""}`));
  } else {
    const text = (s.result ?? "").trim();
    if (s.status === "failed" && s.error) lines.push(theme.fg("error", s.error.split("\n").slice(0, expanded ? 40 : 3).join("\n")));
    if (text) {
      const all = text.split("\n");
      const shown = expanded ? all : all.slice(0, COLLAPSED_LINES);
      lines.push(...shown.map((l) => theme.fg("toolOutput", l)));
      if (!expanded && all.length > shown.length) lines.push(theme.fg("dim", `… ${all.length - shown.length} more lines`));
    } else if (s.status === "completed") lines.push(theme.fg("dim", "(no final message)"));
    else if (s.status === "stopped") lines.push(theme.fg("muted", "stopped"));
  }
  const bottomParts = [
    theme.fg(COLOR[s.status], `${ICON[s.status]} ${s.status}`),
    theme.fg("dim", duration(elapsed(s, now))),
    theme.fg("dim", `${s.id} · ${s.address}`),
  ];
  if (act?.tools && s.status !== "running" && s.status !== "blocked") bottomParts.splice(2, 0, theme.fg("dim", `${act.tools} tool${act.tools === 1 ? "" : "s"}`));
  return { body: lines.join("\n"), bottom: bottomParts.join(theme.fg("dim", " · ")), status: frameStatusOf(s.status) };
}

// ─────────────────────────────────────────────────────────────── Agent ──

export interface AgentArgs {
  prompt?: string;
  description?: string;
  subagent_type?: string;
  model?: string;
  thinking?: string;
  run_in_background?: boolean;
}

export function renderAgentCall(args: AgentArgs, theme: Theme, ctx: unknown): Text {
  let title = theme.fg("toolTitle", theme.bold("Agent "));
  title += theme.fg("accent", args.subagent_type || "general-purpose");
  if (args.description) title += ` ${args.description}`;
  const chip = modelChip(args.model, args.thinking);
  if (chip) title += theme.fg("dim", ` · ${chip}`);
  if (args.run_in_background) title += theme.fg("dim", " · background");
  const prompt = firstLine(args.prompt);
  if (prompt) title += `\n${theme.fg("dim", prompt)}`;
  return new Text(frameTop(title, frameStatusFromCtx(ctx), theme, getDefaultFrameWidth()), 0, 0);
}

export function renderAgentResult(
  result: { details?: AgentToolDetails; content?: Array<{ type: string; text?: string }> },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Text {
  const width = getDefaultFrameWidth();
  const d = result.details;
  if (d?.agent) {
    const { body, bottom, status } = agentBody(d.agent, theme, options.expanded);
    if (d.agent.background && d.agent.status === "running" && !options.isPartial) {
      return new Text(
        frameResultWithBottomLabel(
          theme.fg("dim", "started in the background — you'll be told when it finishes"),
          bottom,
          "success",
          theme,
          width,
          PAD,
        ),
        0,
        0,
      );
    }
    return new Text(frameResultWithBottomLabel(body, bottom, status, theme, width, PAD), 0, 0);
  }
  const text = d?.error ?? result.content?.find((c) => c.type === "text")?.text ?? "";
  if (options.isPartial) {
    return new Text(frameResultWithBottomLabel(theme.fg("warning", "starting…"), "", "pending", theme, width, PAD), 0, 0);
  }
  return new Text(frameResultWithBottomLabel(theme.fg("error", text), theme.fg("error", "✗ error"), "error", theme, width, PAD), 0, 0);
}

// ──────────────────────────────────────────────── get / steer / stop ──

export function renderRefCall(tool: string, args: { agent_id?: string; wait?: boolean; message?: string }, theme: Theme, ctx: unknown): Text {
  let title = theme.fg("toolTitle", theme.bold(`${tool} `));
  title += theme.fg("accent", args.agent_id ?? "");
  if (args.wait) title += theme.fg("dim", " · wait");
  const msg = firstLine(args.message);
  if (msg) title += `\n${theme.fg("dim", msg)}`;
  return new Text(frameTop(title, frameStatusFromCtx(ctx), theme, getDefaultFrameWidth()), 0, 0);
}

export function renderRefResult(
  result: { details?: AgentToolDetails; content?: Array<{ type: string; text?: string }> },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Text {
  const width = getDefaultFrameWidth();
  const d = result.details;
  if (d?.mode && d.agent) {
    const line = d.mode === "steer" ? "→ delivered as a steer while it works" : "→ follow-up sent; it's working again";
    return new Text(frameResultWithBottomLabel(theme.fg("muted", line), theme.fg("dim", `${d.agent.id} · ${d.agent.address}`), "success", theme, width, PAD), 0, 0);
  }
  if (d?.agent) return renderAgentResult(result, options, theme);
  const text = d?.error ?? result.content?.find((c) => c.type === "text")?.text ?? "";
  return new Text(frameResultWithBottomLabel(theme.fg("error", text), theme.fg("error", "✗ error"), "error", theme, width, PAD), 0, 0);
}

// ───────────────────────────────────────────────────── notification ──

export interface NotificationDetails {
  agents: AgentSnapshot[];
}

export function renderNotification(details: NotificationDetails | undefined, expanded: boolean, theme: Theme): Text {
  const agents = details?.agents ?? [];
  const width = getDefaultFrameWidth();
  const blocks = agents.map((s) => {
    const { body, bottom, status } = agentBody(s, theme, expanded);
    let title = theme.fg("toolTitle", theme.bold("Agent "));
    title += theme.fg("accent", s.type);
    title += ` ${s.description}`;
    const chip = modelChip(s.model, s.thinking);
    if (chip) title += theme.fg("dim", ` · ${chip}`);
    return `${frameTop(title, status, theme, width)}\n${frameResultWithBottomLabel(body, bottom, status, theme, width, PAD)}`;
  });
  return new Text(blocks.join("\n"), 0, 0);
}
