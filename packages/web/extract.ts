/**
 * trafilatura-based content extraction.
 *
 * Detects an available Python tool runner (uv/uvx, pipx, pip-run) and pipes
 * fetched HTML through trafilatura, returning clean markdown.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface PythonRunner {
  command: string;
  trafilaturaArgs: () => string[];
  label: string;
}

/**
 * Python tool runners in priority order.
 *
 *  1. uvx           — fastest, ships with uv (uvx trafilatura ...)
 *  2. uv run --with — fallback if uvx alias is missing but uv is installed
 *  3. pipx run      — widely available, especially on Debian/Ubuntu
 *  4. pip-run       — niche but capable (pip-run trafilatura -- -m trafilatura ...)
 */
const PYTHON_RUNNERS: PythonRunner[] = [
  {
    command: "uvx",
    trafilaturaArgs: () => ["trafilatura", "--markdown", "--formatting"],
    label: "uvx (uv)",
  },
  {
    command: "uv",
    trafilaturaArgs: () => ["run", "--with", "trafilatura", "trafilatura", "--markdown", "--formatting"],
    label: "uv run",
  },
  {
    command: "pipx",
    trafilaturaArgs: () => ["run", "trafilatura", "--markdown", "--formatting"],
    label: "pipx",
  },
  {
    command: "pip-run",
    trafilaturaArgs: () => ["trafilatura", "--", "-m", "trafilatura", "--markdown", "--formatting"],
    label: "pip-run",
  },
];

let detectedRunner: PythonRunner | null = null;
let runnerDetectionDone = false;

export async function detectPythonRunner(execFn: ExtensionAPI["exec"]): Promise<PythonRunner | null> {
  if (runnerDetectionDone) return detectedRunner;

  for (const runner of PYTHON_RUNNERS) {
    try {
      const result = await execFn(runner.command, ["--version"], { timeout: 5000 });
      if (result.code === 0) {
        detectedRunner = runner;
        runnerDetectionDone = true;
        return detectedRunner;
      }
    } catch {
      // not available, try next
    }
  }

  runnerDetectionDone = true;
  return null;
}

export function getDetectedRunner(): PythonRunner | null {
  return detectedRunner;
}

export function killProcess(proc: ReturnType<typeof spawn>): void {
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (!proc.killed) proc.kill("SIGKILL");
  }, 5000);
}

/**
 * Race a promise against a timeout. Returns the promise result or rejects
 * with a timeout error. If a signal is provided, the timeout is also
 * cancelled when the signal aborts.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms / 1000} seconds`));
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export async function extractContent(
  html: string,
  signal?: AbortSignal,
): Promise<{ ok: true; markdown: string } | { ok: false; error: string }> {
  if (signal?.aborted) return { ok: false, error: "Aborted" };

  if (!detectedRunner) {
    return {
      ok: false,
      error: "No Python tool runner found. Install one of: uv (recommended), pipx, or pip-run.",
    };
  }

  const command = detectedRunner.command;
  const args = detectedRunner.trafilaturaArgs();

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const onAbort = () => killProcess(proc);
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);

      if (signal?.aborted) {
        resolve({ ok: false, error: "Aborted" });
        return;
      }

      if (code !== 0) {
        resolve({
          ok: false,
          error: `Trafilatura extraction failed (exit code ${code}): ${stderr.trim() || "(no error output)"}`,
        });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          ok: false,
          error:
            "Trafilatura extracted no content from the page. The page may be empty or use a format that trafilatura cannot parse.",
        });
        return;
      }

      resolve({ ok: true, markdown: trimmed });
    });

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, error: `Failed to run ${command} trafilatura: ${err.message}` });
    });

    proc.stdin.write(html);
    proc.stdin.end();
  });
}
