import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ansiCQuote,
  BASH_LABEL,
  commandHeader,
  commandTitle,
  exitCodeOf,
  HcBash,
  OutputTail,
  shellQuote,
  terminalEnv,
  waitsOnHc,
} from "./bash.ts";

const BASH = "/bin/bash";
const unix = process.platform !== "win32" && existsSync(BASH);

describe("terminalEnv", () => {
  it("keeps pi's environment but not the terminal's identity", () => {
    expect(
      terminalEnv({
        PATH: "/bin",
        PI_SESSION_ID: "s1",
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/s",
        HC_SCOPE: "x",
        HC_INSTALL_DIR: "/opt",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        COLORTERM: "truecolor",
        PWD: "/a",
        SHLVL: "2",
        EMPTY: undefined,
      }),
    ).toEqual({ PATH: "/bin", PI_SESSION_ID: "s1", HC_INSTALL_DIR: "/opt" });
  });
});

describe("waitsOnHc", () => {
  it.each([
    "hc wait --children all",
    "hc wait t7",
    "hc --json wait --children any",
    "hc run --bg --name x pi && hc wait x",
    "cd /repo; hc wait",
    "~/.local/bin/hc wait review",
    "(hc wait --children all)",
    "echo start\nhc wait --children any --timeout 600",
  ])("%s runs in pi's process", (command) => {
    expect(waitsOnHc(command)).toBe(true);
  });

  it.each([
    "hc run --bg --name x pi",
    "hc send --wait review 'go on'",
    "hc send t3 \"wait for it\"",
    "echo wait",
    "npm test -- --wait",
    "gh run watch && wait",
    "chc wait",
    "hc ls; sleep 1; wait",
  ])("%s runs in a terminal", (command) => {
    expect(waitsOnHc(command)).toBe(false);
  });
});

describe("commandTitle", () => {
  it("is the first line, with a mark when more follow", () => {
    expect(commandTitle("npm test")).toBe("npm test");
    expect(commandTitle("\n  cat > a.ts <<'EOF'\nx\nEOF\n")).toBe("cat > a.ts <<'EOF' …");
    expect(commandTitle("echo   a\t\tb")).toBe("echo a b");
  });

  it("is cut to fit and never carries control characters", () => {
    expect(commandTitle("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(commandTitle("printf '\x1b]2;evil\x07'")).toBe("printf ']2;evil'");
  });
});

describe("commandHeader", () => {
  it("sets the title and shows the command after a $", () => {
    const header = commandHeader("git status");
    expect(header.startsWith("\x1b]2;git status\x07")).toBe(true);
    expect(header).toContain("$");
    expect(header).toContain("git status");
    expect(header.endsWith("\n")).toBe(true);
  });

  it("shows at most maxLines lines of a long command", () => {
    const command = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const header = commandHeader(command, 3);
    expect(header).toContain("line 2");
    expect(header).not.toContain("line 3\x1b");
    expect(header).toContain("… 17 more lines");
  });
});

describe.skipIf(!unix)("quoting", () => {
  const roundTrip = (word: string) => execFileSync(BASH, ["-c", `printf '%s' ${word}`]).toString("utf8");

  it.each(["plain", "it's", "a b\tc", "$HOME `id` $(id) \\n \"q\"", "кириллица ✓", ""])("%j survives both", (text) => {
    expect(roundTrip(shellQuote(text))).toBe(text);
    expect(roundTrip(ansiCQuote(text))).toBe(text);
  });

  it("$'…' carries escape sequences and newlines", () => {
    const text = "\x1b]2;title\x07\x1b[1mbold\x1b[0m\nnext\\x41'";
    expect(roundTrip(ansiCQuote(text))).toBe(text);
  });
});

describe("exitCodeOf", () => {
  it("is the exit code, else 128 + the signal, else null", () => {
    expect(exitCodeOf({ exit_code: 3, signal: null })).toBe(3);
    expect(exitCodeOf({ exit_code: null, signal: 15 })).toBe(143);
    expect(exitCodeOf({})).toBeNull();
  });
});

describe("OutputTail", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-herdr-tail-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hands over what is appended, and the rest at stop", async () => {
    const path = join(dir, "out");
    writeFileSync(path, "");
    const chunks: string[] = [];
    const tail = new OutputTail(path, (b) => chunks.push(b.toString()), 10);
    tail.start();
    appendFileSync(path, "one\n");
    await vi.waitFor(() => expect(chunks.join("")).toBe("one\n"));
    appendFileSync(path, "two\n");
    await tail.stop();
    expect(chunks.join("")).toBe("one\ntwo\n");
    appendFileSync(path, "three\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(chunks.join("")).toBe("one\ntwo\n");
  });

  it("reads output larger than its buffer whole", async () => {
    const path = join(dir, "out");
    const big = "x".repeat(200_000);
    writeFileSync(path, big);
    const chunks: Buffer[] = [];
    const tail = new OutputTail(path, (b) => chunks.push(b), 10);
    await tail.stop();
    expect(Buffer.concat(chunks).toString()).toBe(big);
  });
});

/**
 * A stand-in herdr-core: runs `terminal.run` argv as a local process (no
 * PTY), answers wait / get / kill / rm the way the core does.
 */
class FakeCore {
  socket = "";
  requests: Array<{ method: string; params: any }> = [];
  terminals = new Map<string, { child: ChildProcess; exit?: { exit_code: number | null; signal: number | null } }>();
  /** Replace an answer: return undefined to fall through to the default. */
  override: ((method: string, params: any) => unknown) | undefined;
  private server: net.Server | undefined;
  private next = 1;

  constructor(private readonly dir: string) {}

  start(): Promise<void> {
    this.socket = join(this.dir, "core.sock");
    this.server = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", async (chunk) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const request = JSON.parse(buffer.slice(0, nl));
        this.requests.push({ method: request.method, params: request.params });
        try {
          const result = (await this.override?.(request.method, request.params)) ?? (await this.answer(request.method, request.params));
          if (result === "hang") return;
          conn.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        } catch (e: any) {
          conn.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: e.message, data: { kind: e.message } } })}\n`);
        }
      });
      conn.on("error", () => undefined);
    });
    return new Promise((resolve) => this.server!.listen(this.socket, () => resolve()));
  }

  stop(): void {
    for (const t of this.terminals.values()) if (!t.exit) killGroup(t.child, "SIGKILL");
    this.server?.close();
  }

  calls(method: string) {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }

  private exited(address: string): Promise<{ exit_code: number | null; signal: number | null }> {
    const t = this.terminals.get(address)!;
    if (t.exit) return Promise.resolve(t.exit);
    return new Promise((resolve) => t.child.once("exit", () => resolve(t.exit!)));
  }

  private async answer(method: string, params: any): Promise<unknown> {
    if (method === "terminal.run") {
      const address = `t${this.next++}`;
      const child = spawn(params.argv[0], params.argv.slice(1), {
        cwd: params.cwd,
        env: { ...process.env, ...params.env, HC_TERMINAL_ID: address },
        detached: true,
        stdio: "ignore",
      });
      const t: { child: ChildProcess; exit?: { exit_code: number | null; signal: number | null } } = { child };
      child.once("exit", (code, signal) => {
        t.exit = { exit_code: code, signal: signal ? 15 : null };
      });
      this.terminals.set(address, t);
      return { address, state: "live" };
    }
    const t = this.terminals.get(params.terminal);
    if (!t) throw new Error("not_found");
    if (method === "terminal.wait") {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), (params.timeout ?? 180) * 1000));
      const exit = await Promise.race([this.exited(params.terminal), timeout]);
      if (!exit) return { terminal: params.terminal, ended: false, reason: "timeout", children: [], turn: 0 };
      return { terminal: params.terminal, ended: true, reason: "exit", ...(exit as object), children: [], turn: 0 };
    }
    if (method === "terminal.get") {
      return { address: params.terminal, state: t.exit ? "finished" : "live", ...t.exit };
    }
    if (method === "terminal.kill") {
      if (!t.exit) killGroup(t.child, "SIGTERM");
      await this.exited(params.terminal);
      return { address: params.terminal, state: "finished", ...t.exit };
    }
    if (method === "terminal.rm") {
      if (!t.exit) throw new Error("live");
      this.terminals.delete(params.terminal);
      return { removed: params.terminal };
    }
    throw new Error("unknown_method");
  }
}

/**
 * Ends the process and everything under it. The script's `set -m` puts the
 * command in a process group of its own, so the group alone is not enough
 * without the PTY hangup herdr-core relies on.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const parents = new Map<number, number[]>();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="]).toString().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    parents.set(ppid, [...(parents.get(ppid) ?? []), pid]);
  }
  const tree: number[] = [];
  const walk = (pid: number) => {
    tree.push(pid);
    for (const kid of parents.get(pid) ?? []) walk(kid);
  };
  walk(child.pid!);
  for (const pid of tree) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** pi's own backend, recording that it was asked. */
function fakeLocal(): BashOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: async (command, _cwd, { onData }) => {
      calls.push(command);
      onData(Buffer.from("local\n"));
      return { exitCode: 0 };
    },
  };
}

describe.skipIf(!unix)("HcBash", () => {
  let dir: string;
  let core: FakeCore;
  let hc: HcBash;
  let local: ReturnType<typeof fakeLocal>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-herdr-bash-test-"));
    core = new FakeCore(dir);
    await core.start();
    hc = new HcBash({ socket: core.socket, terminal: "t0" }, { tmpDir: dir, pollMs: 10, waitSliceS: 5 });
    local = fakeLocal();
  });
  afterEach(() => {
    core.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const ops = (source: "tool" | "user" = "tool", commandPrefix?: string) =>
    hc.operations({ shell: BASH, local, source, commandPrefix });

  async function run(command: string, options: { signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv } = {}, o = ops()) {
    const chunks: Buffer[] = [];
    const result = await o.exec(command, dir, { onData: (b) => chunks.push(b), ...options });
    return { ...result, output: Buffer.concat(chunks).toString("utf8") };
  }

  const leftovers = () => readdirSync(dir).filter((f) => f.startsWith("pi-herdr-bash-"));

  it("runs the command in a terminal under pi and reports its exact output and exit code", async () => {
    const result = await run("echo out; echo err >&2; printf 'no newline'; exit 3");
    expect(result.exitCode).toBe(3);
    expect(result.output).toBe("out\nerr\nno newline");
    const [started] = core.calls("terminal.run");
    expect(started).toMatchObject({ cwd: dir, parent: "t0", caller: "t0", no_notify: true, labels: { [BASH_LABEL]: "tool" } });
    expect(started.argv[0]).toBe(BASH);
    expect(core.calls("terminal.rm")).toEqual([expect.objectContaining({ terminal: "t1" })]);
    expect(local.calls).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("hands the command over byte for byte", async () => {
    const result = await run("printf '%s|' 'it'\\''s' \"a\\\\b\" '  sp  '\ncat <<'EOF'\n  $HOME `x` \nEOF\n\n\n");
    expect(result.output).toBe("it's|a\\b|  sp  |  $HOME `x` \n");
  });

  it("keeps every byte of a large output", async () => {
    const result = await run("seq 1 20000");
    expect(result.exitCode).toBe(0);
    const lines = result.output.trimEnd().split("\n");
    expect(lines).toHaveLength(20000);
    expect(lines[0]).toBe("1");
    expect(lines.at(-1)).toBe("20000");
  });

  it("runs as pi's bash would: its environment, stdin from /dev/null, hc acting as pi", async () => {
    const result = await run('echo "$FOO|$HC_TERMINAL_ID"; cat; echo "stdin done"', { env: { ...process.env, FOO: "bar" } });
    expect(result.output).toBe("bar|t0\nstdin done\n");
  });

  it("marks `!` commands as the person's", async () => {
    await run("true", {}, ops("user"));
    expect(core.calls("terminal.run")[0].labels).toEqual({ [BASH_LABEL]: "user" });
  });

  it("leaves the shellCommandPrefix out of the header but runs it", async () => {
    const result = await run("shopt -s expand_aliases\necho hi", {}, ops("tool", "shopt -s expand_aliases"));
    expect(result.output).toBe("hi\n");
  });

  it("ends the terminal when pi aborts", async () => {
    const controller = new AbortController();
    const running = run("echo started; sleep 30", { signal: controller.signal });
    await vi.waitFor(() => expect(core.calls("terminal.run")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await expect(running).rejects.toThrow("aborted");
    expect(core.calls("terminal.kill")).toHaveLength(1);
    expect(core.calls("terminal.rm")).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  it("ends the terminal at the timeout", async () => {
    await expect(run("sleep 30", { timeout: 0.3 })).rejects.toThrow("timeout:0.3");
    expect(core.calls("terminal.kill")).toHaveLength(1);
  });

  it("runs `hc wait` in pi's process", async () => {
    const result = await run("hc wait --children all");
    expect(result.output).toBe("local\n");
    expect(local.calls).toEqual(["hc wait --children all"]);
    expect(core.calls("terminal.run")).toEqual([]);
  });

  it("runs the command in pi's process when herdr-core is not there", async () => {
    core.stop();
    const result = await run("echo hi");
    expect(result.output).toBe("local\n");
    expect(local.calls).toEqual(["echo hi"]);
    expect(leftovers()).toEqual([]);
  });

  it("runs the command in pi's process when herdr-core refuses the terminal", async () => {
    core.override = (method) => {
      if (method === "terminal.run") throw new Error("spawn_failed");
    };
    const result = await run("echo hi");
    expect(result.output).toBe("local\n");
  });

  it("follows a program that reports a status word until it exits", async () => {
    let first = true;
    core.override = (method, params) => {
      if (method === "terminal.wait" && first) {
        first = false;
        return { terminal: params.terminal, ended: true, reason: "status", status: "idle", children: [], turn: 1 };
      }
    };
    const result = await run("sleep 0.3; echo done; exit 4");
    expect(result).toMatchObject({ exitCode: 4, output: "done\n" });
    expect(core.calls("terminal.get").length).toBeGreaterThan(0);
  });

  it("reports no exit code when the terminal vanishes", async () => {
    core.override = (method) => {
      if (method === "terminal.wait") throw new Error("not_found");
    };
    const result = await run("echo hi");
    expect(result.exitCode).toBeNull();
  });

  it("refuses a working directory that doesn't exist", async () => {
    await expect(ops().exec("true", join(dir, "nope"), { onData: () => undefined })).rejects.toThrow("Working directory does not exist");
  });

  it("ends and removes running terminals at shutdown", async () => {
    const running = run("sleep 30").catch((e) => e);
    await vi.waitFor(() => expect(core.calls("terminal.run")).toHaveLength(1));
    await hc.shutdown();
    expect(core.calls("terminal.kill")).toHaveLength(1);
    expect(core.calls("terminal.rm").length).toBeGreaterThan(0);
    const result = await running;
    expect(result).toMatchObject({ exitCode: 143 });
  });
});
