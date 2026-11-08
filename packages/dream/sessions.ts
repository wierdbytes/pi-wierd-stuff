/**
 * Reading pi session files (`~/.pi/agent/sessions/<cwd>/<ts>_<id>.jsonl`).
 *
 * Sessions are trees; the newest appended entry is the current leaf, so the
 * active branch is the parent chain from the last entry back to the root.
 * Images and thinking are dropped while streaming, which keeps 100 MB
 * sessions full of screenshots cheap to hold in memory.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SessionFile {
	path: string;
	mtimeMs: number;
	size: number;
}

export interface RawEntry {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	message?: Record<string, unknown> & { role?: string; content?: unknown };
	customType?: string;
	data?: unknown;
	content?: unknown;
	summary?: string;
	name?: string;
	[key: string]: unknown;
}

export interface SessionHeader {
	id: string;
	cwd: string;
	timestamp: string;
	parentSession?: string;
}

export interface ParsedSession {
	file: string;
	header: SessionHeader;
	/** Active branch, root first. */
	branch: RawEntry[];
	name?: string;
	lastEntryId?: string;
}

export function sessionsRoot(): string {
	return process.env.PI_CODING_AGENT_SESSION_DIR || join(getAgentDir(), "sessions");
}

export function listSessionFiles(root: string = sessionsRoot()): SessionFile[] {
	const out: SessionFile[] = [];
	if (!existsSync(root)) return out;
	for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const full = join(root, dir.name);
		let names: string[];
		try {
			names = readdirSync(full);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(full, name);
			try {
				const st = statSync(path);
				if (st.isFile()) out.push({ path, mtimeMs: st.mtimeMs, size: st.size });
			} catch {
				// vanished between readdir and stat
			}
		}
	}
	return out;
}

/** Session id from a file name `<timestamp>_<id>.jsonl`. */
export function sessionIdFromPath(path: string): string {
	const base = path.split("/").pop() ?? path;
	const m = /_([^_]+)\.jsonl$/.exec(base);
	return m ? m[1] : base.replace(/\.jsonl$/, "");
}

function slim(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((b) => {
		if (!b || typeof b !== "object") return b;
		const t = (b as { type?: string }).type;
		if (t === "image") return { type: "image" };
		if (t === "thinking" || t === "redacted_thinking") return { type: "thinking" };
		return b;
	});
}

function slimEntry(e: RawEntry): RawEntry {
	if (e.message && typeof e.message === "object") {
		const m = e.message;
		if (m.role === "system") e.message = { role: "system" };
		else if ("content" in m) m.content = slim(m.content);
	}
	if (e.type === "custom_message" && "content" in e) e.content = slim(e.content);
	if (e.type === "compaction") delete e.systemMessage;
	return e;
}

export async function parseSession(file: string): Promise<ParsedSession | undefined> {
	const entries = new Map<string, RawEntry>();
	let header: SessionHeader | undefined;
	let lastId: string | undefined;
	let name: string | undefined;
	const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line) continue;
		let e: RawEntry;
		try {
			e = JSON.parse(line) as RawEntry;
		} catch {
			continue;
		}
		if (e.type === "session") {
			header = e as unknown as SessionHeader;
			continue;
		}
		if (typeof e.id !== "string") continue;
		entries.set(e.id, slimEntry(e));
		lastId = e.id;
		if (e.type === "session_info" && typeof e.name === "string") name = e.name;
	}
	if (!header) return undefined;
	const branch: RawEntry[] = [];
	const seen = new Set<string>();
	let cur = lastId ? entries.get(lastId) : undefined;
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		branch.push(cur);
		cur = cur.parentId ? entries.get(cur.parentId) : undefined;
	}
	branch.reverse();
	return { file, header, branch, name, lastEntryId: lastId };
}

/** Plain text of a message content (string or blocks); images become `[image]`. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: string; text?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
		else if (blk.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** Small LRU of parsed sessions, for evidence lookups during one dream. */
export class SessionCache {
	private map = new Map<string, Promise<ParsedSession | undefined>>();
	constructor(private max = 8) {}
	get(file: string): Promise<ParsedSession | undefined> {
		let p = this.map.get(file);
		if (p) {
			this.map.delete(file);
			this.map.set(file, p);
			return p;
		}
		p = parseSession(file);
		this.map.set(file, p);
		while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
		return p;
	}
}
