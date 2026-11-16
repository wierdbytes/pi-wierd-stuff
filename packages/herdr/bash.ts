/**
 * pi's bash, run through herdr-core: every command gets a terminal of its own
 * (`terminal.run`, what `hc run` does), a child of pi's, so any herdr client
 * shows it under pi while it runs: the command as the terminal's title, its
 * command line and output on the screen. The terminal is removed once the
 * command ends.
 *
 * The command runs as with pi's own bash: stdin is /dev/null, stdout and
 * stderr are one pipe, here into `tee`, which prints to the terminal and to a
 * file pi reads. So pi gets the exact output, byte for byte, however much of
 * it there is, and the exit code the command ended with; nothing ever waits
 * on a pager or a prompt.
 *
 * Commands that call `hc wait` run in pi's own process as before: in a
 * terminal of their own they would count among the children they wait for.
 * So does every command herdr-core can't start a terminal for.
 */

import { constants } from "node:fs";
import { access, type FileHandle, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type HcTarget, rpc } from "./hc.ts";

/** Who ran the command: the model's bash tool or the person's `!` / `!!`. */
export type BashSource = "tool" | "user";

/** The label marking a terminal as one of pi's bash commands; its value is the {@link BashSource}. */
export const BASH_LABEL = "pi-herdr.bash";

/** Variables herdr-core sets for every terminal itself: its identity, not pi's. */
const OWN_ENV = new Set([
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "HC_TERMINAL_ID",
  "HC_TERMINAL_SOCKET",
  "HC_SCOPE",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
]);

/** The command's environment for `terminal.run`: what pi would give it, minus the terminal's own identity. */
export function terminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && !OWN_ENV.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Whether the command calls `hc wait` (`hc wait --children all`, `hc --json
 * wait t7`). Run in a terminal under pi, it would wait for itself.
 */
export function waitsOnHc(command: string): boolean {
  return /(?:^|[\s;&|({`/])hc(?:[ \t]+[^\s;&|()]+)*?[ \t]+wait(?=$|[\s;&|)])/m.test(command);
}

/** Printable text for one line of the header or the title: no control characters. */
const printable = (line: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  line.replace(/\t/g, "  ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");

/** The command's first line, for the terminal's title: `npm test`, `cat > a.ts <<'EOF' …`. */
export function commandTitle(command: string, max = 80): string {
  const lines = command.split(/\r?\n/).map((l) => printable(l).trim()).filter(Boolean);
  let title = (lines[0] ?? "").replace(/\s+/g, " ");
  const more = lines.length > 1;
  if (title.length > max) title = `${title.slice(0, max - 1)}…`;
  else if (more) title = `${title} …`;
  return title;
}

const RESET = "\x1b[0m";
/** Tokyo Night blue, bold: the prompt. */
const PROMPT = "\x1b[1;38;2;122;162;247m";
const BOLD = "\x1b[1m";
/** Tokyo Night comment. */
const DIM = "\x1b[38;2;86;95;137m";

/**
 * What the terminal shows before the output: its title (OSC 2) and the
 * command after a `$`, at most `maxLines` lines of it.
 */
export function commandHeader(command: string, maxLines = 12, maxWidth = 400): string {
  const lines = command
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => {
      const text = printable(l);
      return text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text;
    });
  const shown = lines.slice(0, maxLines).map((line, i) => (i === 0 ? `${PROMPT}$${RESET} ${BOLD}${line}${RESET}` : `  ${BOLD}${line}${RESET}`));
  if (lines.length > maxLines) shown.push(`  ${DIM}… ${lines.length - maxLines} more lines${RESET}`);
  return `\x1b]2;${commandTitle(command)}\x07${shown.join("\n")}\n`;
}

/** `'…'` for bash: any text as one word. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** `$'…'` for bash: any text, escape sequences included, as one word. */
export const ansiCQuote = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the point
  `$'${s.replace(/[\\']/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}'`;

export interface WrapperFiles {
  /** The command, exactly as pi got it. */
  command: string;
  /** Where its output goes, for pi to read. */
  output: string;
}

/** The script the terminal runs (`bash <script>`): the header, then the command through `tee`. */
export function wrapperScript(o: { shell: string; files: WrapperFiles; parent: string; header: string }): string {
  return [
    "# pi-herdr: one command of pi's bash. Its output goes to this terminal and to the file pi reads.",
    // The command gets a process group of its own, in front: herdr names the
    // terminal after it, and ctrl+c typed into the terminal stops it alone.
    "set -m",
    // What it leaves running in the background outlives the terminal, as with pi's own bash.
    "trap '' HUP",
    // hc inside acts as pi: what it starts belongs to pi, not to this short-lived terminal.
    `export HC_TERMINAL_ID=${shellQuote(o.parent)}`,
    `printf '%s' ${ansiCQuote(o.header)}`,
    // Read before the pipeline, byte for byte: a command substitution inside
    // it would keep the script itself in front.
    `IFS= read -r -d '' pi_herdr_command <${shellQuote(o.files.command)} || :`,
    `${shellQuote(o.shell)} -c "$pi_herdr_command" </dev/null 2>&1 | tee ${shellQuote(o.files.output)}`,
    'exit "${PIPESTATUS[0]}"',
    "",
  ].join("\n");
}

/** The exit code of a finished terminal: its program's code, or 128 + the signal that ended it. */
export function exitCodeOf(t: { exit_code?: number | null; signal?: number | null }): number | null {
  if (typeof t.exit_code === "number") return t.exit_code;
  if (typeof t.signal === "number") return 128 + t.signal;
  return null;
}

/**
 * Follows a file another process appends to, handing each new piece to
 * `onData` as it lands: every `intervalMs`, and once more at `stop()`.
 */
export class OutputTail {
  private handle: FileHandle | undefined;
  private position = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly buffer = Buffer.allocUnsafe(64 * 1024);

  constructor(
    private readonly path: string,
    private readonly onData: (data: Buffer) => void,
    private readonly intervalMs = 100,
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reading = this.drain()
        .catch(() => undefined)
        .finally(() => this.start());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Reads what is left and closes the file. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.reading;
    await this.drain().catch(() => undefined);
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
  }

  private async drain(): Promise<void> {
    this.handle ??= await open(this.path, "r");
    for (;;) {
      const { bytesRead } = await this.handle.read(this.buffer, 0, this.buffer.length, this.position);
      if (bytesRead === 0) return;
      this.position += bytesRead;
      this.onData(Buffer.from(this.buffer.subarray(0, bytesRead)));
    }
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

const MAX_TIMEOUT_MS = 2_147_483_647;

function timeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  if (timeout * 1000 > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  return timeout * 1000;
}

export interface HcBashOptions {
  /** Where the per-command folders go (the command, its output, the script). */
  tmpDir?: string;
  /** How often the output file is read. */
  pollMs?: number;
  /** How long one `terminal.wait` may hold before it checks in again (seconds). */
  waitSliceS?: number;
  /** How long herdr-core may stay unreachable while a command runs before pi gives up on it. */
  unreachableMs?: number;
}

export interface CommandSpec {
  /** The shell the command runs in, as pi resolves it (`/bin/bash`). */
  shell: string;
  /** pi's own way to run it: for `hc wait`, and when herdr-core can't start a terminal. */
  local: BashOperations;
  source: BashSource;
  /** settings.json `shellCommandPrefix`, which pi puts before every command: left out of the header. */
  commandPrefix?: string;
}

/** Runs pi's bash commands in herdr-core terminals under pi's own. */
export class HcBash {
  /** Terminals of commands still running, to end with pi. */
  private readonly live = new Set<string>();
  private readonly tmpDir: string;
  private readonly pollMs: number;
  private readonly waitSliceS: number;
  private readonly unreachableMs: number;

  constructor(
    private readonly target: HcTarget,
    options: HcBashOptions = {},
  ) {
    this.tmpDir = options.tmpDir ?? tmpdir();
    this.pollMs = options.pollMs ?? 100;
    this.waitSliceS = options.waitSliceS ?? 50;
    this.unreachableMs = options.unreachableMs ?? 60_000;
  }

  /** `BashOperations` for pi's bash tool or `user_bash`. */
  operations(spec: CommandSpec): BashOperations {
    return { exec: (command, cwd, options) => this.exec(spec, command, cwd, options) };
  }

  /** On quit: end the commands still running and remove their terminals. */
  async shutdown(timeoutMs = 1000): Promise<void> {
    const { socket, terminal } = this.target;
    await Promise.all(
      [...this.live].map(async (address) => {
        await rpc(socket, "terminal.kill", { terminal: address, caller: terminal }, timeoutMs);
        await rpc(socket, "terminal.rm", { terminal: address, caller: terminal }, timeoutMs);
      }),
    );
    this.live.clear();
  }

  private async exec(
    spec: CommandSpec,
    command: string,
    cwd: string,
    options: Parameters<BashOperations["exec"]>[2],
  ): Promise<{ exitCode: number | null }> {
    const { onData, signal, timeout, env } = options;
    if (signal?.aborted) throw new Error("aborted");
    if (waitsOnHc(command)) return spec.local.exec(command, cwd, options);
    const limitMs = timeoutMs(timeout);
    try {
      await access(cwd, constants.F_OK);
    } catch {
      throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
    }

    const { socket, terminal: parent } = this.target;
    const dir = await mkdtemp(join(this.tmpDir, "pi-herdr-bash-"));
    const files = { command: join(dir, "command"), output: join(dir, "output") };
    const script = join(dir, "run.sh");
    const prefix = spec.commandPrefix ? `${spec.commandPrefix}\n` : "";
    const shown = prefix && command.startsWith(prefix) ? command.slice(prefix.length) : command;
    try {
      await writeFile(files.command, command);
      await writeFile(files.output, "");
      await writeFile(script, wrapperScript({ shell: spec.shell, files, parent, header: commandHeader(shown) }));
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }

    // Not abortable: once asked, the core may start it, and only its address lets pi end it.
    const started = await rpc(
      socket,
      "terminal.run",
      {
        argv: [spec.shell, script],
        cwd,
        env: terminalEnv(env ?? process.env),
        labels: { [BASH_LABEL]: spec.source },
        caller: parent,
        parent,
        no_notify: true,
      },
      10_000,
    );
    const address = started.ok ? (started.result as { address?: unknown } | null)?.address : undefined;
    if (typeof address !== "string") {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      // No answer in time: it may have started after all, so running it here could run it twice.
      if (!started.ok && (started.error === "timeout" || started.error === "bad_reply")) {
        throw new Error(`herdr-core did not answer in time (${started.error}); the command may or may not have run`);
      }
      // herdr-core isn't there or refused: run it the way pi does without it.
      return spec.local.exec(command, cwd, options);
    }
    this.live.add(address);

    const tail = new OutputTail(files.output, onData, this.pollMs);
    tail.start();
    const stop = new AbortController();
    let why: "aborted" | "timeout" | undefined;
    const onAbort = () => {
      why ??= "aborted";
      stop.abort();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      limitMs !== undefined
        ? setTimeout(() => {
            why ??= "timeout";
            stop.abort();
          }, limitMs)
        : undefined;

    let exitCode: number | null = null;
    let failure: unknown;
    try {
      exitCode = await this.waitForExit(address, stop.signal);
    } catch (e) {
      if (!why) failure = e;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (why) await rpc(socket, "terminal.kill", { terminal: address, caller: parent }, 10_000);
    await tail.stop();
    // Unreachable for too long: the terminal may still run; there is nobody to remove it now.
    if (!failure) {
      await rpc(socket, "terminal.rm", { terminal: address, caller: parent }, 5000);
      this.live.delete(address);
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);

    if (why === "aborted") throw new Error("aborted");
    if (why === "timeout") throw new Error(`timeout:${timeout}`);
    if (failure) throw failure;
    return { exitCode };
  }

  /**
   * Until the terminal's program exits: its exit code (null when the terminal
   * vanished). Throws when `signal` aborts, or when the core stays unreachable.
   */
  private async waitForExit(address: string, signal: AbortSignal): Promise<number | null> {
    const { socket } = this.target;
    // A program that reports a status word ends `terminal.wait` without
    // exiting; from then on only polling tells when it does.
    let polling = false;
    let unreachableSince: number | undefined;
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const reply = polling
        ? await rpc(socket, "terminal.get", { terminal: address }, 5000, signal)
        : await rpc(socket, "terminal.wait", { terminal: address, timeout: this.waitSliceS }, (this.waitSliceS + 10) * 1000, signal);
      if (!reply.ok) {
        if (reply.error === "aborted") throw new Error("aborted");
        // Removed by someone else: nothing left to tell how it ended.
        if (reply.error === "not_found") return null;
        // The core restarting (its programs keep running): ask again shortly.
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince > this.unreachableMs) {
          throw new Error(`herdr-core stopped answering while the command ran in terminal ${address} (${reply.error})`);
        }
        await sleep(500, signal);
        continue;
      }
      unreachableSince = undefined;
      const result = reply.result as { ended?: boolean; reason?: string; state?: string; exit_code?: number | null; signal?: number | null };
      if (polling) {
        if (result.state === "finished") return exitCodeOf(result);
        await sleep(250, signal);
      } else if (result.ended && result.reason === "exit") {
        return exitCodeOf(result);
      } else if (result.ended) {
        polling = true;
      }
    }
  }
}
