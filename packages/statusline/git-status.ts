import { spawn } from "node:child_process";

export interface GitStatus {
  branch: string | null;
  dirty: boolean;
}

interface CachedStatus {
  dirty: boolean;
  timestamp: number;
}

interface CachedBranch {
  branch: string | null;
  timestamp: number;
}

const STATUS_TTL_MS = 1000;
const BRANCH_TTL_MS = 500;

let cachedStatus: CachedStatus | null = null;
let cachedBranch: CachedBranch | null = null;
let pendingStatus: Promise<void> | null = null;
let pendingBranch: Promise<void> | null = null;
let cachedCwd: string | null = null;

function runGit(cwd: string, args: string[], timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["-C", cwd, "--no-optional-locks", ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let done = false;
    const finish = (result: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.on("close", (code) => finish(code === 0 ? stdout.trim() : null));
    proc.on("error", () => finish(null));
    const timer = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

async function fetchBranch(cwd: string): Promise<string | null> {
  return runGit(cwd, ["branch", "--show-current"], 300);
}

async function fetchDirty(cwd: string): Promise<boolean> {
  const out = await runGit(cwd, ["status", "--porcelain"]);
  return out !== null && out.length > 0;
}

function resetIfCwdChanged(cwd: string): void {
  if (cachedCwd !== cwd) {
    cachedCwd = cwd;
    cachedStatus = null;
    cachedBranch = null;
  }
}

export function getGitStatus(cwd: string): GitStatus {
  resetIfCwdChanged(cwd);
  const now = Date.now();

  if (!cachedBranch || now - cachedBranch.timestamp >= BRANCH_TTL_MS) {
    if (!pendingBranch) {
      pendingBranch = fetchBranch(cwd).then((b) => {
        cachedBranch = { branch: b || null, timestamp: Date.now() };
        pendingBranch = null;
      });
    }
  }

  if (!cachedStatus || now - cachedStatus.timestamp >= STATUS_TTL_MS) {
    if (!pendingStatus) {
      pendingStatus = fetchDirty(cwd).then((d) => {
        cachedStatus = { dirty: d, timestamp: Date.now() };
        pendingStatus = null;
      });
    }
  }

  return {
    branch: cachedBranch?.branch ?? null,
    dirty: cachedStatus?.dirty ?? false,
  };
}

export function invalidateGitStatus(): void {
  cachedStatus = null;
}
