/**
 * memory_search · memory_read · memory_inbox
 *
 * Descriptions say what memory is for, not how to use it — the model judges
 * what is worth looking up or keeping. memory_inbox never writes memory
 * directly: items wait for the next dream and the user's review.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { INBOX_KINDS } from "./inbox.ts";
import type { Runtime } from "./runtime.ts";

/** `{ type: "string", enum }` typed through TypeBox (same JSON as pi-ai's StringEnum). */
function StringEnum<const T extends readonly string[]>(values: T, options: { description?: string } = {}) {
	return Type.Unsafe<T[number]>({ type: "string", enum: values, ...options });
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export function registerTools(pi: ExtensionAPI, rt: Runtime): void {
	pi.registerTool({
		name: "memory_search",
		label: "Memory search",
		description:
			"Search this user's long-term memory: approved memory notes (global and this project) and digests of past pi sessions. Returns note ids and session references (s:<session>#<entry>) to open with memory_read.",
		promptSnippet: "Search memory notes and past pi sessions of this user",
		promptGuidelines: [
			"Use memory_search when the task depends on what was done, decided or learned in earlier sessions, or on user preferences the <memory> section does not cover.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Words to look for: names, commands, paths, topics" }),
			scope: Type.Optional(StringEnum(["all", "notes", "sessions"] as const, { description: "What to search (default: all)" })),
			projects: Type.Optional(StringEnum(["current", "all"] as const, { description: "current = this project + global notes (default); all = every project" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "Results per kind (default 6)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(await rt.search(ctx, params.query, params.scope ?? "all", params.projects ?? "current", params.limit ?? 6));
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Memory read",
		description:
			"Open a memory note by id (m-xxxxxx) with its details and evidence, or a past session entry by reference (s:<sessionId>#<entryId>) with the entries around it.",
		promptSnippet: "Open a memory note or a past session entry",
		parameters: Type.Object({
			ref: Type.String({ description: "Note id (m-xxxxxx) or session reference s:<sessionId>#<entryId>" }),
		}),
		async execute(_id, params) {
			return text(await rt.read(params.ref));
		},
	});

	pi.registerTool({
		name: "memory_inbox",
		label: "Memory inbox",
		description:
			"Keep something for this user's future sessions. Items go to the inbox of pi-dream, which reviews them offline with the session evidence and proposes memory notes for the user to approve; they are not active memory yet.",
		promptSnippet: "Save something future sessions should know for the next memory review",
		promptGuidelines: [
			"Use memory_inbox when the user asks you to remember something, or when you learn something clearly worth keeping for future sessions that cannot be quickly rediscovered from the code — a preference or standing request, a verified procedure, a pitfall and its fix, a decision and its reason.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "A self-contained statement with the specifics (exact commands, paths, conditions, reasons)" }),
			kind: Type.Optional(StringEnum(INBOX_KINDS, { description: "What kind of knowledge this is" })),
			scope: Type.Optional(StringEnum(["project", "global"] as const, { description: "global = about the user or this machine across projects" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const id = await rt.inbox(ctx, params.text, "agent", params.kind, params.scope);
			return text(`Saved to the pi-dream inbox (${id}). The next dream reviews it; it becomes memory only after the user approves the change.`);
		},
	});
}
