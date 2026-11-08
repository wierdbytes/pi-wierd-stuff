import { describe, expect, it } from "vitest";
import { buildIndex, estimateTokens, indexBody, indexIds, renderInjection } from "./memindex.ts";
import type { Note } from "./notes.ts";

function note(id: string, title: string, over: Partial<Note> = {}): Note {
	return {
		id,
		title,
		type: "fact",
		status: "active",
		index: "always",
		created: "2026-11-01",
		updated: "2026-11-01",
		stats: { helpful: 0, harmful: 0 },
		evidence: [{ s: "s1", e: ["e1"] }],
		body: "",
		file: `scopes/global/notes/${id}.md`,
		scope: "global",
		extra: {},
		problems: [],
		...over,
	};
}

describe("index", () => {
	it("lists always lines before pointers and skips inactive notes", () => {
		const res = buildIndex(
			[
				note("m-000001", "Pointer note", { index: "pointer", when: "when deploying" }),
				note("m-000002", "Always note"),
				note("m-000003", "Old", { status: "superseded" }),
				note("m-000004", "Hidden", { index: "none" }),
			],
			"global",
			1000,
		);
		expect(res.included).toEqual(["m-000002", "m-000001"]);
		expect(res.text).toContain("## Always\n- Always note [m-000002]");
		expect(res.text).toContain("- when deploying → [m-000001] Pointer note");
		expect(res.text).not.toContain("Old");
		expect(res.text).not.toContain("Hidden");
	});

	it("orders by evidence and pins, and drops what is over budget", () => {
		const many = Array.from({ length: 50 }, (_, i) => note(`m-${String(i).padStart(6, "0")}`, `Note number ${i} with some words to cost tokens`));
		many[49].pinned = true;
		many[10].evidence.push({ s: "s2", e: ["x"] }, { s: "s3", e: ["y"] });
		const res = buildIndex(many, "global", 120);
		expect(res.included[0]).toBe("m-000049");
		expect(res.included[1]).toBe("m-000010");
		expect(res.dropped.length).toBeGreaterThan(0);
		expect(res.tokens).toBeLessThanOrEqual(130);
		expect(res.text).toContain("more notes over budget");
	});

	it("extracts the injectable body and ids", () => {
		const res = buildIndex([note("m-abcdef", "Hello")], "global", 500);
		const body = indexBody(res.text);
		expect(body.startsWith("## Always")).toBe(true);
		expect(indexIds(body)).toEqual(["m-abcdef"]);
		expect(indexBody(buildIndex([], "global", 500).text)).toBe("");
	});

	it("renders the injection only when there is something to inject", () => {
		expect(renderInjection({ maxTokens: 1000 })).toBeUndefined();
		const t = renderInjection({ memver: "abc1234", global: "## Always\n- A [m-000001]", project: { key: "github.com/o/r", body: "## Always\n- B [m-000002]" }, maxTokens: 1000 });
		expect(t).toContain("memory abc1234");
		expect(t).toContain("## Global (all projects)");
		expect(t).toContain("## Project github.com/o/r");
		const capped = renderInjection({ global: Array.from({ length: 200 }, (_, i) => `- line ${i} [m-00000${i % 9}]`).join("\n"), maxTokens: 100 });
		expect(estimateTokens(capped ?? "")).toBeLessThanOrEqual(120);
		expect(capped).toContain("truncated");
	});
});
