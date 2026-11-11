/**
 * Parent side: starts sub-agents as child terminals of this pi's terminal,
 * follows them (herdr-core events + the child's run file) and answers
 * wait / steer / stop. One manager per pi process.
 */

import { type FSWatcher, watch } from "node:fs";
import type { AgentType } from "./agent-types.ts";
import {
  HcError,
  type HcEndpoint,
  type HcEvent,
  HcSubscription,
  type HcTerminal,
  hcCall,
  type SubscriptionHandlers,
} from "./hc.ts";
import { buildArgv, ENV, inheritedEnv, nameCandidate, slugName } from "./launch.ts";
import {
  type ChildActivity,
  ensureDir,
  newRunId,
  readMeta,
  readState,
  runIdOfStateFile,
  writeMeta,
} from "./runs.ts";
import type { AgentsSettings } from "./settings.ts";

export type AgentStatus = "running" | "blocked" | "completed" | "failed" | "stopped";

export const isActive = (s: AgentStatus): boolean => s === "running";
export const isFinal = (s: AgentStatus): boolean => s === "completed" || s === "failed" || s === "stopped";

export interface AgentSnapshot {
  /** The hc terminal name: what tools and herdr call it. */
  id: string;
  /** The hc address (`t8c`). */
  address: string;
  runId: string;
  description: string;
  type: string;
  model?: string;
  thinking?: string;
  cwd: string;
  status: AgentStatus;
  background: boolean;
  /** When the current piece of work was handed over. */
  startedAt: number;
  endedAt?: number;
  result?: string;
  error?: string;
  activity?: ChildActivity;
  /** The child's own status word and message, as herdr shows them. */
  hcStatus?: string;
  hcMessage?: string;
  sessionId?: string;
  /** The terminal is still there. */
  live: boolean;
}

export interface AgentRecord extends AgentSnapshot {
  /** Tell the parent's model when this settles. */
  notify: boolean;
  /** Its latest result was already handed to the model. */
  consumed: boolean;
  /** The child's settled-run count when the current work was handed over. */
  baseline: number;
}

export const snapshot = (r: AgentRecord): AgentSnapshot => ({
  id: r.id,
  address: r.address,
  runId: r.runId,
  description: r.description,
  type: r.type,
  model: r.model,
  thinking: r.thinking,
  cwd: r.cwd,
  status: r.status,
  background: r.background,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  result: r.result,
  error: r.error,
  activity: r.activity ? { ...r.activity } : undefined,
  hcStatus: r.hcStatus,
  hcMessage: r.hcMessage,
  sessionId: r.sessionId,
  live: r.live,
});

export interface SpawnSpec {
  prompt: string;
  description: string;
  type: AgentType;
  /** `provider/id`. */
  model?: string;
  thinking?: string;
  cwd: string;
  background: boolean;
  /** Tell the model when it settles (background tool runs). */
  notify: boolean;
  /** The parent's project trust, inherited by the child. */
  trust?: "yes" | "no";
}

export type WaitOutcome = "settled" | "timeout" | "aborted";

export type ChangeListener = (rec: AgentRecord, previous: AgentStatus | undefined) => void;

export interface ManagerDeps {
  endpoint: HcEndpoint;
  runsDir: string;
  settings: AgentsSettings;
  /** This pi's own depth: 0 at the top. */
  depth: number;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  /** For tests: the herdr-core call. */
  call?: typeof hcCall;
  /** For tests: the event stream. */
  subscribe?: (params: Record<string, unknown>, handlers: SubscriptionHandlers) => { start(): void; stop(): void };
}

const LABEL_RUN = "pi-agents.run";
const LABEL_PID = "pi-agents.pid";
const LABEL_TYPE = "pi-agents.type";

export class AgentManager {
  private readonly byId = new Map<string, AgentRecord>();
  private readonly byAddress = new Map<string, AgentRecord>();
  private readonly byRun = new Map<string, AgentRecord>();
  private readonly waiters = new Map<AgentRecord, Set<() => void>>();
  private readonly listeners = new Set<ChangeListener>();
  private subscription: { start(): void; stop(): void } | undefined;
  private watcher: FSWatcher | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private readonly call: typeof hcCall;
  private readonly pid: number;

  constructor(private readonly deps: ManagerDeps) {
    this.call = deps.call ?? hcCall;
    this.pid = deps.pid ?? process.pid;
  }

  // ─────────────────────────────────────────────────────────── lifecycle ──

  /** Follow this terminal's children; adopts sub-agents a previous load of this pi started. */
  start(): void {
    if (this.subscription) return;
    const params = { children_of: this.deps.endpoint.terminal };
    const handlers: SubscriptionHandlers = { snapshot: (ts) => this.onSnapshot(ts), event: (e) => this.onEvent(e) };
    this.subscription = this.deps.subscribe
      ? this.deps.subscribe(params, handlers)
      : new HcSubscription(this.deps.endpoint.socket, params, handlers);
    this.subscription.start();
    try {
      ensureDir(this.deps.runsDir);
      this.watcher = watch(this.deps.runsDir, (_evt, file) => {
        const runId = file ? runIdOfStateFile(String(file)) : undefined;
        const rec = runId ? this.byRun.get(runId) : undefined;
        if (rec) this.reconcile(rec);
      });
      this.watcher.unref?.();
    } catch {
      // The poll below still notices.
    }
    this.poll = setInterval(() => {
      for (const rec of this.byId.values()) if (rec.live && !isFinal(rec.status)) this.reconcile(rec);
    }, 2000);
    this.poll.unref?.();
  }

  dispose(): void {
    this.subscription?.stop();
    this.subscription = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    for (const set of this.waiters.values()) for (const wake of set) wake();
    this.waiters.clear();
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─────────────────────────────────────────────────────────── queries ──

  list(): AgentRecord[] {
    return [...this.byId.values()];
  }

  /** By name, address or run id. */
  find(ref: string): AgentRecord | undefined {
    const r = ref.trim();
    return this.byId.get(r) ?? this.byAddress.get(r) ?? this.byRun.get(r);
  }

  // ─────────────────────────────────────────────────────────── actions ──

  async spawn(spec: SpawnSpec): Promise<AgentRecord> {
    const { endpoint, runsDir, settings } = this.deps;
    const runId = newRunId();
    const depth = this.deps.depth + 1;
    writeMeta(runsDir, {
      v: 1,
      runId,
      description: spec.description,
      type: spec.type.name,
      typePrompt: spec.type.prompt,
      parent: endpoint.terminal,
      parentPid: this.pid,
      depth,
      cwd: spec.cwd,
      model: spec.model,
      thinking: spec.thinking,
      createdAt: Date.now(),
    });
    const argv = buildArgv(settings, {
      model: spec.model,
      thinking: spec.thinking,
      tools: spec.type.tools,
      excludeTools: spec.type.excludeTools,
      sessionName: spec.description,
      prompt: spec.prompt,
    });
    const env: Record<string, string> = {
      ...(settings.inheritEnv ? inheritedEnv(this.deps.env ?? process.env) : {}),
      [ENV.RUN]: runId,
      [ENV.DIR]: runsDir,
      [ENV.DEPTH]: String(depth),
    };
    if (spec.trust) env[ENV.TRUST] = spec.trust;

    this.start();
    const base = slugName(spec.description);
    let created: HcTerminal | undefined;
    for (let attempt = 1; attempt <= 30 && !created; attempt++) {
      try {
        created = await this.call<HcTerminal>(endpoint.socket, "terminal.run", {
          argv,
          cwd: spec.cwd,
          env,
          labels: { [LABEL_RUN]: runId, [LABEL_PID]: String(this.pid), [LABEL_TYPE]: spec.type.name },
          name: nameCandidate(base, attempt),
          caller: endpoint.terminal,
          parent: endpoint.terminal,
          no_notify: true,
        });
      } catch (e) {
        if (e instanceof HcError && e.kind === "name_taken") continue;
        throw e;
      }
    }
    if (!created) throw new Error(`no free terminal name for "${base}"`);

    const rec: AgentRecord = {
      id: created.name ?? created.address,
      address: created.address,
      runId,
      description: spec.description,
      type: spec.type.name,
      model: spec.model,
      thinking: spec.thinking,
      cwd: spec.cwd,
      status: "running",
      background: spec.background,
      startedAt: Date.now(),
      live: created.state !== "finished",
      notify: spec.notify,
      consumed: false,
      baseline: 0,
    };
    this.add(rec);
    this.emit(rec, undefined);
    return rec;
  }

  /**
   * Resolves once the record leaves `running` (completed, failed, stopped,
   * or blocked on a person), at `timeoutMs`, or when `signal` aborts.
   */
  wait(rec: AgentRecord, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WaitOutcome> {
    if (!isActive(rec.status)) return Promise.resolve("settled");
    if (opts.signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const set = this.waiters.get(rec) ?? new Set();
      this.waiters.set(rec, set);
      const done = (outcome: WaitOutcome) => {
        set.delete(wake);
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const wake = () => done("settled");
      const onAbort = () => done("aborted");
      set.add(wake);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) timer = setTimeout(() => done("timeout"), opts.timeoutMs);
    });
  }

  /**
   * Types `message` into the sub-agent. While it works, pi takes it as a
   * steer; once it has finished, it starts a new turn and the record runs again.
   */
  async steer(rec: AgentRecord, message: string): Promise<{ mode: "steer" | "follow-up" }> {
    if (!rec.live) throw new Error(`${rec.id}'s terminal has ended; start a new agent instead`);
    if (rec.status === "stopped") throw new Error(`${rec.id} was stopped`);
    if (rec.status === "blocked") {
      throw new Error(
        `${rec.id} is waiting for a person${rec.hcMessage ? ` (${rec.hcMessage})` : ""}; ask the user to answer it in herdr`,
      );
    }
    const mode = rec.status === "running" ? "steer" : "follow-up";
    // Running again before the send returns (hc waits for a quiet moment):
    // a wait issued alongside this steer must wait for the new turn.
    const before = { status: rec.status, baseline: rec.baseline, error: rec.error, endedAt: rec.endedAt, startedAt: rec.startedAt, consumed: rec.consumed };
    if (mode === "follow-up") {
      rec.baseline = readState(this.deps.runsDir, rec.runId)?.seq ?? rec.baseline;
      rec.error = undefined;
      rec.endedAt = undefined;
      rec.startedAt = Date.now();
      rec.consumed = false;
      this.setStatus(rec, "running");
    }
    try {
      await this.call(
        this.deps.endpoint.socket,
        "terminal.send",
        { terminal: rec.address, text: message, caller: this.deps.endpoint.terminal },
        { timeoutMs: 90_000 },
      );
    } catch (e) {
      if (mode === "follow-up" && rec.status === "running") {
        Object.assign(rec, { ...before, status: rec.status });
        this.setStatus(rec, before.status);
      }
      throw e;
    }
    // A very fast turn may already have settled.
    if (mode === "follow-up") this.reconcile(rec);
    return { mode };
  }

  /** Ends the sub-agent's pi and removes its terminal. */
  async stop(rec: AgentRecord): Promise<void> {
    const { socket } = this.deps.endpoint;
    if (rec.live) {
      try {
        await this.call(socket, "terminal.kill", { terminal: rec.address, caller: this.deps.endpoint.terminal }, { timeoutMs: 10_000 });
      } catch (e) {
        if (!(e instanceof HcError && e.kind === "not_found")) throw e;
      }
    }
    rec.live = false;
    if (!isFinal(rec.status)) {
      rec.error = rec.error ?? "stopped";
      this.setStatus(rec, "stopped");
    }
    await this.call(socket, "terminal.rm", { terminal: rec.address }, { timeoutMs: 5000 }).catch(() => undefined);
  }

  /** On quit: end every live sub-agent (herdr would only end them with the terminal). */
  async stopAll(timeoutMs = 2000): Promise<void> {
    const live = this.list().filter((r) => r.live);
    await Promise.all(
      live.map((r) =>
        this.call(this.deps.endpoint.socket, "terminal.kill", { terminal: r.address }, { timeoutMs }).catch(() => undefined),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────── internals ──

  private add(rec: AgentRecord): void {
    this.byId.set(rec.id, rec);
    this.byAddress.set(rec.address, rec);
    this.byRun.set(rec.runId, rec);
  }

  private emit(rec: AgentRecord, previous: AgentStatus | undefined): void {
    for (const l of this.listeners) {
      try {
        l(rec, previous);
      } catch {
        // A listener bug must not break tracking.
      }
    }
  }

  private setStatus(rec: AgentRecord, status: AgentStatus): void {
    const previous = rec.status;
    if (previous === status) return;
    rec.status = status;
    if (isFinal(status)) rec.endedAt = Date.now();
    if (!isActive(status)) {
      const set = this.waiters.get(rec);
      if (set) for (const wake of [...set]) wake();
    }
    this.emit(rec, previous);
  }

  /** Reads the child's run file and moves the record on when a run settled. */
  reconcile(rec: AgentRecord): void {
    const st = readState(this.deps.runsDir, rec.runId);
    let changed = false;
    if (st) {
      if (st.activity && st.activity.at !== rec.activity?.at) {
        rec.activity = st.activity;
        changed = true;
      }
      if (st.sessionId && st.sessionId !== rec.sessionId) rec.sessionId = st.sessionId;
      if (st.seq > rec.baseline) {
        rec.baseline = st.seq;
        const last = st.last;
        rec.result = last?.text ?? rec.result;
        rec.error =
          last?.status === "error" ? (last.error ?? "error") : last?.status === "aborted" ? "interrupted" : undefined;
        if (!isFinal(rec.status)) {
          this.setStatus(rec, last?.status === "error" ? "failed" : "completed");
          return;
        }
        // Someone kept working with it in herdr: keep its latest answer.
        changed = true;
      }
    }
    if (changed) this.emit(rec, rec.status);
  }

  private onSnapshot(terminals: HcTerminal[]): void {
    const seen = new Set<string>();
    for (const t of terminals) {
      seen.add(t.address);
      const rec = this.byAddress.get(t.address) ?? this.adopt(t);
      if (!rec) continue;
      this.applyStatus(rec, t.status ?? null);
      if (t.state === "finished") this.onFinished(rec, { exit_code: t.exit_code, reason: t.reason });
      else this.reconcile(rec);
    }
    // Gone while we weren't listening.
    for (const rec of this.byId.values()) {
      if (rec.live && !seen.has(rec.address)) this.onFinished(rec, { reason: "removed" });
    }
  }

  private onEvent(e: HcEvent): void {
    const rec = this.byAddress.get(e.terminal);
    if (!rec) return;
    switch (e.type) {
      case "status":
        this.applyStatus(rec, e.data?.status ?? null);
        break;
      case "finished":
        this.onFinished(rec, e.data ?? {});
        break;
      case "removed":
        this.onFinished(rec, { reason: "removed" });
        break;
      default:
        break;
    }
  }

  private applyStatus(rec: AgentRecord, status: HcTerminal["status"]): void {
    const word = status?.state;
    const msg = status?.msg || undefined;
    const changed = word !== rec.hcStatus || msg !== rec.hcMessage;
    rec.hcStatus = word;
    rec.hcMessage = msg;
    if (word === "blocked" && rec.status === "running") {
      this.setStatus(rec, "blocked");
      return;
    }
    if (word === "working" && rec.status === "blocked") {
      this.setStatus(rec, "running");
      return;
    }
    // done / idle / error: the run file says how it ended (if it isn't there yet, fs.watch or the poll will see it).
    if (word && word !== "working" && word !== "blocked") this.reconcile(rec);
    if (changed) this.emit(rec, rec.status);
  }

  private onFinished(rec: AgentRecord, info: { exit_code?: number | null; reason?: string | null }): void {
    if (!rec.live) return;
    rec.live = false;
    // A run may have settled just before the exit.
    this.reconcile(rec);
    if (isFinal(rec.status)) {
      this.emit(rec, rec.status);
      return;
    }
    const how = info.reason === "removed" ? "its terminal was removed" : `pi exited${info.exit_code != null ? ` with code ${info.exit_code}` : ""}${info.reason && info.reason !== "exited" ? ` (${info.reason})` : ""}`;
    const { socket } = this.deps.endpoint;
    void this.call<{ text?: string }>(socket, "terminal.read", { terminal: rec.address, lines: 40 }, { timeoutMs: 3000 })
      .then((r) => r?.text?.trim())
      .catch(() => undefined)
      .then((tail) => {
        rec.error = tail ? `${how}. Last screen:\n${tail}` : how;
        this.setStatus(rec, "failed");
        void this.call(socket, "terminal.rm", { terminal: rec.address }, { timeoutMs: 3000 }).catch(() => undefined);
      });
  }

  /** A child this pi process started before a /reload. */
  private adopt(t: HcTerminal): AgentRecord | undefined {
    const runId = t.labels?.[LABEL_RUN];
    if (!runId || t.labels?.[LABEL_PID] !== String(this.pid) || t.state !== "live") return undefined;
    const meta = readMeta(this.deps.runsDir, runId);
    const st = readState(this.deps.runsDir, runId);
    const working = t.status?.state === "working" || st?.running === true;
    const rec: AgentRecord = {
      id: t.name ?? t.address,
      address: t.address,
      runId,
      description: meta?.description ?? t.name ?? t.address,
      type: meta?.type ?? t.labels?.[LABEL_TYPE] ?? "general-purpose",
      model: meta?.model,
      thinking: meta?.thinking,
      cwd: meta?.cwd ?? t.cwd ?? "",
      status: t.status?.state === "blocked" ? "blocked" : working ? "running" : "completed",
      background: true,
      startedAt: meta?.createdAt ?? Date.now(),
      endedAt: working ? undefined : Date.now(),
      result: st?.last?.text,
      error: st?.last?.status === "error" ? st.last.error : undefined,
      activity: st?.activity,
      sessionId: st?.sessionId,
      live: true,
      notify: true,
      consumed: !working,
      baseline: st?.seq ?? 0,
    };
    this.add(rec);
    this.emit(rec, undefined);
    return rec;
  }
}
