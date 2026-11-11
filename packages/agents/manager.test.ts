import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_TYPES } from "./agent-types.ts";
import { HcError, type SubscriptionHandlers } from "./hc.ts";
import { AgentManager, type SpawnSpec } from "./manager.ts";
import { type ChildState, readMeta, writeState } from "./runs.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

interface Call {
  method: string;
  params: Record<string, any>;
}

let dir: string;
let calls: Call[];
let handlers: SubscriptionHandlers | undefined;
let taken: Set<string>;
let next = 0;

function makeManager(pid = 4242) {
  calls = [];
  taken = new Set();
  const call = (async (_socket: string, method: string, params: Record<string, any>) => {
    calls.push({ method, params });
    if (method === "terminal.run") {
      if (taken.has(params.name)) throw new HcError("taken", "name_taken");
      taken.add(params.name);
      return { address: `t${++next}`, name: params.name, state: "live", parent: params.parent, labels: params.labels };
    }
    if (method === "terminal.read") return { text: "Error: boom" };
    return {};
  }) as any;
  return new AgentManager({
    endpoint: { socket: "/sock", terminal: "t0" },
    runsDir: dir,
    settings: DEFAULT_SETTINGS,
    depth: 0,
    env: { PATH: "/bin", HC_TERMINAL_ID: "t0" },
    pid,
    call,
    subscribe: (_p, h) => {
      handlers = h;
      return { start() {}, stop() {} };
    },
  });
}

const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
  prompt: "Do it",
  description: "Do it now",
  type: BUILTIN_TYPES[1]!,
  model: "anthropic/claude-sonnet-5-5",
  thinking: "low",
  cwd: "/tmp",
  background: true,
  notify: true,
  ...over,
});

const state = (runId: string, over: Partial<ChildState>): void =>
  writeState(dir, { v: 1, runId, pid: 1, seq: 0, running: false, updatedAt: Date.now(), ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-agents-"));
  handlers = undefined;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AgentManager.spawn", () => {
  it("starts pi as a child terminal with the run's env, labels and meta", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    const run = calls.find((c) => c.method === "terminal.run")!.params;
    expect(run.parent).toBe("t0");
    expect(run.caller).toBe("t0");
    expect(run.no_notify).toBe(true);
    expect(run.name).toBe("do-it-now");
    expect(run.argv).toEqual(expect.arrayContaining(["--tools", "read,bash,grep,find,ls", "--", "Do it"]));
    expect(run.env).toMatchObject({ PATH: "/bin", PI_AGENTS_RUN: rec.runId, PI_AGENTS_DEPTH: "1" });
    expect(run.env.HC_TERMINAL_ID).toBeUndefined();
    expect(run.labels).toMatchObject({ "pi-agents.run": rec.runId, "pi-agents.pid": "4242" });
    expect(readMeta(dir, rec.runId)).toMatchObject({ description: "Do it now", type: "Explore", parent: "t0" });
    expect(rec).toMatchObject({ id: "do-it-now", status: "running", live: true });
    m.dispose();
  });

  it("retries taken names", async () => {
    const m = makeManager();
    await m.spawn(spec());
    const second = await m.spawn(spec());
    expect(second.id).toBe("do-it-now-2");
    m.dispose();
  });
});

describe("AgentManager tracking", () => {
  it("completes when the child's run settles", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    const seen: string[] = [];
    m.onChange((r, prev) => prev !== r.status && seen.push(r.status));
    const waiting = m.wait(rec);
    state(rec.runId, { seq: 1, last: { status: "done", text: "42", at: 1 }, activity: { tools: 3, turns: 2, at: 5 } });
    handlers!.event({ type: "status", terminal: rec.address, data: { status: { state: "done" } } });
    expect(await waiting).toBe("settled");
    expect(rec).toMatchObject({ status: "completed", result: "42", hcStatus: "done" });
    expect(rec.activity?.tools).toBe(3);
    expect(seen).toEqual(["completed"]);
    m.dispose();
  });

  it("ignores the idle a fresh pi reports before its first run", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    state(rec.runId, { seq: 0, running: false });
    handlers!.event({ type: "status", terminal: rec.address, data: { status: { state: "idle" } } });
    expect(rec.status).toBe("running");
    m.dispose();
  });

  it("marks errors as failed", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    state(rec.runId, { seq: 1, last: { status: "error", text: "", error: "429", at: 1 } });
    m.reconcile(rec);
    expect(rec).toMatchObject({ status: "failed", error: "429" });
    m.dispose();
  });

  it("goes blocked and back", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    const waiting = m.wait(rec);
    handlers!.event({ type: "status", terminal: rec.address, data: { status: { state: "blocked", msg: "Allow?" } } });
    expect(await waiting).toBe("settled");
    expect(rec).toMatchObject({ status: "blocked", hcMessage: "Allow?" });
    await expect(m.steer(rec, "hi")).rejects.toThrow(/waiting for a person/);
    handlers!.event({ type: "status", terminal: rec.address, data: { status: { state: "working" } } });
    expect(rec.status).toBe("running");
    m.dispose();
  });

  it("fails with the screen tail when pi exits without a result", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    const waiting = m.wait(rec);
    handlers!.event({ type: "finished", terminal: rec.address, data: { exit_code: 1, reason: "exited" } });
    await waiting;
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/pi exited with code 1\. Last screen:\nError: boom/);
    expect(rec.live).toBe(false);
    expect(calls.some((c) => c.method === "terminal.rm")).toBe(true);
    m.dispose();
  });

  it("times out and aborts waits without touching the agent", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    expect(await m.wait(rec, { timeoutMs: 10 })).toBe("timeout");
    const ac = new AbortController();
    const w = m.wait(rec, { signal: ac.signal });
    ac.abort();
    expect(await w).toBe("aborted");
    expect(rec.status).toBe("running");
    m.dispose();
  });
});

describe("AgentManager.steer", () => {
  it("steers a running agent without changing its state", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    expect(await m.steer(rec, "focus on x")).toEqual({ mode: "steer" });
    expect(calls.at(-1)).toMatchObject({ method: "terminal.send", params: { terminal: rec.address, text: "focus on x" } });
    expect(rec.status).toBe("running");
    m.dispose();
  });

  it("turns a finished agent into a running one for the follow-up", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    state(rec.runId, { seq: 1, last: { status: "done", text: "first", at: 1 } });
    m.reconcile(rec);
    rec.consumed = true;
    expect(await m.steer(rec, "more")).toEqual({ mode: "follow-up" });
    expect(rec).toMatchObject({ status: "running", consumed: false, baseline: 1 });
    // The old result must not finish the follow-up.
    m.reconcile(rec);
    expect(rec.status).toBe("running");
    state(rec.runId, { seq: 2, last: { status: "done", text: "second", at: 2 } });
    m.reconcile(rec);
    expect(rec).toMatchObject({ status: "completed", result: "second" });
    m.dispose();
  });
});

describe("AgentManager.stop / adopt", () => {
  it("kills and removes", async () => {
    const m = makeManager();
    const rec = await m.spawn(spec());
    await m.stop(rec);
    expect(calls.map((c) => c.method)).toEqual(["terminal.run", "terminal.kill", "terminal.rm"]);
    expect(rec).toMatchObject({ status: "stopped", live: false });
    m.dispose();
  });

  it("adopts children this pi started before a reload", async () => {
    const first = makeManager(777);
    const rec = await first.spawn(spec());
    state(rec.runId, { seq: 1, last: { status: "done", text: "kept", at: 1 } });
    first.dispose();

    const second = makeManager(777);
    second.start();
    handlers!.snapshot([
      {
        address: rec.address,
        name: rec.id,
        state: "live",
        status: { state: "idle" },
        labels: { "pi-agents.run": rec.runId, "pi-agents.pid": "777" },
      },
      { address: "t99", name: "other", state: "live", labels: { "pi-agents.run": "x", "pi-agents.pid": "1" } },
    ]);
    const adopted = second.find(rec.id);
    expect(adopted).toMatchObject({ status: "completed", result: "kept", description: "Do it now", consumed: true });
    expect(second.find("t99")).toBeUndefined();
    second.dispose();
  });
});
