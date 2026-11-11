/**
 * The smallest herdr-core client this needs, over the JSON-RPC socket
 * herdr-core hands every terminal (`HC_TERMINAL_SOCKET`), one request per
 * connection: `terminal.label` for the agent's labels, `doc.get` / `doc.set`
 * for the shared limits document. Talking to the socket directly instead of
 * spawning `hc` keeps it cheap enough to run after every reply.
 */

import net from "node:net";

export interface HcTarget {
  socket: string;
  terminal: string;
}

/** The terminal pi runs in, when herdr-core started it. */
export function hcTargetFromEnv(env: NodeJS.ProcessEnv = process.env): HcTarget | undefined {
  const socket = env.HC_TERMINAL_SOCKET;
  const terminal = env.HC_TERMINAL_ID;
  if (!socket || !terminal) return undefined;
  return { socket, terminal };
}

/** One answer from herdr-core: its result, or the error kind it gave (`conflict`, `not_found`…). */
export type RpcReply = { ok: true; result: unknown } | { ok: false; error: string };

let nextId = 1;

/**
 * Sends one request and resolves with herdr-core's answer. A missing core, a
 * broken reply or no answer within `timeoutMs` resolve as an error too
 * (`unreachable`, `bad_reply`, `timeout`). Never throws: a missing core must
 * not disturb pi.
 */
export function rpc(socketPath: string, method: string, params: Record<string, unknown>, timeoutMs = 1500): Promise<RpcReply> {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const request = { jsonrpc: "2.0", id: nextId++, method, params };
  return new Promise((resolve) => {
    let done = false;
    let buffer = "";
    const socket = net.createConnection(endpoint);
    const finish = (reply: RpcReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    timer.unref?.();
    socket.on("error", () => finish({ ok: false, error: "unreachable" }));
    socket.on("end", () => finish({ ok: false, error: "unreachable" }));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        if (reply?.id !== request.id) finish({ ok: false, error: "bad_reply" });
        else if (reply.error !== undefined) finish({ ok: false, error: String(reply.error?.data?.kind ?? reply.error?.message ?? "error") });
        else if (reply.result !== undefined) finish({ ok: true, result: reply.result });
        else finish({ ok: false, error: "bad_reply" });
      } catch {
        finish({ ok: false, error: "bad_reply" });
      }
    });
  });
}

/**
 * Sets (value) or removes (`""`) labels on the terminal. Resolves true once
 * herdr-core answered with a result, false on any error or after `timeoutMs`.
 */
export async function setLabels(target: HcTarget, labels: Record<string, string>, timeoutMs = 1500): Promise<boolean> {
  const reply = await rpc(target.socket, "terminal.label", { terminal: target.terminal, labels }, timeoutMs);
  return reply.ok;
}

/** A herdr-core document and its version (zero when never written). */
export interface Doc {
  value: unknown;
  version: number;
}

/** Reads a document from this machine's core; undefined when the core can't be asked. */
export async function getDoc(socket: string, name: string, timeoutMs = 1500): Promise<Doc | undefined> {
  const reply = await rpc(socket, "doc.get", { name }, timeoutMs);
  if (!reply.ok) return undefined;
  const result = reply.result as { value?: unknown; version?: unknown } | null;
  if (typeof result?.version !== "number") return undefined;
  return { value: result.value ?? null, version: result.version };
}

/**
 * Writes a document if it is still at `version`. Resolves with the new
 * version, `"conflict"` when someone wrote it in between (read it again and
 * retry), or undefined on any other failure.
 */
export async function setDoc(
  socket: string,
  name: string,
  value: unknown,
  version: number,
  timeoutMs = 1500,
): Promise<number | "conflict" | undefined> {
  const reply = await rpc(socket, "doc.set", { name, value, version }, timeoutMs);
  if (!reply.ok) return reply.error === "conflict" ? "conflict" : undefined;
  const next = (reply.result as { version?: unknown } | null)?.version;
  return typeof next === "number" ? next : undefined;
}
