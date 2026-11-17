import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.spyOn can't patch the ESM `node:child_process` namespace: mock the module
// and let each test see what runSubAgent spawned.
const spawned = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; opts: any }>,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], opts?: any) => {
      spawned.calls.push({ command, args: [...args], opts });
      const proc = new EventEmitter() as ChildProcess;
      (proc as any).stdout = new Readable({ read() {} });
      (proc as any).stderr = new Readable({ read() {} });
      (proc as any).kill = () => true;
      setImmediate(() => {
        const end = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "summary" }] } };
        (proc as any).stdout.push(`${JSON.stringify(end)}\n`);
        (proc as any).stdout.push(null);
        proc.emit("close", 0);
      });
      return proc;
    },
  };
});

import { nestedPiEnv, runSubAgent } from "./subagent.ts";

describe("nestedPiEnv", () => {
  it("drops pi-agents' run variables and keeps the rest", () => {
    const env = {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "k",
      PI_CODING_AGENT_DIR: "/agent",
      HC_TERMINAL_ID: "t1",
      HC_TERMINAL_SOCKET: "/s",
      PI_AGENTS_RUN: "r",
      PI_AGENTS_DIR: "/runs",
      PI_AGENTS_DEPTH: "1",
      PI_AGENTS_TRUST: "yes",
    };
    expect(nestedPiEnv(env)).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "k",
      PI_CODING_AGENT_DIR: "/agent",
      HC_TERMINAL_ID: "t1",
      HC_TERMINAL_SOCKET: "/s",
    });
    // The caller's environment stays as it was.
    expect(env.PI_AGENTS_RUN).toBe("r");
  });
});

describe("runSubAgent", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    spawned.calls = [];
  });

  it("starts the nested pi without PI_AGENTS_* when it runs inside a sub-agent", async () => {
    process.env.PI_AGENTS_RUN = "run-1";
    process.env.PI_AGENTS_DIR = "/runs";
    process.env.PI_AGENTS_DEPTH = "1";

    const result = await runSubAgent("page", "what is it?", "anthropic/claude-haiku-4-5", "low");

    expect(result).toEqual({ ok: true, response: "summary" });
    const call = spawned.calls.at(-1)!;
    expect(call.command).toBe("pi");
    expect(call.args).not.toContain("--no-extensions");
    expect(call.opts.env.PATH).toBe(process.env.PATH);
    expect(Object.keys(call.opts.env).filter((k) => k.startsWith("PI_AGENTS_"))).toEqual([]);
  });
});
