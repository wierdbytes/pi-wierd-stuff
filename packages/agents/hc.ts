/**
 * A small herdr-core client: JSON-RPC over the socket herdr-core hands every
 * terminal (`HC_TERMINAL_SOCKET`). One connection per request, plus a
 * long-lived `events.subscribe` stream that reconnects on its own.
 */

import net from "node:net";

export interface HcEndpoint {
  /** herdr-core's socket path. */
  socket: string;
  /** The terminal this pi runs in (`t12`): the parent of every sub-agent it starts. */
  terminal: string;
}

/** The terminal pi runs in, when herdr-core started it. */
export function endpointFromEnv(env: NodeJS.ProcessEnv = process.env): HcEndpoint | undefined {
  const socket = env.HC_TERMINAL_SOCKET;
  const terminal = env.HC_TERMINAL_ID;
  if (!socket || !terminal) return undefined;
  return { socket, terminal };
}

export class HcError extends Error {
  constructor(
    message: string,
    readonly kind?: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "HcError";
  }
}

const endpointPath = (socket: string): string =>
  process.platform === "win32" ? `\\\\.\\pipe\\${socket}` : socket;

let nextId = 1;

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One request, one connection. Rejects with HcError on an RPC error, a timeout or a dead socket. */
export function hcCall<T = unknown>(
  socket: string,
  method: string,
  params: Record<string, unknown>,
  { timeoutMs = 15_000, signal }: CallOptions = {},
): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HcError("aborted", "aborted"));
      return;
    }
    let done = false;
    let buffer = "";
    const conn = net.createConnection(endpointPath(socket));
    const finish = (err: Error | undefined, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      conn.destroy();
      if (err) reject(err);
      else resolve(value as T);
    };
    const onAbort = () => finish(new HcError("aborted", "aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(new HcError(`herdr-core: ${method} timed out`, "timeout")), timeoutMs);
    timer.unref?.();
    conn.on("error", (e) => finish(new HcError(`herdr-core unreachable: ${e.message}`, "unreachable")));
    conn.on("end", () => finish(new HcError(`herdr-core closed the connection during ${method}`, "closed")));
    conn.on("connect", () => conn.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let reply: any;
        try {
          reply = JSON.parse(line);
        } catch {
          finish(new HcError("herdr-core sent invalid JSON", "parse"));
          return;
        }
        if (reply?.id !== id) continue;
        if (reply.error) {
          const data = reply.error.data ?? {};
          finish(new HcError(String(reply.error.message ?? "herdr-core error"), data.kind, data.hint));
        } else finish(undefined, reply.result as T);
        return;
      }
    });
  });
}

/** A terminal as herdr-core describes it (the fields this package reads). */
export interface HcTerminal {
  address: string;
  name?: string | null;
  parent?: string | null;
  state: "live" | "finished" | string;
  status?: { app?: string; state: string; msg?: string; kind?: string | null } | null;
  turn?: number;
  labels?: Record<string, string>;
  exit_code?: number | null;
  reason?: string | null;
  cwd?: string;
}

export interface HcEvent {
  type: string;
  terminal: string;
  seq?: number;
  data: any;
}

export interface SubscriptionHandlers {
  /** The matching terminals at (re)connect time. */
  snapshot(terminals: HcTerminal[]): void;
  event(event: HcEvent): void;
}

/**
 * `events.subscribe` that stays open: reconnects with backoff after the core
 * restarts or the socket drops, delivering a fresh snapshot each time.
 */
export class HcSubscription {
  private conn: net.Socket | undefined;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private backoff = 500;
  /** True between a snapshot and the next disconnect. */
  connected = false;

  constructor(
    private readonly socket: string,
    private readonly params: Record<string, unknown>,
    private readonly handlers: SubscriptionHandlers,
  ) {}

  start(): void {
    if (this.conn || this.stopped) return;
    const id = nextId++;
    let buffer = "";
    const conn = net.createConnection(endpointPath(this.socket));
    this.conn = conn;
    conn.on("connect", () =>
      conn.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "events.subscribe", params: this.params })}\n`),
    );
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          if (msg.id === id && msg.result) {
            this.connected = true;
            this.backoff = 500;
            this.handlers.snapshot((msg.result.terminals ?? []) as HcTerminal[]);
          } else if (msg.method === "event" && msg.params) {
            this.handlers.event(msg.params as HcEvent);
          } else if (msg.method === "missed" && msg.params) {
            // Fell behind: the core follows with a fresh snapshot.
            if (Array.isArray(msg.params.terminals)) this.handlers.snapshot(msg.params.terminals);
          }
        } catch {
          // A handler bug must not kill the stream.
        }
      }
    });
    const drop = () => {
      if (this.conn !== conn) return;
      this.conn = undefined;
      this.connected = false;
      conn.destroy();
      if (this.stopped) return;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.start();
      }, this.backoff);
      this.retry.unref?.();
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
    conn.on("error", drop);
    conn.on("close", drop);
    conn.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.conn?.destroy();
    this.conn = undefined;
    this.connected = false;
  }
}
