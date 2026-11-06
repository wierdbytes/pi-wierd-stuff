/**
 * The smallest herdr-core client this needs: `terminal.label` over the
 * JSON-RPC socket herdr-core hands every terminal (`HC_TERMINAL_SOCKET`),
 * one request per connection. Talking to the socket directly instead of
 * spawning `hc label` keeps it cheap enough to run after every reply.
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

let nextId = 1;

/**
 * Sets (value) or removes (`""`) labels on the terminal. Resolves true once
 * herdr-core answered with a result, false on any error or after `timeoutMs`.
 * Never throws: a missing core must not disturb pi.
 */
export function setLabels(target: HcTarget, labels: Record<string, string>, timeoutMs = 1500): Promise<boolean> {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${target.socket}` : target.socket;
  const request = {
    jsonrpc: "2.0",
    id: nextId++,
    method: "terminal.label",
    params: { terminal: target.terminal, labels },
  };
  return new Promise((resolve) => {
    let done = false;
    let buffer = "";
    const socket = net.createConnection(endpoint);
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        finish(reply?.id === request.id && reply.result !== undefined && reply.error === undefined);
      } catch {
        finish(false);
      }
    });
  });
}
