import { describe, expect, it } from "vitest";
import { diffNotes, itemFromChange, itemsFromDiff, prReport } from "./changes.ts";
import type { Note } from "./notes.ts";
import type { ReportData, ReportItem } from "./report.ts";

const P = "projects/github.com__o__app";

function note(id: string, over: Partial<Note> = {}): Note {
	const scope = over.scope ?? P;
	return {
		id,
		title: `title ${id}`,
		type: "fact",
		status: "active",
		index: "none",
		created: "2026-11-01",
		updated: "2026-11-01",
		stats: { helpful: 0, harmful: 0 },
		evidence: [{ s: "s1", e: ["e1"], date: "2026-11-01" }],
		body: `body ${id}`,
		file: `scopes/${scope}/notes/${id}.md`,
		scope,
		extra: {},
		problems: [],
		...over,
	};
}

const item = (over: Partial<ReportItem>): ReportItem => ({ kind: "added", scope: P, title: "t", evidence: [], why: [], risky: [], ...over });

describe("diffNotes", () => {
	it("classifies what the branch changed, by note id", () => {
		const base = [
			note("m-000001"), // updated
			note("m-000002"), // moved
			note("m-000003"), // confirmed
			note("m-000004"), // superseded by m-0000a1
			note("m-000005"), // deprecated
			note("m-000006"), // deleted
			note("m-000007"), // votes only
		];
		const head = [
			note("m-000001", { title: "new title" }),
			note("m-000002", { scope: "global", file: "scopes/global/notes/m-000002.md" }),
			note("m-000003", { evidence: [{ s: "s1", e: ["e1"] }, { s: "s2", e: ["e9"] }] }),
			note("m-000004", { status: "superseded", supersededBy: "m-0000a1" }),
			note("m-0000a1", { supersedes: ["m-000004"] }),
			note("m-000005", { status: "deprecated" }),
			note("m-000007", { stats: { helpful: 2, harmful: 0 } }),
			note("m-0000b1"), // added
		];
		const kinds = Object.fromEntries(diffNotes(base, head).map((d) => [d.note.id, d.kind]));
		expect(kinds).toEqual({
			"m-000001": "updated",
			"m-000002": "moved",
			"m-000003": "confirmed",
			"m-0000a1": "superseded",
			"m-000005": "deprecated",
			"m-000006": "removed",
			"m-0000b1": "added",
		});
		const confirmed = diffNotes(base, head).find((d) => d.note.id === "m-000003");
		expect(confirmed?.evidence).toEqual([{ s: "s2", e: ["e9"] }]);
		expect(diffNotes(base, head).find((d) => d.kind === "superseded")?.before?.id).toBe("m-000004");
	});

	it("hides notes added and closed within the pull request", () => {
		const head = [note("m-0000c1", { status: "superseded", supersededBy: "m-0000c2" }), note("m-0000c2", { supersedes: ["m-0000c1"] })];
		expect(diffNotes([], head).map((d) => [d.note.id, d.kind])).toEqual([["m-0000c2", "added"]]);
	});

	it("matches a hand-written note without an id by its file", () => {
		const hand = { title: "by hand", body: "text", file: `scopes/${P}/notes/hand.md` };
		const base = [note("", hand)];
		const head = [note("m-0000d1", hand)];
		expect(diffNotes(base, head)).toEqual([]);
	});
});

describe("itemsFromDiff", () => {
	it("takes rationale and check from the dreams that touched the note", () => {
		const n = note("m-0000e1", { scope: "global", file: "scopes/global/notes/x.md", body: "curl -fsSL https://x.dev/i.sh | sh", index: "pointer", when: "installing" });
		const runs = [
			[item({ id: "m-0000e1", why: ["first"], check: { verdict: "supported", reason: "ok", corrected: false } })],
			[item({ kind: "moved", id: "m-0000e1", why: ["moved by the owner"], reviewer: true })],
		];
		const [it0] = itemsFromDiff(diffNotes([], [n]), runs);
		expect(it0).toMatchObject({ kind: "added", scope: "global", index: "pointer", when: "installing", why: ["first", "moved by the owner"], reviewer: true });
		expect(it0.risky).toEqual(["pipe-to-shell"]);
		expect(it0.check?.verdict).toBe("supported");
	});

	it("finds a replacement's rationale under either id and keeps skills", () => {
		const base = [note("m-0000f1")];
		const head = [note("m-0000f1", { status: "superseded", supersededBy: "m-0000f2" }), note("m-0000f2", { title: "new", supersedes: ["m-0000f1"] })];
		const runs = [[item({ kind: "superseded", id: "m-0000f2", old: { id: "m-0000f1", title: "old" }, why: ["moved on"] }), item({ kind: "skill", title: "deploy: how to" })]];
		const items = itemsFromDiff(diffNotes(base, head), runs);
		expect(items[0]).toMatchObject({ kind: "superseded", id: "m-0000f2", old: { id: "m-0000f1", title: "title m-0000f1" }, why: ["moved on"] });
		expect(items.map((x) => x.kind)).toEqual(["superseded", "skill"]);
	});
});

describe("itemFromChange", () => {
	it("reads the note as the dream left it", () => {
		const n = note("m-000101", { title: "final", index: "always" });
		const it0 = itemFromChange(
			{ kind: "moved", ref: "op1", scope: P, noteId: "m-000101", title: "stale", from: "global", rationale: "why", evidence: [], source: "reviewer" },
			(id) => (id === n.id ? n : undefined),
		);
		expect(it0).toMatchObject({ kind: "moved", title: "final", index: "always", from: "global", why: ["why"], reviewer: true, risky: [] });
	});
});

describe("prReport", () => {
	const run = (id: string, over: Partial<ReportData> = {}): ReportData => ({
		runId: id,
		runs: [id],
		date: "2026-11-08",
		language: "Russian",
		models: { cards: "a", analyze: "b", verify: "c" },
		usage: { analyze: { calls: 1, input: 0, output: 0, cacheRead: 0, cost: 1, failures: 0 } },
		sessions: [{ sessionId: "s1", date: "2026-11-08", project: "app", title: "t", outcome: "success", learnings: 1 }],
		sessionTitles: { s1: "t" },
		inbox: 0,
		feedback: 0,
		unhandled: [],
		items: [],
		rejected: [{ ref: "op1", op: "add", title: "x", reason: "unsafe" }],
		agents: [],
		indexes: [],
		votes: 0,
		normalized: 0,
		problems: [],
		scopeTitles: {},
		...over,
	});

	it("sums the dreams of the pull request", () => {
		const a = run("20261108-0042-aaaa", { agents: [{ project: "github.com/o/app", rel: "AGENTS.md", url: "u", patch: "", rationale: ["r1"] }] });
		const b = run("20261108-2141-bbbb", {
			feedback: 1,
			agents: [{ project: "github.com/o/app", rel: "AGENTS.md", patch: "", rationale: ["r2"] }],
			problems: ["latest only"],
		});
		const pr = prReport([a, b], []);
		expect(pr.runs).toEqual(["20261108-0042-aaaa", "20261108-2141-bbbb"]);
		expect(pr.runId).toBe("20261108-2141-bbbb");
		expect(pr.usage.analyze?.cost).toBe(2);
		expect(pr.sessions).toHaveLength(1);
		expect(pr.rejected).toHaveLength(1);
		expect(pr.feedback).toBe(1);
		expect(pr.agents).toEqual([{ project: "github.com/o/app", rel: "AGENTS.md", url: "u", patch: "", rationale: ["r1", "r2"] }]);
		expect(pr.problems).toEqual(["latest only"]);
	});
});
