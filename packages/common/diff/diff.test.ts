/**
 * Smoke tests for the @wierdbytes/pi-common/diff renderer.
 *
 * These tests focus on the public contract that the facelift extension
 * (and any future consumer) relies on:
 *
 *   • `parseDiff` produces the expected line / add / remove counts and
 *     ordering for trivial cases (pure add, pure remove, single-line
 *     edit, multi-hunk diff with separators).
 *
 *   • `renderSplit` / `renderUnified` honour the `frameless` option so
 *     the diff body slots into an outer frame without doubling up
 *     border rules.
 *
 *   • `summarize` formats `+N -M` correctly.
 *
 *   • `lang` maps file extensions to Shiki language ids.
 *
 * We deliberately avoid asserting exact ANSI byte sequences — Shiki and
 * the theme palette can change those over time. Instead we check
 * structural invariants (line counts, presence/absence of markers,
 * specific text fragments).
 */

import { describe, expect, it } from "vitest";

import {
	__testing,
	applyDiffPalette,
	canRenderSplit,
	lang,
	parseDiff,
	renderSplit,
	renderUnified,
	resolveDiffColors,
	summarize,
} from "./index.ts";

// Make sure the palette is initialised (mirrors the extension boot path).
applyDiffPalette();

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("parseDiff", () => {
	it("returns no diff lines for identical inputs", () => {
		const d = parseDiff("a\nb\nc\n", "a\nb\nc\n");
		expect(d.added).toBe(0);
		expect(d.removed).toBe(0);
		expect(d.lines).toEqual([]);
	});

	it("captures a single-line replacement", () => {
		const d = parseDiff("hello world\n", "hello there\n");
		expect(d.added).toBe(1);
		expect(d.removed).toBe(1);
		const types = d.lines.map((l) => l.type);
		expect(types).toContain("del");
		expect(types).toContain("add");
	});

	it("captures a multi-line addition", () => {
		const oldText = "a\nb\nc\n";
		const newText = "a\nb\nx\ny\nc\n";
		const d = parseDiff(oldText, newText);
		expect(d.added).toBe(2);
		expect(d.removed).toBe(0);
		const addLines = d.lines.filter((l) => l.type === "add").map((l) => l.content);
		expect(addLines).toEqual(["x", "y"]);
	});

	it("emits hunk separators between distant hunks", () => {
		const oldText = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11"].join("\n");
		const newText = ["A1!", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11!"].join("\n");
		const d = parseDiff(oldText, newText, 1);
		const types = d.lines.map((l) => l.type);
		expect(types).toContain("sep");
		expect(d.added).toBe(2);
		expect(d.removed).toBe(2);
	});
});

describe("summarize", () => {
	it("renders +N -M when both sides change", () => {
		const out = stripAnsi(summarize(3, 5));
		expect(out).toBe("+3 -5");
	});

	it("renders only +N when nothing is removed", () => {
		expect(stripAnsi(summarize(7, 0))).toBe("+7");
	});

	it("renders 'no changes' when nothing changed", () => {
		expect(stripAnsi(summarize(0, 0))).toBe("no changes");
	});
});

describe("lang", () => {
	it("maps known extensions", () => {
		expect(lang("foo.ts")).toBe("typescript");
		expect(lang("foo.tsx")).toBe("tsx");
		expect(lang("foo.go")).toBe("go");
		expect(lang("foo.rs")).toBe("rust");
	});

	it("returns undefined for unknown extensions", () => {
		expect(lang("foo.unknownext")).toBeUndefined();
		expect(lang("noext")).toBeUndefined();
	});
});

describe("renderUnified", () => {
	it("returns empty string for an empty diff", async () => {
		const out = await renderUnified(parseDiff("", ""), undefined, 50);
		expect(out).toBe("");
	});

	it("renders the diff body with frame rules by default", async () => {
		const diff = parseDiff("a\nb\nc\n", "a\nB\nc\n");
		const out = await renderUnified(diff, undefined, 50, undefined, 80);
		const plain = stripAnsi(out);
		const ruleLine = "─".repeat(80);
		// First and last visible rows should be rule lines.
		const lines = plain.split("\n");
		expect(lines[0]).toBe(ruleLine);
		expect(lines[lines.length - 1]).toBe(ruleLine);
	});

	it("omits frame rules when frameless: true", async () => {
		const diff = parseDiff("a\nb\nc\n", "a\nB\nc\n");
		const out = await renderUnified(diff, undefined, 50, undefined, 80, { frameless: true });
		const plain = stripAnsi(out);
		const ruleLine = "─".repeat(80);
		expect(plain.split("\n")[0]).not.toBe(ruleLine);
	});

	it("includes both deletion and addition markers", async () => {
		const diff = parseDiff("foo\n", "bar\n");
		const out = await renderUnified(diff, undefined, 50, undefined, 80, { frameless: true });
		const plain = stripAnsi(out);
		expect(plain).toContain("-");
		expect(plain).toContain("+");
		expect(plain).toMatch(/foo/);
		expect(plain).toMatch(/bar/);
	});
});

describe("layout overrides", () => {
	it("canRenderSplit returns true for short content at wide widths", () => {
		const small = parseDiff("hello\n", "world\n");
		expect(canRenderSplit(small, 200, 50)).toBe(true);
	});

	it("canRenderSplit returns false when a diff would wrap excessively in split", () => {
		// One very long line — ~300 chars — forces wrap in a 100-col half.
		const long = "x".repeat(300);
		const wide = parseDiff(`${long}\n`, `${long}y\n`);
		expect(canRenderSplit(wide, 200, 50)).toBe(false);
	});

	it("renderSplit honours `layout: 'unified'` even when the diff would fit split", async () => {
		const diff = parseDiff("hello\n", "world\n");
		const out = await renderSplit(diff, undefined, 50, undefined, 200, {
			frameless: true,
			layout: "unified",
		});
		const plain = stripAnsi(out);
		// Unified → one source line per row, NOT both halves on the same row.
		const hasPaired = plain.split("\n").some((line) => /hello[\s\S]*world/.test(line));
		expect(hasPaired).toBe(false);
		// And both `hello` / `world` should still appear in the output (each
		// on its own row).
		expect(plain).toMatch(/hello/);
		expect(plain).toMatch(/world/);
	});

	it("renderSplit honours `layout: 'split'` even when the diff would normally wrap", async () => {
		const long = "x".repeat(300);
		const diff = parseDiff(`${long}\n`, `${long}y\n`);
		const out = await renderSplit(diff, undefined, 50, undefined, 200, {
			frameless: true,
			layout: "split",
		});
		const plain = stripAnsi(out);
		// Forced split: at least one row pairs `x...` on both sides.
		const pairedRow = plain.split("\n").find((line) => (line.match(/x/g) ?? []).length >= 100);
		expect(pairedRow, "expected forced-split row").toBeTruthy();
	});
});

describe("renderSplit", () => {
	it("falls back to unified on narrow terminals", async () => {
		const diff = parseDiff("a\nb\nc\n", "a\nB\nc\n");
		// width 80 < SPLIT_MIN_WIDTH (150) → unified.
		const out = await renderSplit(diff, undefined, 50, undefined, 80, { frameless: true });
		const plain = stripAnsi(out);
		// Unified emits one source line per visual row. There is no left-vs-right
		// split, so a context line ('a' or 'c') should appear only once on its
		// row — not twice as it would in a side-by-side view.
		const contextRow = plain.split("\n").find((line) => /\ba\b/.test(line));
		expect(contextRow, "expected a unified row containing the context line").toBeTruthy();
		const occurrences = (contextRow ?? "").match(/\ba\b/g) ?? [];
		expect(occurrences.length).toBe(1);
	});

	it("renders side-by-side when given a wide terminal", async () => {
		const diff = parseDiff("hello\n", "world\n");
		const out = await renderSplit(diff, undefined, 50, undefined, 200, { frameless: true });
		const plain = stripAnsi(out);
		// Split rows place the deleted line on the left half and the added line on
		// the right half. Both should appear on the same visual row, with `hello`
		// preceding `world`.
		const pairedRow = plain.split("\n").find((line) => /hello[\s\S]*world/.test(line));
		expect(pairedRow, "expected one row carrying both halves side by side").toBeTruthy();
	});

	it("emits no `│` / `▌` column chrome (GitHub-style layout)", async () => {
		const diff = parseDiff("alpha\nbeta\n", "alpha\nBETA\n");
		const out = await renderSplit(diff, undefined, 50, undefined, 200, { frameless: true });
		const plain = stripAnsi(out);
		expect(plain).not.toContain("│");
		expect(plain).not.toContain("▌");
		expect(plain).not.toContain("┊");
	});
});

describe("frame-friendly output (no BG leak past the trailing newline)", () => {
	// Regression: an earlier version redefined `RST` to `\x1b[0m<BG_BASE>` so
	// every reset re-applied the auto-derived toolSuccessBg. That bg leaked
	// past the diff's trailing newline into the next line rendered by the
	// caller (e.g. the closing `╰──…` of an outer frame), painting it in a
	// different bg from the opening `╭──…`. Lock the contract that every line
	// of the rendered body ends with a plain reset — no trailing bg state.

	const tintingTheme = {
		fg: (_k: string, t: string) => t,
		bold: (t: string) => t,
		getFgAnsi: (k: string) =>
			k === "toolDiffAdded"
				? "\x1b[38;2;100;180;120m"
				: k === "toolDiffRemoved"
					? "\x1b[38;2;200;100;100m"
					: "",
		// Force a non-default toolSuccessBg so the regression would actually
		// be observable if RST started leaking it again.
		getBgAnsi: (k: string) => (k === "toolSuccessBg" ? "\x1b[48;2;30;40;60m" : "\x1b[49m"),
	};

	it("renderSplit terminates every body line with a clean reset", async () => {
		__testing.resetCachesForTests?.();
		const diff = parseDiff("alpha\nbeta\n", "alpha\nBETA\n");
		const body = await renderSplit(diff, undefined, 50, undefined, 200, { frameless: true });
		const lines = body.split("\n");
		for (const line of lines) {
			// Bare `\x1b[0m` (no immediately-following `\x1b[48;...` re-applying
			// BG_BASE) must be the last ANSI escape on every line.
			const lastReset = line.lastIndexOf("\x1b[0m");
			expect(lastReset, `line missing trailing reset: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
			const tail = line.slice(lastReset);
			expect(tail, `bg leaks past reset on: ${JSON.stringify(line)}`).not.toMatch(/\x1b\[48;/);
		}
	});

	it("renderSplit does not bake BG_BASE into the module-level RST after auto-derive", async () => {
		// Drive the auto-derive path with a non-default toolSuccessBg, then
		// inspect the module's RST. If a future refactor re-introduces
		// `RST = \x1b[0m + BG_BASE`, this test fails immediately.
		__testing.resetCachesForTests?.();
		const diff = parseDiff("x\n", "y\n");
		await renderSplit(
			diff,
			undefined,
			10,
			resolveDiffColors(tintingTheme as never),
			200,
			{ frameless: true },
		);
		const { RST: rst, BG_BASE: bgBase } = __testing.getState();
		expect(rst).toBe("\x1b[0m");
		expect(bgBase).toMatch(/\x1b\[48;2;30;40;60m/);
	});
});

describe("__testing helpers", () => {
	it("computes word diff ranges + similarity", () => {
		const wd = __testing.wordDiffAnalysis("hello world", "hello brave world");
		expect(wd.similarity).toBeGreaterThan(0);
		expect(wd.newRanges.length).toBeGreaterThan(0);
	});

	it("normalizes low-contrast Shiki fg into FG_SAFE_MUTED", () => {
		const input = "\x1b[30mblack\x1b[0m";
		const out = __testing.normalizeShikiContrast(input);
		expect(out).not.toBe(input);
		expect(out).toContain("\x1b[38;2;");
	});
});
