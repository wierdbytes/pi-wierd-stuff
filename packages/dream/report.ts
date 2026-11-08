/**
 * The dream report: the pull request body and `reports/<run>.md`.
 *
 * Written for a reviewer who wants to understand every change: what changed,
 * why the curator wants it, which sessions back it, and what the independent
 * fact check said — including the proposals it rejected.
 */

import type { Stage } from "./config.ts";
import type { Change } from "./curate.ts";
import type { IndexStat } from "./curate.ts";
import type { StageUsage } from "./llm.ts";
import type { Evidence } from "./notes.ts";

export const REPORT_MARK = "<!-- pi-dream:report -->";

export interface ReportSession {
	sessionId: string;
	date: string;
	project: string;
	title: string;
	outcome: string;
	learnings: number;
}

export interface ReportChange extends Change {
	rationale: string;
	evidence: Evidence[];
	source: "curator" | "reviewer";
	verdict?: { verdict: string; reason: string; corrected: boolean };
	/** The curator's title when the fact checker rewrote it. */
	proposedTitle?: string;
	/** supersede / deprecate: evidence of the old note newer than this change's. */
	newerEvidence?: Evidence[];
}

export interface ReportRejected {
	ref: string;
	op: string;
	title: string;
	reason: string;
}

export interface ReportAgents {
	project: string;
	rel: string;
	url?: string;
	error?: string;
	patch: string;
	rationale: string[];
}

export interface ReportData {
	runId: string;
	date: string;
	language: string;
	models: Record<Stage, string>;
	usage: Partial<Record<Stage, StageUsage>>;
	sessions: ReportSession[];
	sessionTitles: Record<string, string>;
	inbox: number;
	feedback: number;
	unhandled: Array<{ comment: string; reason: string }>;
	changes: ReportChange[];
	rejected: ReportRejected[];
	agents: ReportAgents[];
	indexes: IndexStat[];
	votes: number;
	normalized: number;
	problems: string[];
	scopeTitles: Record<string, string>;
}

const RU = {
	title: "Сон",
	sessions: "Сессий",
	projects: "проектов",
	inbox: "inbox",
	comments: "комментариев ревью",
	cost: "Стоимость",
	models: "Модели",
	added: "Новые заметки",
	updated: "Обновлённые заметки",
	moved: "Перенесены в другой scope",
	superseded: "Замены (старая заметка закрыта, новая вместо неё)",
	deprecated: "Устаревшие (закрыты без замены)",
	removed: "Убрано из PR (ещё не было в main)",
	confirmed: "Новые подтверждения существующих заметок",
	merged: "Слито с существующими (дубликаты)",
	skill: "Скиллы",
	why: "зачем",
	evidence: "доказательства",
	check: "проверка",
	corrected: "исправлено проверяющим",
	proposed: "куратор предлагал",
	newer: "⚠️ у старой заметки есть доказательства новее, чем у этого изменения — проверь, что они не показывают её актуальной",
	reviewer: "по комментарию ревью",
	agents: "Предложения для AGENTS.md / CLAUDE.md",
	rejected: "Отклонено проверкой (в память не попало)",
	unhandled: "Комментарии, которые не удалось выполнить",
	indexes: "Что попадёт в контекст сессий (индексы MEMORY.md)",
	tokens: "токенов",
	lines: "строк",
	over: "не поместилось в бюджет",
	processed: "Обработанные сессии",
	session: "сессия",
	entries: "записи",
	comment: "комментарий",
	none: "Изменений памяти нет.",
	howTo: `### Как ревьюить
- **Merge** — изменения попадут в память; индексы \`MEMORY.md\` подгружаются в новые сессии pi.
- **Правки прямо в PR** (файлы \`notes/*.md\`) — сон продолжит с твоей версии.
- **Комментарий в PR** — указание сну (править, убрать, перенести в другой проект); \`/dream review\` применит его сразу, иначе — следующий сон.
- **Закрыть без merge** — отклонить: эти заметки не будут предлагаться повторно без новых доказательств.
- Открыть сессию-доказательство: \`pi --session <id>\`.`,
	votes: "оценок полезности заметок",
	normalized: "заметок дополнено (id/даты)",
};

const EN: typeof RU = {
	title: "Dream",
	sessions: "Sessions",
	projects: "projects",
	inbox: "inbox",
	comments: "review comments",
	cost: "Cost",
	models: "Models",
	added: "New notes",
	updated: "Updated notes",
	moved: "Moved to another scope",
	superseded: "Superseded (old note closed, replaced)",
	deprecated: "Deprecated (closed, no replacement)",
	removed: "Removed from the PR (never approved)",
	confirmed: "New evidence for existing notes",
	merged: "Merged into existing notes (duplicates)",
	skill: "Skills",
	why: "why",
	evidence: "evidence",
	check: "check",
	corrected: "corrected by the fact checker",
	proposed: "the curator proposed",
	newer: "⚠️ the old note has evidence newer than this change's — check that it does not show the note still holds",
	reviewer: "from a review comment",
	agents: "AGENTS.md / CLAUDE.md proposals",
	rejected: "Rejected by the fact check (not in memory)",
	unhandled: "Comments that could not be applied",
	indexes: "What sessions will load (MEMORY.md indexes)",
	tokens: "tokens",
	lines: "lines",
	over: "over budget",
	processed: "Processed sessions",
	session: "session",
	entries: "entries",
	comment: "comment",
	none: "No memory changes.",
	howTo: `### How to review
- **Merge** — the changes become memory; the \`MEMORY.md\` indexes load into new pi sessions.
- **Edit in the PR** (\`notes/*.md\`) — the next dream continues from your version.
- **Comment on the PR** — an instruction for the dream (edit, drop, move to another project); \`/dream review\` applies it now, otherwise the next dream does.
- **Close without merging** — reject: these notes are not proposed again without new evidence.
- Open an evidence session: \`pi --session <id>\`.`,
	votes: "note usefulness votes",
	normalized: "notes completed (ids/dates)",
};

export function strings(language: string): typeof RU {
	return language.toLowerCase().startsWith("ru") ? RU : EN;
}

function money(n: number): string {
	return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/** `2026-10-31 16:09` in local time when the time is known, else the day. */
function evidenceWhen(e: Evidence): string {
	const ms = e.at ? Date.parse(e.at) : Number.NaN;
	if (!Number.isFinite(ms)) return e.date ?? "";
	const x = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

function evidenceLine(e: Evidence, d: ReportData, t: typeof RU): string {
	if (e.s.startsWith("inbox:")) return `inbox \`${e.s.slice(6)}\``;
	if (e.s.startsWith("pr#")) return `${t.comment} ${e.s}`;
	const title = d.sessionTitles[e.s];
	const ids = e.e.length ? `, ${t.entries} ${e.e.map((x) => `\`${x}\``).join(" ")}` : "";
	const kind = e.kind === "user" ? " 👤" : "";
	return `${t.session}${title ? ` «${title}»` : ""} ${evidenceWhen(e)} \`${e.s.slice(0, 8)}\`${ids}${kind}`.replace(/\s+/g, " ");
}

function scopeLabel(scope: string, d: ReportData): string {
	return d.scopeTitles[scope] ?? scope;
}

export function prTitle(d: ReportData): string {
	const c = (k: string) => d.changes.filter((x) => x.kind === k).length;
	const parts = [
		c("added") && `+${c("added")}`,
		c("updated") + c("moved") && `~${c("updated") + c("moved")}`,
		c("superseded") && `⇄${c("superseded")}`,
		c("deprecated") + c("removed") && `−${c("deprecated") + c("removed")}`,
		c("confirmed") + c("merged") && `✓${c("confirmed") + c("merged")}`,
		c("skill") && `skills ${c("skill")}`,
		d.agents.length && `AGENTS.md ${d.agents.length}`,
	].filter(Boolean);
	return `pi-dream ${d.date}: ${parts.join(" ") || "review"}`;
}

export function renderReport(d: ReportData): string {
	const t = strings(d.language);
	const out: string[] = [REPORT_MARK, `# ${t.title} ${d.date} · \`${d.runId}\``, ""];
	const projects = new Set(d.sessions.map((s) => s.project)).size;
	const cost = Object.values(d.usage).reduce((s, u) => s + (u?.cost ?? 0), 0);
	out.push(
		`**${t.sessions}:** ${d.sessions.length} (${t.projects}: ${projects}) · **${t.inbox}:** ${d.inbox} · **${t.comments}:** ${d.feedback}` +
			(d.votes ? ` · ${t.votes}: ${d.votes}` : "") +
			(d.normalized ? ` · ${t.normalized}: ${d.normalized}` : ""),
	);
	const usage = (Object.entries(d.usage) as Array<[Stage, StageUsage]>)
		.map(([stage, u]) => `${stage} ${money(u.cost)} (${u.calls}×)`)
		.join(", ");
	out.push(`**${t.cost}:** ${money(cost)}${usage ? ` — ${usage}` : ""}`);
	out.push(`**${t.models}:** cards \`${d.models.cards}\`, curator \`${d.models.analyze}\`, check \`${d.models.verify}\``, "");

	const groups: Array<[string, string]> = [
		["added", t.added],
		["updated", t.updated],
		["moved", t.moved],
		["superseded", t.superseded],
		["deprecated", t.deprecated],
		["removed", t.removed],
		["skill", t.skill],
		["confirmed", t.confirmed],
		["merged", t.merged],
	];
	if (!d.changes.length && !d.agents.length) out.push(`_${t.none}_`, "");
	for (const [kind, heading] of groups) {
		const list = d.changes.filter((c) => c.kind === kind);
		if (!list.length) continue;
		out.push(`## ${heading}`, "");
		for (const c of list) {
			const id = c.newId ? `\`${c.noteId}\` → \`${c.newId}\`` : c.noteId ? `\`${c.noteId}\`` : "";
			out.push(`- **${c.title}** ${id} — _${scopeLabel(c.scope, d)}_${c.source === "reviewer" ? ` · ${t.reviewer}` : ""}`);
			if (c.rationale) out.push(`  - ${t.why}: ${c.rationale}`);
			if (c.evidence.length) out.push(`  - ${t.evidence}: ${c.evidence.map((e) => evidenceLine(e, d, t)).join("; ")}`);
			if (c.verdict)
				out.push(`  - ${t.check}: **${c.verdict.verdict}**${c.verdict.corrected ? ` (${t.corrected})` : ""} — ${c.verdict.reason}`);
			if (c.proposedTitle && c.proposedTitle !== c.title) out.push(`  - ${t.proposed}: «${c.proposedTitle}»`);
			if (c.newerEvidence?.length) out.push(`  - ${t.newer}: ${c.newerEvidence.map((e) => evidenceLine(e, d, t)).join("; ")}`);
			if (c.note) out.push(`  - ${c.note}`);
		}
		out.push("");
	}

	if (d.agents.length) {
		out.push(`## ${t.agents}`, "");
		for (const a of d.agents) {
			out.push(`- **${a.project}** \`${a.rel}\`: ${a.url ?? `⚠️ ${a.error ?? ""}`}`);
			for (const r of a.rationale) out.push(`  - ${r}`);
			if (!a.url) out.push("", a.patch, "");
		}
		out.push("");
	}

	if (d.rejected.length) {
		out.push(`<details><summary><b>${t.rejected}: ${d.rejected.length}</b></summary>`, "");
		for (const r of d.rejected) out.push(`- \`${r.op}\` ${r.title} — ${r.reason}`);
		out.push("", "</details>", "");
	}

	if (d.unhandled.length) {
		out.push(`## ${t.unhandled}`, "");
		for (const u of d.unhandled) out.push(`- ${t.comment} \`${u.comment}\`: ${u.reason}`);
		out.push("");
	}

	if (d.indexes.length) {
		out.push(`## ${t.indexes}`, "");
		for (const i of d.indexes) {
			const over = i.dropped.length ? ` · ⚠️ ${t.over}: ${i.dropped.length}` : "";
			out.push(`- _${scopeLabel(i.scope, d)}_: ${i.tokens}/${i.budget} ${t.tokens}, ${i.included.length} ${t.lines}${over}`);
		}
		out.push("");
	}

	if (d.sessions.length) {
		out.push(`<details><summary><b>${t.processed}: ${d.sessions.length}</b></summary>`, "");
		out.push("| date | project | session | outcome | learnings |", "|---|---|---|---|---|");
		for (const s of d.sessions)
			out.push(`| ${s.date} | ${s.project} | ${s.title.replace(/\|/g, "\\|")} \`${s.sessionId.slice(0, 8)}\` | ${s.outcome} | ${s.learnings} |`);
		out.push("", "</details>", "");
	}

	if (d.problems.length) {
		out.push("<details><summary>diagnostics</summary>", "", ...d.problems.map((p) => `- ${p}`), "", "</details>", "");
	}

	out.push(t.howTo, "");
	return out.join("\n");
}
