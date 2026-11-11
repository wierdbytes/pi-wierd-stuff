/**
 * @wierdbytes/pi-agents — sub-agents as their own pi in herdr-core
 * terminals, started as children of this pi's terminal so herdr nests them
 * under it. Wiring only:
 *
 * - `child.ts`    — this pi *is* a sub-agent: report results through the run file
 * - `manager.ts`  — start / follow / steer / stop children
 * - `tools.ts`    — Agent, get_subagent_result, steer_subagent, stop_subagent
 * - `rpc.ts`      — the same over pi.events for other extensions
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAgentTypes } from "./agent-types.ts";
import { childFromEnv, setupChild } from "./child.ts";
import { notificationText } from "./format.ts";
import { endpointFromEnv } from "./hc.ts";
import { AgentManager, type AgentRecord, isFinal, snapshot } from "./manager.ts";
import { type PrepareContext, prepareSpawn } from "./prepare.ts";
import { type NotificationDetails, renderNotification } from "./render.ts";
import { registerRpc } from "./rpc.ts";
import { pruneRuns } from "./runs.ts";
import { loadSettings, runsDir } from "./settings.ts";
import { registerTools } from "./tools.ts";

export const NOTIFICATION_TYPE = "pi-agents:notification";

export default function piAgents(pi: ExtensionAPI) {
  const child = childFromEnv();
  if (child) setupChild(pi, child);

  const settings = loadSettings();
  const depth = child?.depth ?? 0;
  // Sub-agents don't start more sub-agents unless maxDepth allows it.
  if (depth >= settings.maxDepth) return;

  const endpoint = endpointFromEnv();
  const unavailable = endpoint
    ? undefined
    : "pi-agents starts sub-agents as herdr-core terminals, but this pi isn't running in one (HC_TERMINAL_ID / HC_TERMINAL_SOCKET unset). Start pi from herdr.";
  const dir = runsDir();
  const manager = new AgentManager({
    endpoint: endpoint ?? { socket: "", terminal: "" },
    runsDir: dir,
    settings,
    depth,
  });

  let ctx: ExtensionContext | undefined;

  const prepareContext = (c: ExtensionContext): PrepareContext => {
    let trusted: boolean | undefined;
    try {
      trusted = c.isProjectTrusted();
    } catch {
      trusted = undefined;
    }
    return {
      cwd: c.cwd,
      types: loadAgentTypes(c.cwd, trusted === true),
      available: c.modelRegistry.getAvailable(),
      scoped: (c.scopedModels ?? []).map((s) => s.model),
      currentModel: c.model,
      currentThinking: c.thinkingLevel ?? pi.getThinkingLevel?.(),
      projectTrusted: trusted,
    };
  };

  const tools = { pi, manager, unavailable, prepareContext };
  // Outside herdr-core there's nowhere to start sub-agents: offer no tools
  // the model would only fail with (the RPC still answers ping).
  if (!unavailable) registerTools(tools, loadAgentTypes(process.cwd(), false).values());

  registerRpc({
    events: pi.events,
    manager,
    unavailable: () => unavailable ?? (ctx ? undefined : "pi-agents: no session yet"),
    spawn: async (input) => {
      if (!ctx) throw new Error("pi-agents: no session yet");
      return snapshot(await manager.spawn(prepareSpawn(input, prepareContext(ctx))));
    },
  });

  // ─────────────────────────────────────────── completion notifications ──

  const pending = new Set<AgentRecord>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const deliverable = (r: AgentRecord) =>
    r.notify && !r.consumed && ((isFinal(r.status) && r.status !== "stopped") || r.status === "blocked");

  const flush = () => {
    flushTimer = undefined;
    // While this pi works, hold the news: the model may still collect the
    // result itself (get_subagent_result), and a queued message can't be taken back.
    let idle = true;
    try {
      idle = ctx?.isIdle() ?? true;
    } catch {
      idle = true;
    }
    if (!idle) return;
    const list = [...pending].filter(deliverable);
    pending.clear();
    if (list.length === 0) return;
    const finished = list.filter((r) => isFinal(r.status));
    for (const r of finished) r.consumed = true;
    const agents = list.map(snapshot);
    pi.sendMessage<NotificationDetails>(
      { customType: NOTIFICATION_TYPE, content: notificationText(agents), display: true, details: { agents } },
      // A finished result is news to act on; "needs a person" is only for the record.
      { deliverAs: "followUp", triggerTurn: finished.length > 0 },
    );
  };

  const scheduleFlush = () => {
    if (flushTimer || pending.size === 0) return;
    flushTimer = setTimeout(flush, 300);
    flushTimer.unref?.();
  };

  manager.onChange((rec, previous) => {
    if (previous === rec.status || !deliverable(rec)) return;
    pending.add(rec);
    // Agents finishing together arrive as one message.
    scheduleFlush();
  });

  pi.on("agent_settled", async (_event, next) => {
    ctx = next ?? ctx;
    scheduleFlush();
  });

  pi.registerMessageRenderer<NotificationDetails>(NOTIFICATION_TYPE, (message, { expanded }, theme) =>
    renderNotification(message.details, expanded, theme),
  );

  // ─────────────────────────────────────────────────────────── /agents ──

  pi.registerCommand("agents", {
    description: "Sub-agents of this pi: peek at one in herdr, or stop it",
    handler: async (_args, c) => {
      const list = manager.list();
      if (list.length === 0) {
        c.ui.notify("No sub-agents in this pi yet.", "info");
        return;
      }
      const options = list.map((r) => `${r.id} · ${r.address} · ${r.status}${r.live ? "" : " (closed)"} — ${r.description}`);
      const picked = await c.ui.select("Sub-agents", options);
      const rec = picked ? list[options.indexOf(picked)] : undefined;
      if (!rec) return;
      const actions = rec.live ? ["Peek in herdr", "Stop and close"] : ["Peek in herdr"];
      const action = await c.ui.select(`${rec.id} (${rec.address})`, actions);
      if (action === "Peek in herdr") {
        const r = await pi.exec("herdr-app", ["do", "terminal.peek", "--terminal", rec.address]).catch(() => undefined);
        if (!r || r.code !== 0) c.ui.notify(`Couldn't open ${rec.address} in herdr${r?.stderr ? `: ${r.stderr.trim()}` : ""}`, "warning");
      } else if (action === "Stop and close") {
        await manager.stop(rec).catch((e) => c.ui.notify(String(e instanceof Error ? e.message : e), "error"));
      }
    },
  });

  // ─────────────────────────────────────────────────────────── session ──

  pi.on("session_start", async (_event, next) => {
    ctx = next;
    if (unavailable) return;
    // Agent types can come from the project: refresh the tool description.
    registerTools(tools, prepareContext(next).types.values());
    manager.start();
    pruneRuns(dir);
  });

  pi.on("session_shutdown", async (event) => {
    ctx = undefined;
    if (event.reason !== "quit") return;
    // herdr-core ends children with their terminal, but the terminal is the
    // shell pi runs in: end them with pi instead.
    await manager.stopAll();
    manager.dispose();
  });
}
