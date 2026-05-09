/**
 * Regression tests for Shiki theme resolution.
 *
 * Background: pi's `~/.pi/agent/settings.json` `theme` field is consumed
 * by the host UI and may carry names that aren't valid Shiki bundled
 * themes (e.g. `tokyo-night-storm`). Before this regression net,
 * `pi-facelift` passed the raw value straight to Shiki's `codeToANSI`,
 * which threw, and `hlBlock`'s `catch` block silently fell back to
 * uncolored text — leaving every `read` body in plain whitish output
 * with no obvious error.
 *
 * These tests pin three guarantees:
 *   1. Bundled themes pass through untouched.
 *   2. Common pi/host theme names are aliased to their nearest Shiki
 *      bundled equivalent (case-insensitive).
 *   3. Unknown / empty / whitespace-only theme names fall back to
 *      `DEFAULT_THEME` and emit a one-shot console.error so silent
 *      regressions are visible during dev.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledThemes } from "shiki";

import { __hlInternals, __themeInternals } from "./index.ts";

const { DEFAULT_THEME, THEME_ALIASES, isBundledTheme, resolveBundledTheme, resetWarningsForTests } =
	__themeInternals;

const { hlBlock, resetCacheForTests, resetErrorLogForTests } = __hlInternals;

beforeEach(() => {
	resetWarningsForTests();
});

describe("theme resolution: alias map sanity", () => {
	it("DEFAULT_THEME is a valid Shiki bundled theme", () => {
		expect(isBundledTheme(DEFAULT_THEME)).toBe(true);
	});

	it("every alias value points at a valid Shiki bundled theme", () => {
		for (const [from, to] of Object.entries(THEME_ALIASES)) {
			expect(isBundledTheme(to), `alias ${from} -> ${to} must be bundled`).toBe(true);
		}
	});

	it("alias keys are lowercase (matching the lookup convention)", () => {
		for (const key of Object.keys(THEME_ALIASES)) {
			expect(key).toBe(key.toLowerCase());
		}
	});

	it("does not alias names that are already bundled (would be dead code)", () => {
		for (const key of Object.keys(THEME_ALIASES)) {
			expect(
				Object.prototype.hasOwnProperty.call(bundledThemes, key),
				`alias key "${key}" is already a bundled theme; alias entry is unreachable`,
			).toBe(false);
		}
	});
});

describe("resolveBundledTheme: passthrough + fallbacks", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("returns a bundled theme name unchanged", () => {
		expect(resolveBundledTheme("github-dark")).toBe("github-dark");
		expect(resolveBundledTheme("dracula")).toBe("dracula");
		expect(resolveBundledTheme("nord")).toBe("nord");
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("falls back to DEFAULT_THEME for undefined/empty/whitespace input", () => {
		expect(resolveBundledTheme(undefined)).toBe(DEFAULT_THEME);
		expect(resolveBundledTheme("")).toBe(DEFAULT_THEME);
		expect(resolveBundledTheme("   ")).toBe(DEFAULT_THEME);
		// Empty/whitespace input is the "no theme configured" path — no warning.
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("trims surrounding whitespace before validating", () => {
		expect(resolveBundledTheme("  github-dark  ")).toBe("github-dark");
		expect(errorSpy).not.toHaveBeenCalled();
	});
});

describe("resolveBundledTheme: alias resolution", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	// The original bug report: pi user has `"theme": "tokyo-night-storm"`,
	// Shiki only ships `tokyo-night`.
	it("aliases tokyo-night-storm to tokyo-night (the original bug report)", () => {
		expect(resolveBundledTheme("tokyo-night-storm")).toBe("tokyo-night");
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("aliases other tokyo-night variants", () => {
		expect(resolveBundledTheme("tokyo-night-night")).toBe("tokyo-night");
		expect(resolveBundledTheme("tokyo-night-day")).toBe("tokyo-night");
		expect(resolveBundledTheme("tokyonight")).toBe("tokyo-night");
		expect(resolveBundledTheme("tokyonight-storm")).toBe("tokyo-night");
	});

	it("aliases case-insensitively", () => {
		expect(resolveBundledTheme("Tokyo-Night-Storm")).toBe("tokyo-night");
		expect(resolveBundledTheme("CATPPUCCIN")).toBe("catppuccin-mocha");
		expect(resolveBundledTheme("Material")).toBe("material-theme");
	});

	it("aliases catppuccin family defaults", () => {
		expect(resolveBundledTheme("catppuccin")).toBe("catppuccin-mocha");
	});

	it("aliases gruvbox/material/solarized/one-dark families to canonical variants", () => {
		expect(resolveBundledTheme("gruvbox-dark")).toBe("gruvbox-dark-medium");
		expect(resolveBundledTheme("gruvbox-light")).toBe("gruvbox-light-medium");
		expect(resolveBundledTheme("material")).toBe("material-theme");
		expect(resolveBundledTheme("material-darker")).toBe("material-theme-darker");
		expect(resolveBundledTheme("solarized")).toBe("solarized-dark");
		expect(resolveBundledTheme("one-dark")).toBe("one-dark-pro");
	});
});

describe("resolveBundledTheme: invalid theme warning", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("falls back to DEFAULT_THEME for an unknown name and warns once", () => {
		expect(resolveBundledTheme("not-a-real-theme-9000")).toBe(DEFAULT_THEME);
		expect(errorSpy).toHaveBeenCalledTimes(1);

		const msg = errorSpy.mock.calls[0]?.[0];
		expect(msg).toContain("pi-facelift");
		expect(msg).toContain("not-a-real-theme-9000");
		expect(msg).toContain(DEFAULT_THEME);
		// The warning should advertise FACELIFT_THEME as the fix knob.
		expect(msg).toContain("FACELIFT_THEME");
	});

	it("warns at most once per distinct invalid theme (no per-render spam)", () => {
		expect(resolveBundledTheme("bogus-theme")).toBe(DEFAULT_THEME);
		expect(resolveBundledTheme("bogus-theme")).toBe(DEFAULT_THEME);
		expect(resolveBundledTheme("bogus-theme")).toBe(DEFAULT_THEME);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("warns separately for distinct invalid names", () => {
		expect(resolveBundledTheme("first-bad")).toBe(DEFAULT_THEME);
		expect(resolveBundledTheme("second-bad")).toBe(DEFAULT_THEME);
		expect(errorSpy).toHaveBeenCalledTimes(2);
	});

	it("does NOT warn for names resolved via the alias map", () => {
		// `tokyo-night-storm` is invalid for Shiki but covered by an alias —
		// this is the *fixed* path, not a regression, so it must stay quiet.
		expect(resolveBundledTheme("tokyo-night-storm")).toBe("tokyo-night");
		expect(errorSpy).not.toHaveBeenCalled();
	});
});

describe("hlBlock: Shiki failure logging + plain-text fallback", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		resetCacheForTests();
		resetErrorLogForTests();
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("returns plain split lines when language is missing (no shiki call, no log)", async () => {
		const out = await hlBlock("a\nb\nc", undefined);
		expect(out).toEqual(["a", "b", "c"]);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("returns [''] for empty input", async () => {
		expect(await hlBlock("", "typescript")).toEqual([""]);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("returns ANSI-colored lines for a valid theme + language (sanity)", async () => {
		const out = await hlBlock("const x = 1;", "typescript");
		expect(out.length).toBeGreaterThan(0);
		// Joined output must contain at least one ANSI escape — proof shiki ran.
		expect(out.join("\n")).toMatch(/\x1b\[/);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("falls back to plain split lines when shiki rejects a bogus language, and logs once", async () => {
		// `"definitely-not-a-language"` is not a `BundledLanguage`, but the
		// runtime check in shiki throws synchronously inside the promise.
		// We cast through `unknown` to bypass the compile-time guard — this
		// is the same shape a stale settings.theme value would take if it
		// somehow reached the highlighter.
		const bogusLang = "definitely-not-a-language" as unknown as Parameters<
			typeof hlBlock
		>[1];
		const src = "const x = 1;";

		const out1 = await hlBlock(src, bogusLang);
		expect(out1).toEqual([src]);
		expect(errorSpy).toHaveBeenCalledTimes(1);

		const msg = errorSpy.mock.calls[0]?.[0];
		expect(msg).toContain("pi-facelift");
		expect(msg).toContain("shiki");
		expect(msg).toContain("definitely-not-a-language");

		// Second call with the same (theme, language) tag must NOT re-log.
		// We change the source so the cache key differs and the catch path
		// runs again — still only one log.
		const out2 = await hlBlock("let y = 2;", bogusLang);
		expect(out2).toEqual(["let y = 2;"]);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});
});
