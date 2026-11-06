/**
 * @wierdbytes/pi-herdr — tells herdr which model, reasoning effort and
 * context size a pi session runs with, as `agent.*` labels on its
 * herdr-core terminal. Herdr's agent lists can then show
 * `Opus 5.5 @high · 228k` under each pi, next to the status pi already
 * reports over OSC 7501.
 *
 * Wiring only; the labels are built in `meta.ts`, written in `publisher.ts`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CacheEntry, type CacheWindow, cacheWindow, envRetention, type InflightRequest, WarmWatch } from "./cache.ts";
import { hcTargetFromEnv, setLabels } from "./hc.ts";
import { collectLabels, type MetaModel } from "./meta.ts";
import { LabelPublisher } from "./publisher.ts";
import { SubagentCounter } from "./subagents.ts";

export default function piHerdr(pi: ExtensionAPI) {
  const target = hcTargetFromEnv();
  if (!target) return;

  const publisher = new LabelPublisher((labels) => setLabels(target, labels));
  // pi-subagents emits from its own session_start, so listen from load on.
  const subagents = new SubagentCounter(() => update());
  subagents.start(pi.events);

  /** The interactive session's latest ctx; unset until it starts, and for `pi -p` / RPC / sub-agents. */
  let ctx: ExtensionContext | undefined;
  let model: MetaModel | undefined;
  /** A reply still streaming: it refreshed the prompt cache at its start. */
  let inflight: InflightRequest | undefined;
  /** The prompt cache last published, for the warming poll. */
  let cache: CacheWindow | undefined;
  const warm = new WarmWatch(() => {
    update();
    return cache?.until;
  });

  function update(next?: ExtensionContext, nextModel?: MetaModel): void {
    if (!ctx) return;
    if (next) ctx = next;
    let context: { tokens: number | null; contextWindow: number } | undefined;
    let session: string | undefined;
    try {
      context = ctx.getContextUsage();
      // Only a session saved to a file can be opened again (`pi --session <id>`).
      if (ctx.sessionManager.getSessionFile()) session = ctx.sessionManager.getSessionId();
      model = nextModel ?? (ctx.model as MetaModel | undefined) ?? model;
      const registry = ctx.modelRegistry;
      cache = cacheWindow(
        ctx.sessionManager.getBranch() as readonly CacheEntry[],
        (provider, modelId) => registry?.find(provider, modelId)?.promptCache,
        envRetention(),
        inflight,
      );
    } catch {
      // A replaced session's ctx goes stale; the next event brings a fresh one.
      return;
    }
    publisher.publish(
      collectLabels({
        pid: process.pid,
        model,
        thinkingLevel: pi.getThinkingLevel?.(),
        context,
        subagents: subagents.count,
        session,
        cache,
      }),
    );
  }

  pi.on("session_start", async (_event, next) => {
    // Only the interactive pi owns the terminal: `pi -p` runs, RPC hosts and
    // sub-agents started inside this terminal must not overwrite its labels.
    if (next.mode !== "tui") return;
    ctx = next;
    update();
    await publisher.flush();
  });
  pi.on("model_select", async (event, next) => update(next, event.model as MetaModel));
  pi.on("thinking_level_select", async (_event, next) => update(next));
  pi.on("message_start", async (event, next) => {
    const message = event.message as { role?: string; provider?: string; model?: string; timestamp?: number };
    if (message.role !== "assistant" || !message.provider || !message.model) return;
    inflight = {
      at: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      provider: message.provider,
      model: message.model,
    };
    update(next);
  });
  pi.on("message_end", async (event, next) => {
    if (event.message.role !== "assistant") return;
    inflight = undefined;
    update(next);
  });
  pi.on("turn_end", async (_event, next) => update(next));
  pi.on("agent_end", async (_event, next) => {
    // An aborted stream must not leave a request in flight.
    inflight = undefined;
    update(next);
  });
  pi.on("agent_settled", async (_event, next) => update(next));
  pi.on("session_compact", async (_event, next) => update(next));
  pi.on("session_tree", async (_event, next) => update(next));
  // pi is about to refresh the cache; its usage entry lands a moment later.
  pi.on("cache_warming_decision", async () => {
    if (ctx) warm.start();
  });

  pi.on("session_shutdown", async (event) => {
    const owned = ctx !== undefined;
    ctx = undefined;
    inflight = undefined;
    warm.stop();
    if (event.reason === "quit") {
      subagents.dispose();
      if (owned) await publisher.clear();
      return;
    }
    // Switching sessions or reloading: the next session republishes at its
    // start, so leave the labels in place instead of flickering.
    subagents.reset();
    publisher.cancel();
  });
}
