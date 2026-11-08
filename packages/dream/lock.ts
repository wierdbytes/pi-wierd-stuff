/**
 * One dream at a time across every pi process on the machine.
 *
 * The lock file holds the dreamer's pid; a lock whose process is gone, or
 * that is older than the maximum runtime, is stale and taken over — a crashed
 * dream can never disable dreaming for good.
 */

import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export interface LockInfo {
	pid: number;
	runId: string;
	startedAt: string;
}

export function readLock(path: string): LockInfo | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as LockInfo;
	} catch {
		return undefined;
	}
}

export function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function lockIsLive(path: string, maxAgeMs: number, now = Date.now()): LockInfo | undefined {
	const info = readLock(path);
	if (!info) return undefined;
	const age = now - Date.parse(info.startedAt);
	if (!isAlive(info.pid) || !(age < maxAgeMs)) return undefined;
	return info;
}

export function acquireLock(path: string, runId: string, maxAgeMs: number): boolean {
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() } satisfies LockInfo));
			closeSync(fd);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (lockIsLive(path, maxAgeMs)) return false;
			try {
				unlinkSync(path);
			} catch {
				// someone else removed it first
			}
		}
	}
	return false;
}

export function releaseLock(path: string): void {
	const info = readLock(path);
	if (info && info.pid !== process.pid) return;
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}
