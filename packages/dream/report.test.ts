import { describe, expect, it } from "vitest";
import {
	inlineHtml,
	keyLabel,
	mdText,
	prTitle,
	type ReportData,
	type ReportItem,
	renderPrBody,
	renderReport,
	renderRunComment,
	runWhen,
} from "./report.ts";

const APP = "projects/github.com__o__app";

const item = (over: Partial<ReportItem>): ReportItem => ({ kind: "added", scope: APP, title: "t", evidence: [], why: [], risky: [], ...over });

function data(over: Partial<ReportData> = {}): ReportData {
	return {
		runId: "20261108-2141-9ff0",
		runs: ["20261108-2141-9ff0"],
		date: "2026-11-08",
		language: "Russian",
		models: { cards: "a/cards", analyze: "a/curator", verify: "o/check" },
		usage: { analyze: { calls: 2, input: 0, output: 0, cacheRead: 0, cost: 1.5, failures: 0 } },
		sessions: [{ sessionId: "01a17911-aaaa", date: "2026-10-26", project: "app", title: "Сборка | эмодзи", outcome: "success", learnings: 2 }],
		sessionTitles: { "01a17911-aaaa": "Сборка эмодзи" },
		inbox: 0,
		feedback: 0,
		unhandled: [],
		items: [],
		rejected: [],
		agents: [],
		indexes: [],
		votes: 0,
		normalized: 0,
		problems: [],
		scopeTitles: { [APP]: "github.com/o/app", global: "global" },
		...over,
	};
}

describe("text helpers", () => {
	it("keeps <placeholders> visible", () => {
		expect(inlineHtml("skills/<name>/SKILL.md and `a<b>`")).toBe("skills/&lt;name&gt;/SKILL.md and <code>a&lt;b&gt;</code>");
		expect(mdText("dir <name>, `x<y>`\n```\n<tag>\n```")).toBe("dir &lt;name>, `x<y>`\n```\n<tag>\n```");
	});

	it("names projects and runs for people", () => {
		expect(keyLabel("github.com/o/app")).toBe("o/app");
		expect(keyLabel("local:/home/me/dev/app", "/home/me")).toBe("~/dev/app");
		expect(keyLabel("local:/srv/app", "/home/me")).toBe("/srv/app");
		expect(runWhen("20261108-2141-9ff0")).toBe("2026-11-08 21:41");
	});
});

describe("renderPrBody", () => {
	const d = data({
		items: [
			item({ id: "m-000001", title: "Search note", index: "none" }),
			item({
				id: "m-000002",
				title: "Always note `x`",
				index: "always",
				body: "Body with <name>",
				why: ["because"],
				check: { verdict: "partial", reason: "cut a claim", corrected: true },
				evidence: [{ s: "01a17911-aaaa", e: ["e1"], date: "2026-10-26", kind: "user" }],
			}),
			item({ id: "m-000003", scope: "global", title: "Global note", index: "pointer", when: "when installing", risky: ["pipe-to-shell"] }),
			item({ kind: "confirmed", id: "m-000004", title: "Old note", evidence: [{ s: "01a17911-aaaa", e: [] }] }),
			item({ kind: "moved", id: "m-000005", title: "Moved note", from: "projects/local__srv__old", reviewer: true }),
		],
		agents: [
			{ project: "github.com/o/app", rel: "AGENTS.md", title: "Fix the layout", error: "edit 1: text not found on main", patch: "`AGENTS.md`\n\n```diff\n- a\n+ b\n```", rationale: ["stale"] },
			{ project: "local:/srv/lib", rel: "CLAUDE.md", error: "no GitHub remote: patch only", patch: "```diff\n+ c\n```", rationale: [] },
		],
		rejected: [{ ref: "op9", op: "add", title: "Risky idea", reason: "unsafe — kills processes" }],
		unhandled: [{ comment: "IC_1", reason: "unclear" }],
	});
	const md = renderPrBody(d, { reportUrl: (id) => `https://github.com/o/mem/blob/abc/reports/${id}.md` });

	it("puts counts and the things to check on top", () => {
		const lines = md.split("\n");
		expect(lines[0]).toBe("<!-- pi-dream:report -->");
		expect(lines[1]).toBe("**➕ Новые: 3 · ↪️ Перенесены: 1 · ✓ Подтверждены: 1 · 📄 AGENTS.md: 2**");
		expect(md).toContain("> [!WARNING]");
		expect(md).toContain("> - `m-000003` «Global note» — в тексте `curl … | sh` — проверь источник");
		expect(md).toContain("> - 📄 o/app `AGENTS.md` — правка не применилась: `edit 1: text not found on main`");
		expect(md).toContain("> - комментарий `IC_1` не выполнен: unclear");
		expect(md).not.toContain("> - 📄 /srv/lib"); // a patch without a remote is not a failure
	});

	it("lists one line per note, grouped by project, global first", () => {
		expect(md.indexOf("### Глобально — все проекты")).toBeLessThan(md.indexOf("### o/app"));
		expect(md).toContain("<summary>➕ <b>Always note <code>x</code></b> · <i>всегда</i> · <code>m-000002</code></summary>");
		expect(md).toContain("<summary>➕ <b>Global note</b> · <i>по запросу</i> · ⚠️ · <code>m-000003</code></summary>");
		expect(md).toContain("<summary>➕ <b>Search note</b> · <code>m-000001</code></summary>");
		expect(md).toContain("<summary>↪️ <b>Moved note</b> · из /srv/old · по комментарию · <code>m-000005</code></summary>");
		// always before search-only within a project
		expect(md.indexOf("m-000002</code></summary>")).toBeLessThan(md.indexOf("m-000001</code></summary>"));
	});

	it("folds the note text, rationale, check and sessions under the line", () => {
		expect(md).toContain("> Body with &lt;name>");
		expect(md).toContain("- **Зачем:** because");
		expect(md).not.toContain("**Проверка:**"); // every change in a PR passed the check: the verdict stays in the dream report
		expect(md).toContain("- **Сессии:** 26.10 «Сборка эмодзи» `01a17911` 👤");
		expect(md).toContain("- **Когда:** when installing");
	});

	it("folds confirmations, rejections and run details away", () => {
		expect(md).toContain("<details><summary>✓ Подтверждены существующие заметки: 1</summary>");
		expect(md).toContain("- o/app · «Old note» `m-000004` — «Сборка эмодзи» `01a17911`");
		expect(md).not.toContain("<b>Old note</b>");
		expect(md).toContain("<details><summary>✗ Отклонено проверкой: 1</summary>");
		expect(md).toContain("- ➕ «Risky idea» — unsafe — kills processes");
		expect(md).toContain("<details><summary>Сессии: 1 · сны: 1 · $1.50 · как ревьюить</summary>");
		expect(md).toContain("**Сны:** [2026-11-08 21:41](https://github.com/o/mem/blob/abc/reports/20261108-2141-9ff0.md)");
		expect(md).toContain("| 2026-10-26 | app | Сборка \\| эмодзи `01a17911` | success | 2 |");
	});

	it("shows AGENTS.md proposals with their patch", () => {
		expect(md).toContain("📄 <b>o/app</b> · <code>AGENTS.md</code> — Fix the layout · ⚠️ не применилась</summary>");
		expect(md).toContain("📄 <b>/srv/lib</b> · <code>CLAUDE.md</code> · нет GitHub remote — патч внутри</summary>");
		expect(md).toContain("```diff\n- a\n+ b\n```");
		expect(md).not.toContain("`AGENTS.md`\n\n```diff");
	});

	it("drops details, least useful first, to fit a limit", () => {
		const ev = [{ s: "01a17911-aaaa", e: ["e1"], date: "2026-10-26" }];
		const big = data({
			items: Array.from({ length: 40 }, (_, i) =>
				item({ id: `m-${String(i).padStart(6, "0")}`, title: `n${i}`, body: "x".repeat(200), why: ["y".repeat(100)], evidence: ev }),
			),
		});
		const full = renderPrBody(big, { limit: 1e9 });
		expect(full).toContain("«Сборка эмодзи» `01a17911`");
		expect(full).toContain("**Обработанные сессии**");
		const noTable = renderPrBody(big, { limit: full.length - 1 });
		expect(noTable).toContain("Описание сокращено");
		expect(noTable).not.toContain("**Обработанные сессии**");
		expect(noTable).toContain("«Сборка эмодзи» `01a17911`");
		const noTitles = renderPrBody(big, { limit: noTable.length - 1 });
		expect(noTitles).toContain("- **Сессии:** 26.10 `01a17911`");
		expect(noTitles).toContain("- **Зачем:** yyy");
		const lines = renderPrBody(big, { limit: 8000 });
		expect(lines.length).toBeLessThanOrEqual(8000);
		expect(lines).toContain("- ➕ <b>n0</b> · <code>m-000000</code>");
	});

	it("says when nothing changed", () => {
		expect(renderPrBody(data())).toContain("_Изменений памяти нет._");
	});

	it("speaks English when asked", () => {
		const en = renderPrBody(data({ language: "English", items: [item({ id: "m-000001", title: "N", index: "pointer" })] }));
		expect(en).toContain("**➕ New: 1**");
		expect(en).toContain("<i>on demand</i>");
	});
});

describe("renderReport", () => {
	it("keeps every detail of one dream, with a heading", () => {
		const md = renderReport(data({ items: [item({ id: "m-000001", title: "N", check: { verdict: "partial", reason: "cut a claim", corrected: true } })] }));
		expect(md.split("\n").slice(0, 3)).toEqual(["<!-- pi-dream:report -->", "# Сон 2026-11-08 21:41", ""]);
		expect(md).toContain("- **Проверка:** уточнено проверяющим — cut a claim");
	});
});

describe("renderRunComment", () => {
	it("says what this dream changed and links its report", () => {
		const c = renderRunComment(data({ items: [item({ id: "m-000001", title: "N" }), item({ kind: "updated", id: "m-000002", title: "U" })] }), {
			updated: true,
			reportUrl: "https://github.com/o/mem/blob/abc/reports/r.md",
		});
		expect(c.startsWith("<!-- pi-dream:report -->\n**Сон 2026-11-08 21:41:** ➕ Новые: 1 · ✏️ Изменены: 1")).toBe(true);
		expect(c).toContain("Описание PR обновлено. [Полный отчёт этого сна](https://github.com/o/mem/blob/abc/reports/r.md).");
		expect(c).toContain("- ➕ <b>N</b> · <code>m-000001</code>");
	});
});

describe("prTitle", () => {
	it("counts the changes", () => {
		const d = data({
			items: [item({}), item({}), item({ kind: "moved" }), item({ kind: "superseded" }), item({ kind: "merged" }), item({ kind: "removed" })],
			agents: [{ project: "p", rel: "AGENTS.md", patch: "", rationale: [] }],
		});
		expect(prTitle(d, "2026-11-07")).toBe("pi-dream 2026-11-07: +2 ~1 ⇄1 −1 ✓1 AGENTS.md 1");
		expect(prTitle(data())).toBe("pi-dream 2026-11-08: review");
	});
});
