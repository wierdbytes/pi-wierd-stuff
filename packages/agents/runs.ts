/**
 * The files a parent and its sub-agents share, one pair per run:
 *
 * - `<runId>.meta.json` — written by the parent before the child starts:
 *   what the child is for and the instructions its type adds.
 * - `<runId>.json` — written by the child: how many runs settled, the last
 *   assistant message, live activity.
 *
 * Writes are atomic (tmp + rename) so a reader never sees half a file.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunMeta {
  v: 1;
  runId: string;
  description: string;
  type: string;
  /** Instructions the agent type adds to the child's system prompt. */
  typePrompt: string;
  /** The parent's terminal address. */
  parent: string;
  parentPid: number;
  depth: number;
  cwd: string;
  model?: string;
  thinking?: string;
  createdAt: number;
}

export type LastStatus = "done" | "error" | "aborted";

export interface ChildActivity {
  /** Tool calls started so far, across runs. */
  tools: number;
  /** Assistant turns ended so far, across runs. */
  turns: number;
  /** The latest tool call. */
  tool?: string;
  detail?: string;
  at: number;
}

export interface ChildState {
  v: 1;
  runId: string;
  pid: number;
  sessionId?: string;
  sessionFile?: string;
  /** Runs settled so far; the parent finishes a record when this moves past its baseline. */
  seq: number;
  running: boolean;
  last?: { status: LastStatus; text: string; error?: string; at: number };
  activity?: ChildActivity;
  updatedAt: number;
}

export const metaPath = (dir: string, runId: string): string => join(dir, `${runId}.meta.json`);
export const statePath = (dir: string, runId: string): string => join(dir, `${runId}.json`);

/** `<runId>.json` → runId; meta files and temp files → undefined. */
export function runIdOfStateFile(file: string): string | undefined {
  if (!file.endsWith(".json") || file.endsWith(".meta.json")) return undefined;
  return file.slice(0, -".json".length);
}

export function newRunId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export const readMeta = (dir: string, runId: string): RunMeta | undefined => readJson<RunMeta>(metaPath(dir, runId));
export const readState = (dir: string, runId: string): ChildState | undefined =>
  readJson<ChildState>(statePath(dir, runId));

export function writeMeta(dir: string, meta: RunMeta): void {
  ensureDir(dir);
  writeJsonAtomic(metaPath(dir, meta.runId), meta);
}

export function writeState(dir: string, state: ChildState): void {
  ensureDir(dir);
  writeJsonAtomic(statePath(dir, state.runId), state);
}

/** Drops run files older than `maxAgeMs`. Never throws. */
export function pruneRuns(dir: string, maxAgeMs = 7 * 24 * 3600_000, now = Date.now()): void {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
    } catch {
      // Gone already, or not ours to delete.
    }
  }
}
