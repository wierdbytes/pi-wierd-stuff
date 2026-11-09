/**
 * What a dream — or the whole open pull request — changes in memory, as
 * report items.
 *
 * A dream's own items come from the operations it applied. The pull request
 * description is rebuilt by every dream from the notes themselves: the note
 * files the branch changed are compared, by note id, with their version at
 * the merge base. So it shows exactly what merging does — every dream of the
 * PR, review comments and hand edits included — while the rationale and the
 * fact check come from the dreams that made each change.
 */

import type { Stage } from "./config.ts";
import type { Change, ChangeKind } from "./curate.ts";
import type { StageUsage } from "./llm.ts";
import type { Evidence, Note } from "./notes.ts";
import type { ReportAgents, ReportData, ReportItem, ReportRejected, ReportSession } from "./report.ts";
import { findRisky } from "./secrets.ts";

/** A change this dream applied, with what the report says about it. */
export interface ReportChange extends Change {
	rationale: string;
	evidence: Evidence[];
	source: "curator" | "reviewer";
	verdict?: { verdict: string; reason: string; corrected: boolean };
	/** supersede / deprecate: evidence of the old note newer than this change's. */
	newerEvidence?: Evidence[];
}

export const risky = (n: Pick<Note, "title" | "body">): string[] => findRisky(`${n.title}\n${n.body}`);

/** Report item for a change this dream applied; `find` sees the notes as the dream left them. */
export function itemFromChange(c: ReportChange, find: (id: string) => Note | undefined): ReportItem {
	const n = find(c.newId ?? c.noteId ?? "");
	const replaced = c.kind === "superseded" && c.noteId ? find(c.noteId) : undefined;
	return {
		kind: c.kind,
		scope: n?.scope ?? c.scope,
		id: c.newId ?? c.noteId,
		title: n?.title ?? c.title,
		body: n?.body,
		index: n?.index,
		when: n?.when,
		old: replaced ? { id: replaced.id, title: replaced.title } : c.oldTitle ? { title: c.oldTitle } : undefined,
		from: c.from,
		evidence: c.evidence,
		why: c.rationale ? [c.rationale] : [],
		check: c.verdict,
		reviewer: c.source === "reviewer" || undefined,
		risky: n && c.kind !== "removed" && c.kind !== "deprecated" ? risky(n) : [],
		newerEvidence: c.newerEvidence,
		note: c.note,
	};
}

export type DiffKind = Extract<ChangeKind, "added" | "updated" | "moved" | "superseded" | "deprecated" | "removed" | "confirmed">;

export interface NoteDiff {
	kind: DiffKind;
	/** The note as the branch has it (removed: as the base had it). */
	note: Note;
	/** The base version: the note before the change; for superseded, the replaced note. */
	before?: Note;
	/** Evidence the branch added. */
	evidence: Evidence[];
}

const evKey = (e: Evidence) => `${e.s}|${[...e.e].sort().join(",")}`;
const content = (n: Note) => JSON.stringify([n.title, n.body.trim(), n.when ?? "", n.index, n.type]);

/**
 * Compare notes by id. `base`: the merge-base versions of the note files the
 * branch changed or deleted; `head`: the branch versions of the files it
 * changed or added. Vote counts and other bookkeeping are not changes.
 */
export function diffNotes(base: readonly Note[], head: readonly Note[]): NoteDiff[] {
	const baseById = new Map(base.filter((n) => n.id).map((n) => [n.id, n]));
	// A hand-written note gets its id from the dream: match it by file.
	const baseByFile = new Map(base.filter((n) => !n.id).map((n) => [n.file, n]));
	const headById = new Map(head.filter((n) => n.id).map((n) => [n.id, n]));
	const added = (n: Note, b?: Note) => {
		const seen = new Set((b?.evidence ?? []).map(evKey));
		return n.evidence.filter((e) => !seen.has(evKey(e)));
	};
	const out: NoteDiff[] = [];
	for (const n of head) {
		const b = (n.id ? baseById.get(n.id) : undefined) ?? baseByFile.get(n.file);
		if (!b) {
			// Added and closed again within the pull request: never approved, nothing to show.
			if (n.status !== "active") continue;
			const replaced = (n.supersedes ?? []).map((id) => baseById.get(id)).find((x) => x?.status === "active");
			out.push({ kind: replaced ? "superseded" : "added", note: n, before: replaced, evidence: added(n) });
			continue;
		}
		const evidence = added(n, b);
		if (b.status === "active" && n.status !== "active") {
			const repl = n.supersededBy ? headById.get(n.supersededBy) : undefined;
			if (n.status === "superseded" && repl?.status === "active" && repl.supersedes?.includes(n.id)) continue; // shown with its replacement
			out.push({ kind: "deprecated", note: n, before: b, evidence });
		} else if (n.scope !== b.scope) out.push({ kind: "moved", note: n, before: b, evidence });
		else if (content(n) !== content(b) || n.status !== b.status) out.push({ kind: "updated", note: n, before: b, evidence });
		else if (evidence.length) out.push({ kind: "confirmed", note: n, before: b, evidence });
	}
	for (const b of base) if (b.id && b.status === "active" && !headById.has(b.id)) out.push({ kind: "removed", note: b, evidence: [] });
	return out;
}

/**
 * Report items for the pull request: its note changes, with the rationale and
 * fact check of the dreams that made them (`runs`: every dream's items, oldest first).
 */
export function itemsFromDiff(diffs: readonly NoteDiff[], runs: ReadonlyArray<readonly ReportItem[]>): ReportItem[] {
	const said = new Map<string, ReportItem[]>();
	for (const items of runs)
		for (const it of items)
			for (const id of new Set([it.id, it.old?.id])) {
				if (!id) continue;
				const list = said.get(id) ?? [];
				list.push(it);
				said.set(id, list);
			}
	const items: ReportItem[] = diffs.map((d) => {
		const n = d.note;
		const recs = [...(said.get(n.id) ?? []), ...(d.before && d.before.id !== n.id ? (said.get(d.before.id) ?? []) : [])];
		// The latest fact check: review-comment changes have none of their own.
		const checked = recs.findLast((r) => r.check);
		const old =
			d.kind === "superseded" && d.before
				? { id: d.before.id, title: d.before.title }
				: d.kind === "updated" && d.before && d.before.title !== n.title
					? { title: d.before.title }
					: undefined;
		const notes = [...new Set(recs.map((r) => r.note).filter((x): x is string => !!x))];
		return {
			kind: d.kind,
			scope: n.scope,
			id: n.id,
			title: n.title,
			body: n.body,
			index: n.index,
			when: n.when,
			old,
			from: d.kind === "moved" ? d.before?.scope : undefined,
			evidence: d.evidence,
			why: [...new Set(recs.flatMap((r) => r.why))],
			check: checked?.check,
			reviewer: recs.some((r) => r.reviewer) || undefined,
			risky: d.kind === "removed" || d.kind === "deprecated" ? [] : risky(n),
			newerEvidence: d.kind === "superseded" || d.kind === "deprecated" ? recs.findLast((r) => r.newerEvidence?.length)?.newerEvidence : undefined,
			note: notes.join(" · ") || undefined,
		};
	});
	// Skills are files, not notes: the dreams' own items stand for them.
	const skills = new Map<string, ReportItem>();
	for (const list of runs) for (const it of list) if (it.kind === "skill") skills.set(`${it.scope}|${it.title.split(":")[0]}`, it);
	return [...items, ...skills.values()];
}

/** The pull request's report: its note changes (`items`) and what each of its dreams (oldest first) said. */
export function prReport(runs: readonly ReportData[], items: ReportItem[]): ReportData {
	const last = runs[runs.length - 1];
	const usage: Partial<Record<Stage, StageUsage>> = {};
	for (const r of runs)
		for (const [stage, u] of Object.entries(r.usage) as Array<[Stage, StageUsage]>) {
			const acc = usage[stage] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0, failures: 0 };
			for (const k of ["calls", "input", "output", "cacheRead", "cost", "failures"] as const) acc[k] += u[k] ?? 0;
			usage[stage] = acc;
		}
	const sessions = new Map<string, ReportSession>();
	for (const r of runs) for (const s of r.sessions) sessions.set(s.sessionId, s);
	const agents = new Map<string, ReportAgents>();
	for (const r of runs)
		for (const a of r.agents) {
			const k = `${a.project}|${a.rel}`;
			const prev = agents.get(k);
			agents.set(k, prev ? { ...a, url: a.url ?? prev.url, rationale: [...new Set([...prev.rationale, ...a.rationale])] } : a);
		}
	const rejected = new Map<string, ReportRejected>();
	for (const r of runs) for (const x of r.rejected) rejected.set(`${x.op}|${x.title}`, x);
	const sum = (k: "inbox" | "feedback" | "votes" | "normalized") => runs.reduce((s, r) => s + (r[k] ?? 0), 0);
	return {
		...last,
		runs: runs.map((r) => r.runId),
		usage,
		sessions: [...sessions.values()],
		sessionTitles: Object.assign({}, ...runs.map((r) => r.sessionTitles)),
		scopeTitles: Object.assign({}, ...runs.map((r) => r.scopeTitles)),
		inbox: sum("inbox"),
		feedback: sum("feedback"),
		votes: sum("votes"),
		normalized: sum("normalized"),
		items,
		rejected: [...rejected.values()],
		agents: [...agents.values()],
	};
}
