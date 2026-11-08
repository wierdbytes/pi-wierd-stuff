/**
 * The inbox: things an agent (memory_inbox) or the user (/remember) wants the
 * next dream to consider. Append-only JSONL per day under `.local/inbox/`;
 * items are never active memory by themselves — the dream reviews them like
 * any other evidence and proposes notes in the pull request.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryPaths, today } from "./layout.ts";

export const INBOX_KINDS = ["preference", "procedure", "pitfall", "fact", "decision", "reference", "other"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxItem {
	id: string;
	ts: string;
	source: "agent" | "user";
	text: string;
	kind?: InboxKind;
	scope?: "global" | "project";
	cwd: string;
	projectKey: string;
	sessionId?: string;
	sessionFile?: string;
	/** Leaf entry of the session when the item was written. */
	entryId?: string;
}

export function appendInbox(root: string, item: Omit<InboxItem, "id" | "ts">): InboxItem {
	const dir = memoryPaths(root).inbox;
	mkdirSync(dir, { recursive: true });
	const full: InboxItem = { id: `i-${randomBytes(4).toString("hex")}`, ts: new Date().toISOString(), ...item };
	appendFileSync(join(dir, `${today()}.jsonl`), `${JSON.stringify(full)}\n`, "utf-8");
	return full;
}

export function readInbox(root: string): InboxItem[] {
	const dir = memoryPaths(root).inbox;
	if (!existsSync(dir)) return [];
	const out: InboxItem[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(dir, name), "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const item = JSON.parse(line) as InboxItem;
				if (item?.id && typeof item.text === "string") out.push(item);
			} catch {
				// torn line: skip
			}
		}
	}
	return out;
}
