/**
 * `pi.events` RPC for other extensions. Request on `agents:rpc:<method>`
 * with a `requestId`; the reply comes on `agents:rpc:<method>:reply:<requestId>`
 * as `{ success: true, data }` or `{ success: false, error }`.
 *
 * Lifecycle broadcasts: `agents:<status>` (`spawned`, `running`, `blocked`,
 * `completed`, `failed`, `stopped`) with the agent's snapshot.
 *
 * `client.ts` wraps this; the protocol is described in README.md.
 */

import type { AgentManager, AgentSnapshot, AgentStatus } from "./manager.ts";
import { isFinal, snapshot } from "./manager.ts";
import type { SpawnInput } from "./prepare.ts";

export const RPC_VERSION = 1;
export const RPC_PREFIX = "agents:rpc:";
export const replyChannel = (method: string, requestId: string) => `${RPC_PREFIX}${method}:reply:${requestId}`;

export type RpcReply<T> = { success: true; data: T } | { success: false; error: string };

export interface EventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export interface RpcMethods {
  ping: { params: Record<string, never>; result: { version: number; available: boolean } };
  spawn: { params: SpawnInput; result: AgentSnapshot };
  get: { params: { id: string }; result: AgentSnapshot };
  wait: { params: { id: string; timeoutMs?: number }; result: AgentSnapshot };
  steer: { params: { id: string; message: string }; result: AgentSnapshot & { mode: "steer" | "follow-up" } };
  stop: { params: { id: string }; result: AgentSnapshot };
  list: { params: Record<string, never>; result: AgentSnapshot[] };
}

export interface RpcDeps {
  events: EventBus;
  manager: AgentManager;
  unavailable(): string | undefined;
  /** Resolves the spawn input against the live session, or throws. */
  spawn(input: SpawnInput): Promise<AgentSnapshot>;
}

export function registerRpc(deps: RpcDeps): () => void {
  const { events, manager } = deps;
  const offs: Array<() => void> = [];

  const handle = <M extends keyof RpcMethods>(
    method: M,
    fn: (params: RpcMethods[M]["params"]) => Promise<RpcMethods[M]["result"]> | RpcMethods[M]["result"],
  ) => {
    offs.push(
      events.on(`${RPC_PREFIX}${method}`, (raw) => {
        const req = (raw ?? {}) as { requestId?: unknown } & Record<string, unknown>;
        if (typeof req.requestId !== "string") return;
        const reply = replyChannel(method, req.requestId);
        Promise.resolve()
          .then(() => {
            const why = method === "ping" ? undefined : deps.unavailable();
            if (why) throw new Error(why);
            return fn(req as unknown as RpcMethods[M]["params"]);
          })
          .then(
            (data) => events.emit(reply, { success: true, data } satisfies RpcReply<unknown>),
            (e) => events.emit(reply, { success: false, error: e instanceof Error ? e.message : String(e) } satisfies RpcReply<unknown>),
          );
      }),
    );
  };

  const find = (id: unknown) => {
    const rec = typeof id === "string" ? manager.find(id) : undefined;
    if (!rec) throw new Error(`No sub-agent "${String(id)}"`);
    return rec;
  };

  handle("ping", () => ({ version: RPC_VERSION, available: deps.unavailable() === undefined }));
  handle("spawn", (p) => deps.spawn({ ...p, background: true, notify: p.notify ?? false }));
  handle("get", (p) => snapshot(find(p.id)));
  handle("wait", async (p) => {
    const rec = find(p.id);
    await manager.wait(rec, { timeoutMs: p.timeoutMs });
    if (isFinal(rec.status)) rec.consumed = true;
    return snapshot(rec);
  });
  handle("steer", async (p) => {
    const rec = find(p.id);
    const { mode } = await manager.steer(rec, p.message);
    return { ...snapshot(rec), mode };
  });
  handle("stop", async (p) => {
    const rec = find(p.id);
    await manager.stop(rec);
    return snapshot(rec);
  });
  handle("list", () => manager.list().map(snapshot));

  offs.push(
    manager.onChange((rec, previous) => {
      if (previous === rec.status) return;
      const name: AgentStatus | "spawned" = previous === undefined ? "spawned" : rec.status;
      events.emit(`agents:${name}`, snapshot(rec));
    }),
  );

  return () => {
    for (const off of offs.splice(0)) off();
  };
}
