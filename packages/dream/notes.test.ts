import { describe, expect, it } from "vitest";
import { evidenceTime, isNoteId, isoMinute, newNoteId, type Note, parseNote, serializeNote, slugify, uuidV7Time } from "./notes.ts";

const base: Note = {
	id: "m-7f3a2c",
	title: 'Dotfiles: изменения → chezmoi без коммита, "кавычки": ок',
	type: "procedure",
	status: "active",
	index: "always",
	when: "изменение конфигов",
	created: "2026-11-08",
	updated: "2026-11-09",
	stats: { helpful: 2, harmful: 0 },
	evidence: [{ s: "01a1b877-aadb-72ef-98c9-08d1cf74eeff", e: ["a1b2c3d4"], date: "2026-11-06", kind: "user" }],
	body: "Подробности: `chezmoi add <path>`; коммит — только по просьбе.",
	file: "scopes/global/notes/dotfiles.md",
	scope: "global",
	extra: { custom: { a: 1 } },
	problems: [],
};

describe("notes", () => {
	it("round-trips through the file format", () => {
		const text = serializeNote(base);
		const back = parseNote(text, base.file, base.scope);
		expect(back.problems).toEqual([]);
		expect(back).toMatchObject({
			id: base.id,
			title: base.title,
			type: "procedure",
			status: "active",
			index: "always",
			when: base.when,
			created: "2026-11-08",
			updated: "2026-11-09",
			stats: { helpful: 2, harmful: 0 },
			body: base.body,
			extra: { custom: { a: 1 } },
		});
		expect(back.evidence).toEqual(base.evidence);
	});

	it("loads a hand-written note leniently", () => {
		const n = parseNote("---\ntitle: Use pnpm\ntype: bogus\n---\nAlways pnpm.\n", "x.md", "global");
		expect(n.id).toBe("");
		expect(n.problems).toContain("missing or invalid id");
		expect(n.type).toBe("fact");
		expect(n.index).toBe("none");
		expect(n.title).toBe("Use pnpm");
	});

	it("takes the title from the body when front matter has none", () => {
		const n = parseNote("# Heading here\n\nmore", "x.md", "global");
		expect(n.title).toBe("Heading here");
	});

	it("slugifies Cyrillic and long titles", () => {
		expect(slugify("Dotfiles → chezmoi без коммита")).toBe("dotfiles-chezmoi-bez-kommita");
		expect(slugify("!!!")).toBe("note");
		expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
	});

	it("keeps the time of the evidence", () => {
		const n = { ...base, evidence: [{ s: "01a19202-e4ab-7629-a42b-a404cab8735b", e: ["74b4b06c"], date: "2026-10-31", at: "2026-10-31T13:52Z", kind: "observed" as const }] };
		const back = parseNote(serializeNote(n), n.file, n.scope);
		expect(back.evidence).toEqual(n.evidence);
		expect(isoMinute("2026-10-31T13:52:41.123Z")).toBe("2026-10-31T13:52Z");
		expect(isoMinute("garbage")).toBeUndefined();
	});

	it("orders evidence by entry time, session start, session id, day", () => {
		// pi session ids are UUIDv7: the first 48 bits are the creation time.
		expect(uuidV7Time("01a19202-e4ab-7629-a42b-a404cab8735b")).toBe(Date.parse("2026-10-31T12:50:25.579Z"));
		expect(uuidV7Time("01a19202-e4ab-4629-a42b-a404cab8735b")).toBeUndefined();
		expect(uuidV7Time("inbox:abc")).toBeUndefined();
		const s = "01a19281-dcb6-75c0-9080-217b869ab2fa";
		expect(evidenceTime({ s, e: [], at: "2026-10-31T16:30Z" })).toBe(Date.parse("2026-10-31T16:30Z"));
		expect(evidenceTime({ s, e: [] }, () => "2026-10-31T15:09:06.615Z")).toBe(Date.parse("2026-10-31T15:09:06.615Z"));
		expect(evidenceTime({ s, e: [] })).toBe(uuidV7Time(s));
		expect(evidenceTime({ s: "inbox:x", e: [], date: "2026-11-01" })).toBe(Date.parse("2026-11-01"));
		expect(evidenceTime({ s: "pr#3", e: [] })).toBeUndefined();
	});

	it("makes unique ids", () => {
		const taken = new Set<string>();
		for (let i = 0; i < 200; i++) newNoteId(taken);
		expect(taken.size).toBe(200);
		for (const id of taken) expect(isNoteId(id)).toBe(true);
	});
});
