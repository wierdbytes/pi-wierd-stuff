import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSOLE_LOG_MAX_BYTES, installConsoleGuard, toastSummary } from "./console-guard.ts";

function fakeConsole() {
  const calls: Array<[string, unknown[]]> = [];
  const make = (name: string) => (...args: unknown[]) => {
    calls.push([name, args]);
  };
  const c = {
    log: make("log"),
    info: make("info"),
    debug: make("debug"),
    warn: make("warn"),
    error: make("error"),
    trace: make("trace"),
  } as unknown as Console;
  return { c, calls };
}

function fakeStderr() {
  const writes: unknown[] = [];
  const s = {
    write: (chunk: unknown) => {
      writes.push(chunk);
      return true;
    },
  };
  return { s, writes };
}

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "console-guard-"));
  logPath = join(dir, "sub", "console.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("installConsoleGuard", () => {
  it("diverts console output to the log while the TUI is active", () => {
    const { c, calls } = fakeConsole();
    const { s } = fakeStderr();
    installConsoleGuard({ isTuiActive: () => true, logPath }, { console: c, stderr: s });

    c.log("📊 Langfuse: Tracing enabled →", "https://lf.example");

    expect(calls).toEqual([]);
    const log = readFileSync(logPath, "utf8");
    expect(log).toMatch(/\[log\] 📊 Langfuse: Tracing enabled → https:\/\/lf\.example\n$/);
  });

  it("passes output through when the TUI is not active", () => {
    let active = false;
    const { c, calls } = fakeConsole();
    const { s, writes } = fakeStderr();
    installConsoleGuard({ isTuiActive: () => active, logPath }, { console: c, stderr: s });

    c.error("crash report");
    s.write("raw\n");
    expect(calls).toEqual([["error", ["crash report"]]]);
    expect(writes).toEqual(["raw\n"]);
    expect(existsSync(logPath)).toBe(false);

    active = true;
    c.error("hidden");
    expect(calls).toHaveLength(1);
  });

  it("fails open when isTuiActive throws", () => {
    const { c, calls } = fakeConsole();
    installConsoleGuard(
      {
        isTuiActive: () => {
          throw new Error("boom");
        },
        logPath,
      },
      { console: c, stderr: fakeStderr().s },
    );
    c.log("visible");
    expect(calls).toEqual([["log", ["visible"]]]);
  });

  it("toasts warn / error but not log / info / debug", () => {
    const { c } = fakeConsole();
    const onToast = vi.fn();
    installConsoleGuard({ isTuiActive: () => true, logPath, onToast }, { console: c, stderr: fakeStderr().s });

    c.log("a");
    c.info("b");
    c.debug("c");
    c.warn("careful %d", 3);
    c.error(new Error("bad"));

    expect(onToast).toHaveBeenCalledTimes(2);
    expect(onToast.mock.calls[0]).toEqual(["warning", "careful 3"]);
    expect(onToast.mock.calls[1][0]).toBe("error");
    expect(onToast.mock.calls[1][1]).toContain("Error: bad");
  });

  it("does not recurse when the toast sink logs", () => {
    const { c } = fakeConsole();
    const onToast = vi.fn(() => c.error("from sink"));
    installConsoleGuard({ isTuiActive: () => true, logPath, onToast }, { console: c, stderr: fakeStderr().s });

    c.error("first");

    expect(onToast).toHaveBeenCalledTimes(1);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("[error] first");
    expect(log).toContain("[error] from sink");
  });

  it("swallows a throwing toast sink", () => {
    const { c } = fakeConsole();
    installConsoleGuard(
      {
        isTuiActive: () => true,
        logPath,
        onToast: () => {
          throw new Error("sink");
        },
      },
      { console: c, stderr: fakeStderr().s },
    );
    expect(() => c.warn("x")).not.toThrow();
  });

  it("diverts stderr writes and still calls their callback", async () => {
    const { c } = fakeConsole();
    const { s, writes } = fakeStderr();
    installConsoleGuard({ isTuiActive: () => true, logPath }, { console: c, stderr: s });

    const cb = vi.fn();
    expect(s.write(Buffer.from("(node:1) Warning: x\n"), cb)).toBe(true);
    await Promise.resolve();

    expect(writes).toEqual([]);
    expect(cb).toHaveBeenCalledWith(null);
    expect(readFileSync(logPath, "utf8")).toContain("[stderr] (node:1) Warning: x\n");
  });

  it("is idempotent and the disposer restores the originals", () => {
    const { c, calls } = fakeConsole();
    const { s, writes } = fakeStderr();
    const originalLog = c.log;
    const originalWrite = s.write;

    const disposeA = installConsoleGuard({ isTuiActive: () => true, logPath }, { console: c, stderr: s });
    const patchedLog = c.log;
    const disposeB = installConsoleGuard({ isTuiActive: () => false, logPath }, { console: c, stderr: s });
    expect(c.log).toBe(patchedLog);

    // B owns the options now: output passes through.
    c.log("through");
    expect(calls).toEqual([["log", ["through"]]]);

    // A's disposer is stale and must not tear B down.
    disposeA();
    expect(c.log).toBe(patchedLog);

    disposeB();
    expect(c.log).toBe(originalLog);
    expect(s.write).toBe(originalWrite);
    s.write("after");
    expect(writes).toEqual(["after"]);
  });

  it("rotates an oversized log on install", () => {
    const flat = join(dir, "console.log");
    writeFileSync(flat, "x".repeat(CONSOLE_LOG_MAX_BYTES + 1));
    installConsoleGuard({ isTuiActive: () => true, logPath: flat }, { console: fakeConsole().c, stderr: fakeStderr().s });
    expect(existsSync(`${flat}.1`)).toBe(true);
    expect(existsSync(flat)).toBe(false);
  });
});

describe("toastSummary", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(toastSummary("\n  Error: bad\n    at foo\n")).toBe("Error: bad");
  });

  it("truncates long lines", () => {
    expect(toastSummary("a".repeat(10), 5)).toBe("aaaa…");
  });
});
