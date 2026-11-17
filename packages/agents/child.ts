/**
 * Child side: this pi was started by pi-agents (`PI_AGENTS_RUN` is set).
 * It tells the model it is a sub-agent, inherits the parent's project trust
 * and keeps `<runs>/<runId>.json` current so the parent can collect the
 * result without scraping the screen.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENV, ENV_PREFIX } from "./launch.ts";
import { type ChildState, type LastStatus, readMeta, type RunMeta, writeState } from "./runs.ts";

export interface ChildInfo {
  runId: string;
  dir: string;
  depth: number;
  /** The parent's answer to "is this project trusted?", when it had one. */
  trust?: "yes" | "no";
  meta?: RunMeta;
}

export function childFromEnv(env: NodeJS.ProcessEnv = process.env): ChildInfo | undefined {
  const runId = env[ENV.RUN];
  const dir = env[ENV.DIR];
  if (!runId || !dir) return undefined;
  const depth = Number.parseInt(env[ENV.DEPTH] ?? "1", 10);
  const trust = env[ENV.TRUST];
  return {
    runId,
    dir,
    depth: Number.isFinite(depth) && depth > 0 ? depth : 1,
    trust: trust === "yes" || trust === "no" ? trust : undefined,
    meta: readMeta(dir, runId),
  };
}

/** Where {@link takeChildEnv} keeps what it took, for the life of the process. */
const TAKEN = Symbol.for("@wierdbytes/pi-agents/child-env");

/**
 * Takes `PI_AGENTS_*` out of `env` and returns them. Left in place, everything
 * this pi starts would inherit them — a bash command, the `pi -p` another
 * extension runs to summarize a page — and a pi among those would load
 * pi-agents, take itself for this sub-agent and write its run file: the
 * parent would get that pi's answer as this sub-agent's result.
 *
 * pi imports extensions anew (no module cache) on /reload, /new, /resume and
 * /fork, so what was taken stays on `holder` for the next load to find.
 */
export function takeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  holder: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): Record<string, string> {
  let taken = holder[TAKEN] as Record<string, string> | undefined;
  if (!taken) {
    taken = {};
    for (const [k, v] of Object.entries(env)) if (k.startsWith(ENV_PREFIX) && v !== undefined) taken[k] = v;
    holder[TAKEN] = taken;
  }
  for (const k of Object.keys(env)) if (k.startsWith(ENV_PREFIX)) delete env[k];
  return { ...taken };
}

export function subagentSection(meta: RunMeta | undefined): string {
  const lines = [
    `You are a sub-agent${meta ? ` ("${meta.description}", type ${meta.type})` : ""}, started by another agent${
      meta ? ` in terminal ${meta.parent}` : ""
    } to do one task. It sees nothing of your work except your final message.`,
    "- Work autonomously on the task in the first message. Don't ask the user questions unless you are truly blocked; make reasonable assumptions and state them.",
    "- Your last message is returned to the parent verbatim as your report. Make it self-contained: what you found or did, exact file paths and line numbers, what you changed, what is left or uncertain.",
    "- Stay within the scope you were given. Don't start other agents.",
    '- Later messages from the agent that started you arrive wrapped in <hc from="…">: treat them as its instructions and answer in your final message. Never reply with `hc send`; your final message reaches it automatically.',
  ];
  if (meta?.typePrompt) lines.push("", meta.typePrompt);
  return lines.join("\n");
}

interface TextBlock {
  type: string;
  text?: string;
}

/** The last assistant message on the branch: its text, and how it ended. */
export function lastAssistant(entries: readonly unknown[]): { text: string; status: LastStatus; error?: string } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; message?: any };
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    const m = e.message;
    const text = Array.isArray(m.content)
      ? (m.content as TextBlock[])
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
          .trim()
      : typeof m.content === "string"
        ? m.content.trim()
        : "";
    if (m.stopReason === "error") return { text, status: "error", error: String(m.errorMessage ?? "error") };
    if (m.stopReason === "aborted") return { text, status: "aborted" };
    return { text, status: "done" };
  }
  return undefined;
}

/** A one-line hint of what a tool call is about: a path, a pattern, a command. */
export function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const k of ["path", "file_path", "pattern", "command", "query", "url", "description", "prompt"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0]!.slice(0, 120);
  }
  return undefined;
}

export function setupChild(pi: ExtensionAPI, info: ChildInfo): void {
  const state: ChildState = {
    v: 1,
    runId: info.runId,
    pid: process.pid,
    seq: 0,
    running: false,
    activity: { tools: 0, turns: 0, at: Date.now() },
    updatedAt: Date.now(),
  };
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    state.updatedAt = Date.now();
    try {
      writeState(info.dir, state);
    } catch {
      // The parent falls back to the screen; never disturb this pi.
    }
  };
  /** Picks up the context in use; true when it moved. */
  const readContext = (next?: ExtensionContext): boolean => {
    if (next) ctx = next;
    let usage: ReturnType<ExtensionContext["getContextUsage"]>;
    try {
      usage = ctx?.getContextUsage();
    } catch {
      return false;
    }
    if (!usage || usage.tokens == null || usage.contextWindow <= 0) return false;
    const a = state.activity!;
    if (a.context?.tokens === usage.tokens && a.context.window === usage.contextWindow) return false;
    a.context = { tokens: usage.tokens, window: usage.contextWindow };
    a.at = Date.now();
    return true;
  };
  const soon = () => {
    if (timer) return;
    timer = setTimeout(flush, 400);
    timer.unref?.();
  };

  const trust = info.trust;
  if (trust) pi.on("project_trust", async () => ({ trusted: trust }));

  pi.on("session_start", async (_e, next) => {
    ctx = next;
    try {
      state.sessionId = next.sessionManager.getSessionId();
      state.sessionFile = next.sessionManager.getSessionFile();
    } catch {
      // Ephemeral sessions have neither.
    }
    flush();
  });

  pi.on("before_agent_start", async (event) => {
    const sections = event.systemPromptOptions?.sections;
    if (sections) sections.subagent = subagentSection(info.meta);
  });

  pi.on("agent_start", async () => {
    state.running = true;
    flush();
  });

  pi.on("tool_execution_start", async (event, next) => {
    readContext(next);
    const a = state.activity!;
    a.tools++;
    a.tool = event.toolName;
    a.detail = toolDetail(event.args);
    a.at = Date.now();
    soon();
  });

  pi.on("turn_end", async (_e, next) => {
    state.activity!.turns++;
    readContext(next);
    soon();
  });

  // Final: pi won't continue on its own. pi reports done/error over OSC 7501
  // at the same moment, so the parent hears about it from either side.
  pi.on("agent_settled", async (event, next) => {
    readContext(next);
    let last: ReturnType<typeof lastAssistant>;
    try {
      last = ctx ? lastAssistant(ctx.sessionManager.getBranch()) : undefined;
    } catch {
      last = undefined;
    }
    state.seq++;
    state.running = false;
    state.last = {
      status: event.aborted ? "aborted" : (last?.status ?? "done"),
      text: last?.text ?? "",
      error: last?.error,
      at: Date.now(),
    };
    flush();
  });

  pi.on("session_shutdown", async () => {
    if (timer) flush();
  });
}
