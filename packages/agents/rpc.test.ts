import { describe, expect, it } from "vitest";
import { agentsClient } from "./client.ts";
import type { AgentManager, AgentRecord } from "./manager.ts";
import { type EventBus, registerRpc } from "./rpc.ts";

function bus(): EventBus {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    on(channel, h) {
      const set = handlers.get(channel) ?? new Set();
      handlers.set(channel, set);
      set.add(h);
      return () => set.delete(h);
    },
    emit(channel, data) {
      for (const h of [...(handlers.get(channel) ?? [])]) h(data);
    },
  };
}

const rec = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "review",
  address: "t5",
  runId: "r1",
  description: "Review",
  type: "general-purpose",
  cwd: "/",
  status: "completed",
  background: true,
  startedAt: 0,
  endedAt: 10,
  result: "LGTM",
  live: true,
  notify: false,
  consumed: false,
  baseline: 1,
  ...over,
});

function fakeManager(records: AgentRecord[]) {
  const listeners = new Set<(r: AgentRecord, p: AgentRecord["status"] | undefined) => void>();
  return {
    list: () => records,
    find: (id: string) => records.find((r) => r.id === id || r.address === id),
    wait: async () => "settled" as const,
    steer: async () => ({ mode: "follow-up" as const }),
    stop: async (r: AgentRecord) => {
      r.status = "stopped";
    },
    onChange: (l: (r: AgentRecord, p: AgentRecord["status"] | undefined) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    fire: (r: AgentRecord, p: AgentRecord["status"] | undefined) => {
      for (const l of listeners) l(r, p);
    },
  };
}

describe("rpc + client", () => {
  it("round-trips through pi.events", async () => {
    const events = bus();
    const r = rec();
    const manager = fakeManager([r]);
    const spawned: unknown[] = [];
    registerRpc({
      events,
      manager: manager as unknown as AgentManager,
      unavailable: () => undefined,
      spawn: async (input) => {
        spawned.push(input);
        return { ...r, id: "new" };
      },
    });
    const client = agentsClient(events, 1000);

    expect(await client.ping()).toEqual({ version: 1, available: true });
    expect((await client.spawn({ prompt: "p", description: "d", model: "sonnet" })).id).toBe("new");
    expect(spawned[0]).toMatchObject({ prompt: "p", background: true, notify: false });
    expect((await client.wait("review")).result).toBe("LGTM");
    expect(r.consumed).toBe(true);
    expect((await client.steer("t5", "more")).mode).toBe("follow-up");
    expect((await client.list()).map((a) => a.id)).toEqual(["review"]);
    await expect(client.get("nope")).rejects.toThrow(/No sub-agent "nope"/);
    expect((await client.stop("review")).status).toBe("stopped");
  });

  it("refuses when sub-agents can't start, and broadcasts lifecycle", async () => {
    const events = bus();
    const manager = fakeManager([]);
    registerRpc({
      events,
      manager: manager as unknown as AgentManager,
      unavailable: () => "not in herdr",
      spawn: async () => {
        throw new Error("unreachable");
      },
    });
    const client = agentsClient(events, 1000);
    expect(await client.ping()).toEqual({ version: 1, available: false });
    await expect(client.list()).rejects.toThrow("not in herdr");

    const seen: string[] = [];
    client.on("spawned", (a) => seen.push(`spawned:${a.id}`));
    client.on("completed", (a) => seen.push(`completed:${a.id}`));
    const r = rec({ status: "running" });
    manager.fire(r, undefined);
    r.status = "completed";
    manager.fire(r, "running");
    expect(seen).toEqual(["spawned:review", "completed:review"]);
  });
});
