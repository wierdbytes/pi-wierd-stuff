/**
 * A typed client for pi-agents' `pi.events` RPC, for other extensions:
 *
 * ```ts
 * import { agentsClient } from "@wierdbytes/pi-agents/client";
 *
 * const agents = agentsClient(pi.events);
 * const a = await agents.spawn({ description: "Review diff", prompt: "…", model: "sonnet", thinking: "low" });
 * const done = await agents.wait(a.id);
 * console.log(done.status, done.result);
 * ```
 *
 * Importing this file does not load the extension; pi-agents itself must be
 * installed. `ping()` tells whether it is there and can start agents.
 */

import type { AgentSnapshot } from "./manager.ts";
import type { SpawnInput } from "./prepare.ts";
import { type EventBus, type RpcMethods, type RpcReply, replyChannel, RPC_PREFIX } from "./rpc.ts";

export type { AgentSnapshot, SpawnInput, EventBus };

export interface AgentsClient {
  ping(timeoutMs?: number): Promise<RpcMethods["ping"]["result"]>;
  /** Always background; the parent model is not notified unless `notify: true`. */
  spawn(input: Omit<SpawnInput, "background">): Promise<AgentSnapshot>;
  get(id: string): Promise<AgentSnapshot>;
  /** Until it finishes or needs a person. */
  wait(id: string, timeoutMs?: number): Promise<AgentSnapshot>;
  steer(id: string, message: string): Promise<AgentSnapshot & { mode: "steer" | "follow-up" }>;
  stop(id: string): Promise<AgentSnapshot>;
  list(): Promise<AgentSnapshot[]>;
  /** `agents:spawned|running|blocked|completed|failed|stopped`. */
  on(event: "spawned" | AgentSnapshot["status"], handler: (agent: AgentSnapshot) => void): () => void;
}

let counter = 0;

export function agentsClient(events: EventBus, defaultTimeoutMs = 30_000): AgentsClient {
  const request = <M extends keyof RpcMethods>(
    method: M,
    params: RpcMethods[M]["params"],
    timeoutMs: number | undefined = defaultTimeoutMs,
  ): Promise<RpcMethods[M]["result"]> => {
    const requestId = `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = events.on(replyChannel(method, requestId), (raw) => {
        off();
        if (timer) clearTimeout(timer);
        const reply = raw as RpcReply<RpcMethods[M]["result"]>;
        if (reply?.success) resolve(reply.data);
        else reject(new Error(reply?.error ?? "pi-agents: bad reply"));
      });
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`pi-agents: ${method} got no reply (is @wierdbytes/pi-agents installed?)`));
        }, timeoutMs);
      }
      events.emit(`${RPC_PREFIX}${method}`, { ...params, requestId });
    });
  };

  return {
    ping: (timeoutMs = 1000) => request("ping", {}, timeoutMs),
    spawn: (input) => request("spawn", input as SpawnInput, 60_000),
    get: (id) => request("get", { id }),
    // The RPC itself waits; give it room beyond the agent's own timeout.
    wait: (id, timeoutMs) => request("wait", { id, timeoutMs }, timeoutMs ? timeoutMs + 5000 : 0),
    steer: (id, message) => request("steer", { id, message }, 120_000),
    stop: (id) => request("stop", { id }),
    list: () => request("list", {}),
    on: (event, handler) => events.on(`agents:${event}`, (d) => handler(d as AgentSnapshot)),
  };
}
