/**
 * The dream report: the pull request description, `reports/<run>.md`, and the
 * short comment a later dream leaves on the open pull request.
 *
 * Made for a fast review. On top: what changes (counts) and what to check
 * before merging. Then one line per note, grouped by project, with whether it
 * loads into every session; the note text, rationale, fact check and sessions
 * fold out under each line. Confirmations, rejections and run statistics fold
 * away at the bottom.
 */

import { homedir } from "node:os";
import type { Stage } from "./config.ts";
import type { ChangeKind, IndexStat } from "./curate.ts";
import { GLOBAL_SCOPE } from "./layout.ts";
import type { StageUsage } from "./llm.ts";
import type { Evidence, IndexMode } from "./notes.ts";
import { shortKey } from "./project.ts";

export const REPORT_MARK = "<!-- pi-dream:report -->";
/** GitHub refuses pull request bodies and comments over 65 536 characters (JS length never counts fewer). */
export const BODY_LIMIT = 64_000;

export interface ReportSession {
	sessionId: string;
	date: string;
	project: string;
	title: string;
	outcome: string;
	learnings: number;
}

/** One change to memory, as the reviewer sees it. */
export interface ReportItem {
	kind: ChangeKind;
	/** Scope id: `global` or `projects/<dir>`. */
	scope: string;
	/** Note id; for a replacement, the new note. */
	id?: string;
	title: string;
	body?: string;
	index?: IndexMode;
	when?: string;
	/** superseded: the replaced note; updated: the title before, when it changed. */
	old?: { id?: string; title: string };
	/** moved: the scope the note came from. */
	from?: string;
	/** Evidence behind this change. */
	evidence: Evidence[];
	/** Why the curator (or a review comment) wants it — one line per dream that touched the note. */
	why: string[];
	/** The fact check of the latest change. */
	check?: { verdict: string; reason: string; corrected: boolean };
	/** Made on a review comment. */
	reviewer?: boolean;
	/** Risky content found in the note (`pipe-to-shell`…). */
	risky: string[];
	/** supersede / deprecate: evidence of the old note newer than this change's. */
	newerEvidence?: Evidence[];
	/** Other remarks (moved out of global…). */
	note?: string;
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
	/** What the proposal changes (the pull request title). */
	title?: string;
	url?: string;
	error?: string;
	patch: string;
	rationale: string[];
}

export interface ReportData {
	/** The dream this report is for (the latest one, for a pull request). */
	runId: string;
	/** Every dream the report covers. */
	runs: string[];
	date: string;
	language: string;
	models: Record<Stage, string>;
	usage: Partial<Record<Stage, StageUsage>>;
	sessions: ReportSession[];
	sessionTitles: Record<string, string>;
	inbox: number;
	feedback: number;
	unhandled: Array<{ comment: string; reason: string }>;
	items: ReportItem[];
	rejected: ReportRejected[];
	agents: ReportAgents[];
	indexes: IndexStat[];
	votes: number;
	normalized: number;
	problems: string[];
	/** Scope id → project key. */
	scopeTitles: Record<string, string>;
}

type Kinds = Record<ChangeKind, readonly [icon: string, label: string]>;

const pad = (n: number) => String(n).padStart(2, "0");

const RU = {
	run: "Сон",
	kinds: {
		added: ["➕", "Новые"],
		updated: ["✏️", "Изменены"],
		superseded: ["🔁", "Заменены"],
		moved: ["↪️", "Перенесены"],
		deprecated: ["🗑️", "Закрыты"],
		removed: ["✖️", "Убраны"],
		skill: ["🧩", "Скиллы"],
		confirmed: ["✓", "Подтверждены"],
		merged: ["✓", "Подтверждены"],
	} as Kinds,
	none: "Изменений памяти нет.",
	global: "Глобально — все проекты",
	always: "всегда",
	pointer: "по запросу",
	from: "из",
	instead: "вместо",
	byReviewer: "по комментарию",
	when: "Когда",
	was: "Было",
	replaces: "Заменяет",
	why: "Зачем",
	check: "Проверка",
	supported: "подтверждено",
	corrected: "уточнено проверяющим",
	sessions: "Сессии",
	newer: "Новее",
	more: (n: number) => `ещё ${n}`,
	reviewComment: "комментарий в PR",
	q: (s: string) => `«${s}»`,
	day: (m: number, d: number) => `${pad(d)}.${pad(m)}`,
	risky: (label: string) =>
		label === "pipe-to-shell" ? "в тексте `curl … | sh` — проверь источник" : `${label} — проверь перед merge`,
	newerWarn: "у старой заметки есть доказательства новее этого изменения — проверь, что она не актуальна",
	agentsFailed: "правка не применилась",
	overBudget: (scope: string, n: number) => `индекс ${scope} не влез в бюджет — только через поиск: ${n}`,
	unhandledWarn: (id: string, reason: string) => `комментарий \`${id}\` не выполнен: ${reason}`,
	confirmed: "Подтверждены существующие заметки",
	rejected: "Отклонено проверкой",
	patchOnly: "нет GitHub remote — патч внутри",
	nothingToChange: "уже в файле",
	dryRun: "пробный прогон — патч внутри",
	failed: "⚠️ не применилась",
	footer: (sessions: number, runs: number, cost: string) => `Сессии: ${sessions} · сны: ${runs} · ${cost} · как ревьюить`,
	howTo: [
		"- **Merge** — изменения попадут в память; индексы `MEMORY.md` подгружаются в новые сессии pi.",
		"- **Правки прямо в PR** (файлы `notes/*.md`) — сон продолжит с твоей версии.",
		"- **Комментарий в PR** — указание сну (править, убрать, перенести в другой проект); `/dream review` применит его сразу, иначе — следующий сон.",
		"- **Закрыть без merge** — отклонить: эти заметки не будут предлагаться повторно без новых доказательств.",
		"- _всегда_ — заголовок заметки в контексте каждой сессии; _по запросу_ — в контексте строка «когда → заметка»; без пометки — только через `memory_search`. 👤 — со слов пользователя.",
		"- Открыть сессию-доказательство: `pi --session <id>`.",
	].join("\n"),
	runsLabel: "Сны",
	indexes: "Индексы MEMORY.md",
	indexCols: "| scope | строк | токенов |",
	processed: "Обработанные сессии",
	sessionCols: "| дата | проект | сессия | итог | выводов |",
	models: "Модели",
	cost: "Стоимость",
	stats: (inbox: number, comments: number, votes: number, normalized: number) =>
		[
			inbox && `inbox: ${inbox}`,
			comments && `комментариев ревью: ${comments}`,
			votes && `оценок полезности: ${votes}`,
			normalized && `дополнено заметок (id/даты): ${normalized}`,
		]
			.filter(Boolean)
			.join(" · "),
	bodyUpdated: "Описание PR обновлено.",
	fullReport: "Полный отчёт этого сна",
	whatChanged: "Что изменил этот сон",
	shortened: "_Описание сокращено до лимита GitHub: полные подробности — в отчётах снов (внизу)._",
};

type Strings = typeof RU;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const EN: Strings = {
	run: "Dream",
	kinds: {
		added: ["➕", "New"],
		updated: ["✏️", "Updated"],
		superseded: ["🔁", "Replaced"],
		moved: ["↪️", "Moved"],
		deprecated: ["🗑️", "Closed"],
		removed: ["✖️", "Dropped"],
		skill: ["🧩", "Skills"],
		confirmed: ["✓", "Confirmed"],
		merged: ["✓", "Confirmed"],
	},
	none: "No memory changes.",
	global: "Global — all projects",
	always: "always",
	pointer: "on demand",
	from: "from",
	instead: "replaces",
	byReviewer: "from a review comment",
	when: "When",
	was: "Was",
	replaces: "Replaces",
	why: "Why",
	check: "Check",
	supported: "supported",
	corrected: "corrected by the fact checker",
	sessions: "Sessions",
	newer: "Newer",
	more: (n: number) => `${n} more`,
	reviewComment: "PR comment",
	q: (s: string) => `“${s}”`,
	day: (m: number, d: number) => `${MONTHS[m - 1] ?? m} ${d}`,
	risky: (label: string) =>
		label === "pipe-to-shell" ? "the text has `curl … | sh` — check the source" : `${label} — check before merging`,
	newerWarn: "the old note has evidence newer than this change — check that it no longer holds",
	agentsFailed: "the edit did not apply",
	overBudget: (scope: string, n: number) => `the ${scope} index is over budget — search only: ${n}`,
	unhandledWarn: (id: string, reason: string) => `comment \`${id}\` was not applied: ${reason}`,
	confirmed: "Existing notes confirmed",
	rejected: "Rejected by the fact check",
	patchOnly: "no GitHub remote — patch inside",
	nothingToChange: "already in the file",
	dryRun: "dry run — patch inside",
	failed: "⚠️ did not apply",
	footer: (sessions: number, runs: number, cost: string) => `Sessions: ${sessions} · dreams: ${runs} · ${cost} · how to review`,
	howTo: [
		"- **Merge** — the changes become memory; the `MEMORY.md` indexes load into new pi sessions.",
		"- **Edit in the PR** (`notes/*.md`) — the next dream continues from your version.",
		"- **Comment on the PR** — an instruction for the dream (edit, drop, move to another project); `/dream review` applies it now, otherwise the next dream does.",
		"- **Close without merging** — reject: these notes are not proposed again without new evidence.",
		"- _always_ — the note title is in every session's context; _on demand_ — a “when → note” line is; unmarked — `memory_search` only. 👤 — the user's own words.",
		"- Open an evidence session: `pi --session <id>`.",
	].join("\n"),
	runsLabel: "Dreams",
	indexes: "MEMORY.md indexes",
	indexCols: "| scope | lines | tokens |",
	processed: "Processed sessions",
	sessionCols: "| date | project | session | outcome | learnings |",
	models: "Models",
	cost: "Cost",
	stats: (inbox: number, comments: number, votes: number, normalized: number) =>
		[
			inbox && `inbox: ${inbox}`,
			comments && `review comments: ${comments}`,
			votes && `note usefulness votes: ${votes}`,
			normalized && `notes completed (ids/dates): ${normalized}`,
		]
			.filter(Boolean)
			.join(" · "),
	bodyUpdated: "The PR description is updated.",
	fullReport: "Full report of this dream",
	whatChanged: "What this dream changed",
	shortened: "_The description is cut to GitHub's limit: full details are in the dream reports (at the bottom)._",
};

export function strings(language: string): Strings {
	return language.toLowerCase().startsWith("ru") ? RU : EN;
}

// ── text ─────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One line of HTML (for `<summary>`, where markdown is not rendered): escaped, `code` spans kept. */
export function inlineHtml(s: string): string {
	return s
		.replace(/\s+/g, " ")
		.trim()
		.split(/(`[^`]+`)/)
		.map((p, i) => (i % 2 ? `<code>${escapeHtml(p.slice(1, -1))}</code>` : escapeHtml(p)))
		.join("");
}

/**
 * Markdown that shows `<…>` as text: GitHub drops unknown tags, so
 * `skills/<name>/SKILL.md` would lose `<name>`. Code is left alone.
 */
export function mdText(s: string): string {
	let fenced = false;
	return s
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				fenced = !fenced;
				return line;
			}
			if (fenced) return line;
			return line
				.split(/(`[^`]*`)/)
				.map((p, i) => (i % 2 ? p : p.replace(/</g, "&lt;")))
				.join("");
		})
		.join("\n");
}

function clip(s: string, max: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

function money(n: number): string {
	return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/** A project key for people: `owner/repo`, `~/dev/app`. */
export function keyLabel(key: string, home = homedir()): string {
	if (key.startsWith("local:")) {
		const path = key.slice(6);
		return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
	}
	return shortKey(key);
}

/** Best guess of the project key behind a scope id (`projects/local__Users__me__app` → `local:/Users/me/app`). */
function keyOfScope(scope: string): string | undefined {
	if (!scope.startsWith("projects/")) return undefined;
	const path = scope.slice("projects/".length).split("__").join("/");
	return path.startsWith("local/") ? `local:/${path.slice(6)}` : path;
}

function scopeLabel(scope: string, d: ReportData, t: Strings): string {
	if (scope === GLOBAL_SCOPE) return t.global;
	const key = d.scopeTitles[scope] ?? keyOfScope(scope);
	return key ? keyLabel(key) : scope;
}

/** `2026-11-08 21:41` from a run id (`20261108-2141-a1b2`). */
export function runWhen(runId: string): string {
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(runId);
	return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : runId;
}

// ── pieces ───────────────────────────────────────────────────────────────

/** Kinds shown as lines under their project; the rest fold into "confirmed". */
const SHOWN: ChangeKind[] = ["added", "superseded", "updated", "moved", "deprecated", "removed", "skill"];
const COUNTED: ChangeKind[] = ["added", "updated", "superseded", "moved", "deprecated", "removed", "skill", "confirmed"];
const INDEX_ORDER: Record<string, number> = { always: 0, pointer: 1, none: 2 };
const isConfirm = (k: ChangeKind) => k === "confirmed" || k === "merged";
/** The note stays in memory after this change, so where it loads matters. */
const lives = (k: ChangeKind) => k === "added" || k === "updated" || k === "moved" || k === "superseded";

function evidenceDay(e: Evidence, t: Strings): string {
	const ms = e.at ? Date.parse(e.at) : Number.NaN;
	if (Number.isFinite(ms)) {
		const x = new Date(ms);
		return t.day(x.getMonth() + 1, x.getDate());
	}
	const m = /^\d{4}-(\d{2})-(\d{2})/.exec(e.date ?? "");
	return m ? t.day(Number(m[1]), Number(m[2])) : "";
}

function evidenceText(e: Evidence, d: ReportData, t: Strings, titled: boolean): string {
	if (e.s.startsWith("inbox:")) return `inbox \`${e.s.slice(6)}\``;
	if (e.s.startsWith("pr#")) return t.reviewComment;
	const title = titled ? d.sessionTitles[e.s] : undefined;
	return [evidenceDay(e, t), title ? t.q(mdText(clip(title, 60))) : "", `\`${e.s.slice(0, 8)}\``, e.kind === "user" ? "👤" : ""]
		.filter(Boolean)
		.join(" ");
}

function evidenceList(list: Evidence[], d: ReportData, t: Strings, max = 3, titled = true): string {
	const lines = [...new Set(list.map((e) => evidenceText(e, d, t, titled)))];
	const shown = lines.slice(0, max);
	if (lines.length > max) shown.push(t.more(lines.length - max));
	return shown.join(" · ");
}

function countKinds(items: ReportItem[]): Partial<Record<ChangeKind, number>> {
	const c: Partial<Record<ChangeKind, number>> = {};
	for (const it of items) {
		const k = it.kind === "merged" ? "confirmed" : it.kind;
		c[k] = (c[k] ?? 0) + 1;
	}
	return c;
}

function countsLine(d: ReportData, t: Strings): string {
	const c = countKinds(d.items);
	const parts = COUNTED.filter((k) => c[k]).map((k) => `${t.kinds[k][0]} ${t.kinds[k][1]}: ${c[k]}`);
	if (d.agents.length) parts.push(`📄 AGENTS.md: ${d.agents.length}`);
	return parts.length ? `**${parts.join(" · ")}**` : `_${t.none}_`;
}

function summaryLine(it: ReportItem, d: ReportData, t: Strings): string {
	const parts = [`${t.kinds[it.kind][0]} <b>${inlineHtml(it.title)}</b>`];
	if (it.kind === "moved" && it.from) parts.push(`${t.from} ${escapeHtml(scopeLabel(it.from, d, t))}`);
	if (it.kind === "superseded" && it.old?.id) parts.push(`${t.instead} <code>${escapeHtml(it.old.id)}</code>`);
	if (lives(it.kind) && it.index === "always") parts.push(`<i>${t.always}</i>`);
	if (lives(it.kind) && it.index === "pointer") parts.push(`<i>${t.pointer}</i>`);
	if (it.reviewer) parts.push(t.byReviewer);
	if (it.risky.length || it.newerEvidence?.length) parts.push("⚠️");
	if (it.id) parts.push(`<code>${escapeHtml(it.id)}</code>`);
	return parts.join(" · ");
}

function quote(text: string): string {
	return text
		.trim()
		.split("\n")
		.map((l) => (l.trim() ? `> ${l}` : ">"))
		.join("\n");
}

/** What folds out under a note; `undefined` = one line per note. */
interface Detail {
	why: boolean;
	/** The fact check's verdict and reasoning (what it cut). */
	check: boolean;
	sessions: "titled" | "ids" | "none";
	/** The table of processed sessions at the bottom. */
	table: boolean;
}

const FULL: Detail = { why: true, check: true, sessions: "titled", table: true };
/**
 * A pull request description. Every change in it passed the fact check (it is
 * mostly "corrected"), so the verdict says little: it stays in the dream reports.
 */
const REVIEW: Detail = { why: true, check: false, sessions: "titled", table: true };
/** Fallbacks when the description is over GitHub's limit, least useful detail dropped first. */
const SMALLER: Array<Detail | undefined> = [
	{ ...REVIEW, table: false },
	{ ...REVIEW, table: false, sessions: "ids" },
	{ ...REVIEW, table: false, sessions: "none" },
	{ ...REVIEW, table: false, sessions: "none", why: false },
	undefined,
];

function itemDetails(it: ReportItem, d: ReportData, t: Strings, detail: Detail): string[] {
	const out: string[] = [];
	if (it.body?.trim()) out.push(quote(mdText(it.body)));
	const li: string[] = [];
	if (lives(it.kind) && it.index === "pointer" && it.when) li.push(`**${t.when}:** ${mdText(it.when)}`);
	if (it.kind === "superseded" && it.old) li.push(`**${t.replaces}:** ${t.q(mdText(it.old.title))}${it.old.id ? ` \`${it.old.id}\`` : ""}`);
	if (it.kind === "updated" && it.old) li.push(`**${t.was}:** ${t.q(mdText(it.old.title))}`);
	const why = detail.why ? [...new Set(it.why.map((w) => w.trim()).filter(Boolean))] : [];
	if (why.length === 1) li.push(`**${t.why}:** ${mdText(why[0])}`);
	if (why.length > 1) li.push(`**${t.why}:**\n${why.map((w) => `  - ${mdText(w)}`).join("\n")}`);
	if (it.check && detail.check) {
		const c = it.check;
		const label = c.verdict === "supported" ? t.supported : c.corrected ? t.corrected : c.verdict;
		li.push(`**${t.check}:** ${label}${c.verdict !== "supported" && c.reason ? ` — ${mdText(c.reason)}` : ""}`);
	}
	const titled = detail.sessions === "titled";
	if (it.evidence.length && detail.sessions !== "none") li.push(`**${t.sessions}:** ${evidenceList(it.evidence, d, t, 3, titled)}`);
	for (const r of it.risky) li.push(`⚠️ ${t.risky(r)}`);
	if (it.newerEvidence?.length) {
		li.push(`⚠️ ${t.newerWarn}`);
		if (detail.sessions !== "none") li.push(`**${t.newer}:** ${evidenceList(it.newerEvidence, d, t, 3, titled)}`);
	}
	if (it.note) li.push(`ℹ️ ${mdText(it.note)}`);
	if (out.length && li.length) out.push("");
	out.push(...li.map((l) => `- ${l}`));
	return out;
}

function itemBlock(it: ReportItem, d: ReportData, t: Strings, detail: Detail | undefined): string[] {
	if (!detail) return [`- ${summaryLine(it, d, t)}`];
	return [`<details><summary>${summaryLine(it, d, t)}</summary>`, "", ...itemDetails(it, d, t, detail), "", "</details>"];
}

function byScope(items: ReportItem[]): Array<[string, ReportItem[]]> {
	const groups = new Map<string, ReportItem[]>();
	for (const it of items) {
		const list = groups.get(it.scope) ?? [];
		list.push(it);
		groups.set(it.scope, list);
	}
	for (const list of groups.values())
		list.sort((a, b) => SHOWN.indexOf(a.kind) - SHOWN.indexOf(b.kind) || (INDEX_ORDER[a.index ?? "none"] ?? 2) - (INDEX_ORDER[b.index ?? "none"] ?? 2));
	return [...groups.entries()].sort(
		([a, la], [b, lb]) => Number(b === GLOBAL_SCOPE) - Number(a === GLOBAL_SCOPE) || lb.length - la.length || a.localeCompare(b),
	);
}

const BENIGN_AGENTS = ["no GitHub remote", "nothing to change", "dry run"];
const agentsFailed = (a: ReportAgents) => !a.url && !!a.error && !BENIGN_AGENTS.some((b) => a.error?.startsWith(b));

/** `📄 project · AGENTS.md — what it changes → PR` (HTML). */
function agentsLine(a: ReportAgents, t: Strings): string {
	const head = `📄 <b>${escapeHtml(keyLabel(a.project))}</b> · <code>${escapeHtml(a.rel)}</code>${a.title ? ` — ${inlineHtml(a.title)}` : ""}`;
	if (a.url) {
		const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(a.url);
		return `${head} → <a href="${escapeHtml(a.url)}">${escapeHtml(m ? `${m[1]}#${m[2]}` : a.url)}</a>`;
	}
	const e = a.error ?? "";
	const status = e.startsWith("no GitHub remote")
		? t.patchOnly
		: e.startsWith("nothing to change")
			? t.nothingToChange
			: e.startsWith("dry run")
				? t.dryRun
				: t.failed;
	return `${head} · ${status}`;
}

function warnings(d: ReportData, t: Strings): string[] {
	const out: string[] = [];
	const ref = (it: ReportItem) => `${it.id ? `\`${it.id}\` ` : ""}${t.q(mdText(clip(it.title, 70)))}`;
	for (const it of d.items) {
		for (const r of it.risky) out.push(`${ref(it)} — ${t.risky(r)}`);
		if (it.newerEvidence?.length) out.push(`${ref(it)} — ${t.newerWarn}`);
	}
	for (const a of d.agents) if (agentsFailed(a)) out.push(`📄 ${mdText(keyLabel(a.project))} \`${a.rel}\` — ${t.agentsFailed}: \`${a.error}\``);
	for (const i of d.indexes) if (i.dropped.length) out.push(t.overBudget(scopeLabel(i.scope, d, t), i.dropped.length));
	for (const u of d.unhandled) out.push(t.unhandledWarn(u.comment, mdText(u.reason)));
	return out;
}

function totalCost(d: ReportData): number {
	return Object.values(d.usage).reduce((s, u) => s + (u?.cost ?? 0), 0);
}

// ── report ───────────────────────────────────────────────────────────────

interface RenderOptions {
	/** A title line, for `reports/<run>.md`. */
	heading?: boolean;
	/** Link to a dream's own report. */
	reportUrl?: (runId: string) => string;
}

function render(d: ReportData, t: Strings, detail: Detail | undefined, shortened: boolean, opts: RenderOptions): string {
	const out: string[] = [REPORT_MARK];
	if (opts.heading) out.push(`# ${t.run} ${runWhen(d.runId)}`, "");
	out.push(countsLine(d, t), "");
	if (shortened) out.push(t.shortened, "");

	const warns = warnings(d, t);
	if (warns.length) out.push("> [!WARNING]", ...warns.map((w) => `> - ${w}`), "");

	for (const [scope, items] of byScope(d.items.filter((it) => !isConfirm(it.kind)))) {
		out.push(`### ${mdText(scopeLabel(scope, d, t))}`, "");
		for (const it of items) out.push(...itemBlock(it, d, t, detail));
		out.push("");
	}

	if (d.agents.length) {
		out.push("### AGENTS.md / CLAUDE.md", "");
		for (const a of d.agents) {
			out.push(`<details><summary>${agentsLine(a, t)}</summary>`, "");
			for (const r of a.rationale) out.push(`- ${mdText(r)}`);
			if (agentsFailed(a)) out.push(`- ⚠️ \`${a.error}\``);
			if (!a.url) out.push(...(a.rationale.length || agentsFailed(a) ? [""] : []), a.patch.replace(/^`[^`\n]+`\n\n/, ""));
			out.push("", "</details>");
		}
		out.push("");
	}

	const confirmed = d.items.filter((it) => isConfirm(it.kind));
	if (confirmed.length) {
		out.push(`<details><summary>✓ ${t.confirmed}: ${confirmed.length}</summary>`, "");
		for (const it of confirmed) {
			const ev = it.evidence.length && detail?.sessions !== "none" ? ` — ${evidenceList(it.evidence, d, t, 2, detail?.sessions === "titled")}` : "";
			out.push(`- ${mdText(scopeLabel(it.scope, d, t))} · ${t.q(mdText(it.title))}${it.id ? ` \`${it.id}\`` : ""}${ev}`);
		}
		out.push("", "</details>", "");
	}

	if (d.rejected.length) {
		out.push(`<details><summary>✗ ${t.rejected}: ${d.rejected.length}</summary>`, "");
		const icon: Record<string, string> = {
			add: t.kinds.added[0],
			update: t.kinds.updated[0],
			supersede: t.kinds.superseded[0],
			deprecate: t.kinds.deprecated[0],
			confirm: t.kinds.confirmed[0],
			skill: t.kinds.skill[0],
			agents_md: "📄",
		};
		for (const r of d.rejected) out.push(`- ${icon[r.op] ?? r.op} ${t.q(mdText(r.title))} — ${mdText(r.reason)}`);
		out.push("", "</details>", "");
	}

	out.push(...footer(d, t, opts, detail?.table ?? false), "");
	return out.join("\n");
}

function footer(d: ReportData, t: Strings, opts: RenderOptions, table: boolean): string[] {
	const out = [`<details><summary>${escapeHtml(t.footer(d.sessions.length, d.runs.length, money(totalCost(d))))}</summary>`, "", t.howTo, ""];
	const link = opts.reportUrl;
	if (link || d.runs.length > 1) out.push(`**${t.runsLabel}:** ${d.runs.map((r) => (link ? `[${runWhen(r)}](${link(r)})` : runWhen(r))).join(" · ")}`, "");
	const stats = t.stats(d.inbox, d.feedback, d.votes, d.normalized);
	if (stats) out.push(stats, "");
	const indexes = d.indexes.filter((i) => i.included.length || i.dropped.length);
	if (indexes.length) {
		out.push(`**${t.indexes}**`, "", t.indexCols, "|---|---|---|");
		for (const i of indexes) {
			const over = i.dropped.length ? ` ⚠️ +${i.dropped.length}` : "";
			out.push(`| ${mdText(scopeLabel(i.scope, d, t))} | ${i.included.length}${over} | ${i.tokens}/${i.budget} |`);
		}
		out.push("");
	}
	if (d.sessions.length && table) {
		out.push(`**${t.processed}**`, "", t.sessionCols, "|---|---|---|---|---|");
		for (const s of d.sessions)
			out.push(`| ${s.date} | ${s.project} | ${mdText(s.title).replace(/\|/g, "\\|")} \`${s.sessionId.slice(0, 8)}\` | ${s.outcome} | ${s.learnings} |`);
		out.push("");
	}
	const usage = (Object.entries(d.usage) as Array<[Stage, StageUsage]>).map(([stage, u]) => `${stage} ${money(u.cost)} (${u.calls}×)`).join(", ");
	out.push(`**${t.models}:** cards \`${d.models.cards}\`, curator \`${d.models.analyze}\`, check \`${d.models.verify}\``);
	if (usage) out.push(`**${t.cost}:** ${usage}`);
	out.push("");
	if (d.problems.length) out.push("**diagnostics**", "", ...d.problems.map((p) => `- ${mdText(p)}`), "");
	out.push("</details>");
	return out;
}

/** A dream's own report (`reports/<run>.md`): every detail, the fact check's reasoning included. */
export function renderReport(d: ReportData, opts: RenderOptions = {}): string {
	return render(d, strings(d.language), FULL, false, { heading: true, ...opts });
}

/** The pull request description: the review view of the whole PR, cut down to GitHub's limit. */
export function renderPrBody(d: ReportData, opts: RenderOptions & { limit?: number } = {}): string {
	const t = strings(d.language);
	const limit = opts.limit ?? BODY_LIMIT;
	let text = render(d, t, REVIEW, false, opts);
	for (const detail of SMALLER) {
		if (text.length <= limit) return text;
		text = render(d, t, detail, true, opts);
	}
	return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n\n…(truncated)`;
}

/** The comment a later dream leaves on the open pull request: what it changed, and where the rest is. */
export function renderRunComment(d: ReportData, opts: { updated: boolean; reportUrl?: string }): string {
	const t = strings(d.language);
	const out = [REPORT_MARK, `**${t.run} ${runWhen(d.runId)}:** ${countsLine(d, t).replace(/^\*\*|\*\*$/g, "")}`, ""];
	if (opts.updated) out.push(`${t.bodyUpdated}${opts.reportUrl ? ` [${t.fullReport}](${opts.reportUrl}).` : ""}`, "");
	const warns = warnings(d, t);
	if (warns.length) out.push("> [!WARNING]", ...warns.map((w) => `> - ${w}`), "");
	const shown = d.items.filter((it) => !isConfirm(it.kind));
	if (shown.length || d.agents.length) {
		out.push(`<details><summary>${t.whatChanged}</summary>`, "");
		for (const [scope, items] of byScope(shown)) {
			out.push(`**${mdText(scopeLabel(scope, d, t))}**`, "");
			for (const it of items) out.push(`- ${summaryLine(it, d, t)}`);
			out.push("");
		}
		for (const a of d.agents) out.push(`- ${agentsLine(a, t)}`);
		out.push("", "</details>");
	}
	const text = out.join("\n");
	return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT - 40)}\n\n…(truncated)` : text;
}

/** `pi-dream 2026-11-08: +33 ~2 ✓1 AGENTS.md 1` */
export function prTitle(d: ReportData, date = d.date): string {
	const c = (...kinds: ChangeKind[]) => d.items.filter((x) => kinds.includes(x.kind)).length;
	const parts = [
		c("added") && `+${c("added")}`,
		c("updated", "moved") && `~${c("updated", "moved")}`,
		c("superseded") && `⇄${c("superseded")}`,
		c("deprecated", "removed") && `−${c("deprecated", "removed")}`,
		c("confirmed", "merged") && `✓${c("confirmed", "merged")}`,
		c("skill") && `skills ${c("skill")}`,
		d.agents.length && `AGENTS.md ${d.agents.length}`,
	].filter(Boolean);
	return `pi-dream ${date}: ${parts.join(" ") || "review"}`;
}
