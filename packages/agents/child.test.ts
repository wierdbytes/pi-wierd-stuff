import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childFromEnv, lastAssistant, subagentSection, takeChildEnv, toolDetail } from "./child.ts";

const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role: "assistant", content, ...extra },
});

describe("lastAssistant", () => {
  it("joins the text blocks of the last assistant message", () => {
    const entries = [
      assistant([{ type: "text", text: "old" }]),
      { type: "message", message: { role: "user", content: "next" } },
      assistant([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Found it." },
        { type: "toolCall", name: "read" },
        { type: "text", text: "src/x.ts:12" },
      ]),
      { type: "custom", customType: "x" },
    ];
    expect(lastAssistant(entries)).toEqual({ text: "Found it.\nsrc/x.ts:12", status: "done" });
  });

  it("reports errors and aborts", () => {
    expect(lastAssistant([assistant([], { stopReason: "error", errorMessage: "429" })])).toEqual({
      text: "",
      status: "error",
      error: "429",
    });
    expect(lastAssistant([assistant([{ type: "text", text: "half" }], { stopReason: "aborted" })])?.status).toBe("aborted");
  });

  it("is undefined before any reply", () => {
    expect(lastAssistant([])).toBeUndefined();
  });
});

describe("toolDetail", () => {
  it("picks the telling argument", () => {
    expect(toolDetail({ path: "src/a.ts", offset: 1 })).toBe("src/a.ts");
    expect(toolDetail({ command: "ls -la\necho x" })).toBe("ls -la");
    expect(toolDetail({ n: 1 })).toBeUndefined();
  });
});

describe("subagentSection", () => {
  it("names the parent and appends the type's instructions", () => {
    const s = subagentSection({
      v: 1,
      runId: "r",
      description: "Find auth",
      type: "Explore",
      typePrompt: "READ-ONLY",
      parent: "t12",
      parentPid: 1,
      depth: 1,
      cwd: "/",
      createdAt: 0,
    });
    expect(s).toContain('("Find auth", type Explore)');
    expect(s).toContain("terminal t12");
    expect(s.endsWith("READ-ONLY")).toBe(true);
  });
});

describe("childFromEnv", () => {
  it("reads the run, depth and the parent's trust", () => {
    const env = { PI_AGENTS_RUN: "r", PI_AGENTS_DIR: "/nonexistent", PI_AGENTS_DEPTH: "2", PI_AGENTS_TRUST: "no" };
    expect(childFromEnv(env)).toEqual({ runId: "r", dir: "/nonexistent", depth: 2, trust: "no", meta: undefined });
    expect(childFromEnv({ ...env, PI_AGENTS_TRUST: "maybe" })?.trust).toBeUndefined();
    expect(childFromEnv({ PI_AGENTS_DIR: "/x" })).toBeUndefined();
  });
});

describe("takeChildEnv", () => {
  it("takes PI_AGENTS_* out of the environment and leaves the rest", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", HC_TERMINAL_ID: "t1", PI_AGENTS_RUN: "r", PI_AGENTS_DIR: "/runs" };
    expect(takeChildEnv(env, {})).toEqual({ PI_AGENTS_RUN: "r", PI_AGENTS_DIR: "/runs" });
    expect(env).toEqual({ PATH: "/bin", HC_TERMINAL_ID: "t1" });
  });

  it("gives the same answer to the next load of the extension in this process", () => {
    const holder = {};
    const env: NodeJS.ProcessEnv = { PI_AGENTS_RUN: "r", PI_AGENTS_DIR: "/runs" };
    const first = takeChildEnv(env, holder);
    expect(takeChildEnv(env, holder)).toEqual(first);
  });

  it("is empty in a pi that isn't a sub-agent", () => {
    const holder = {};
    expect(takeChildEnv({ PATH: "/bin" }, holder)).toEqual({});
    expect(takeChildEnv({ PATH: "/bin" }, holder)).toEqual({});
  });
});

describe("the extension in a sub-agent", () => {
  const saved = { ...process.env };
  let dir: string | undefined;
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("@wierdbytes/pi-agents/child-env")];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("clears PI_AGENTS_* from process.env and is still the sub-agent after /reload", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-agents-child-"));
    // No settings file there: maxDepth 1, so a sub-agent stops after the child side.
    process.env.PI_CODING_AGENT_DIR = dir;
    Object.assign(process.env, { PI_AGENTS_RUN: "run-1", PI_AGENTS_DIR: dir, PI_AGENTS_DEPTH: "1", PI_AGENTS_TRUST: "yes" });
    const { default: piAgents } = await import("./index.ts");
    const load = () => {
      const events: string[] = [];
      piAgents({ on: (event: string) => events.push(event) } as never);
      return events;
    };

    const first = load();
    expect(first).toEqual(expect.arrayContaining(["agent_settled", "before_agent_start", "project_trust"]));
    // What this pi starts (a `pi -p` summarizer, a bash command) no longer passes for the sub-agent.
    expect(Object.keys(process.env).filter((k) => k.startsWith("PI_AGENTS_"))).toEqual([]);
    // pi loads extensions anew on /reload, /new, /resume: the child side comes back the same.
    expect(load()).toEqual(first);
  });
});
