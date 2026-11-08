import { describe, expect, it } from "vitest";
import { Bm25, chunkDigest, snippet, tokenize } from "./search.ts";

describe("search", () => {
	it("stems Russian and English word forms together", () => {
		expect(tokenize("коммита")).toEqual(tokenize("коммит"));
		expect(tokenize("деплоить")[0]).toBe(tokenize("деплой")[0]);
		expect(tokenize("задеплой")).toEqual(expect.arrayContaining(tokenize("деплой")));
		expect(tokenize("контекст")).not.toEqual(tokenize("контроль"));
		expect(tokenize("deploys deploying")).toEqual(["deploy", "deploy"]);
		expect(tokenize("и в на the a")).toEqual([]);
	});

	it("ranks the relevant document first", () => {
		const bm = new Bm25([
			{ id: "1", text: "добавь изменения в chezmoi без коммита", meta: 1 },
			{ id: "2", text: "задеплой на тестовый стенд", meta: 2 },
			{ id: "3", text: "tell me a joke", meta: 3 },
		]);
		expect(bm.search("chezmoi коммит", 3)[0].doc.id).toBe("1");
		expect(bm.search("деплой на тест", 3)[0].doc.id).toBe("2");
		expect(bm.search("nothing matches here", 3)).toEqual([]);
		expect(bm.search("chezmoi", 3, (d) => d.id !== "1")).toEqual([]);
	});

	it("chunks digests at entry lines and finds snippets", () => {
		const lines = ["header line"];
		for (let i = 0; i < 40; i++) lines.push(`[${String(i).padStart(8, "0")}] USER: message ${i} ${"x".repeat(100)}`);
		const chunks = chunkDigest(lines.join("\n"), 1000);
		expect(chunks.length).toBeGreaterThan(3);
		expect(chunks[1].entryId).toMatch(/^\d{8}$/);
		expect(snippet("a\nb deploy here\nc", "deploy", 50)).toContain("deploy here");
	});
});
