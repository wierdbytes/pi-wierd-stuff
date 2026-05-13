/**
 * Round-trip tests for @wierdbytes/pi-facelift's persistent config.
 *
 * Mirrors the contract enforced by packages/voice/config.test.ts and
 * packages/web/config.test.ts:
 *
 *   • `envDefaults()` honours the DIFF_LAYOUT env var when valid, falls
 *     back to "consistent" otherwise.
 *   • `sanitize()` (via `loadConfig`) drops unknown / malformed fields
 *     instead of throwing.
 *   • `saveConfig` + `loadConfig` round-trip every valid layout value
 *     through disk without mutation.
 *   • `loadOrInitConfig` seeds a missing file from env defaults and
 *     writes it to disk.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	envDefaults,
	loadConfig,
	loadOrInitConfig,
	saveConfig,
	VALID_DIFF_LAYOUTS,
	type WierdFaceliftConfig,
} from "./config.ts";

let dir: string;
let configFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "facelift-config-"));
	configFile = join(dir, "config.json");
	savedEnv.DIFF_LAYOUT = process.env.DIFF_LAYOUT;
	delete process.env.DIFF_LAYOUT;
});

afterEach(() => {
	if (savedEnv.DIFF_LAYOUT !== undefined) process.env.DIFF_LAYOUT = savedEnv.DIFF_LAYOUT;
	else delete process.env.DIFF_LAYOUT;
	rmSync(dir, { recursive: true, force: true });
});

describe("envDefaults", () => {
	it("returns 'consistent' when DIFF_LAYOUT is unset", () => {
		expect(envDefaults()).toEqual({ diffLayout: "consistent" });
	});

	for (const layout of VALID_DIFF_LAYOUTS) {
		it(`honours DIFF_LAYOUT=${layout}`, () => {
			process.env.DIFF_LAYOUT = layout;
			expect(envDefaults()).toEqual({ diffLayout: layout });
		});
	}

	it("ignores invalid DIFF_LAYOUT values", () => {
		process.env.DIFF_LAYOUT = "rainbow";
		expect(envDefaults()).toEqual({ diffLayout: "consistent" });
	});

	it("is case-insensitive on DIFF_LAYOUT", () => {
		process.env.DIFF_LAYOUT = "SPLIT";
		expect(envDefaults()).toEqual({ diffLayout: "split" });
	});
});

describe("loadConfig + saveConfig round-trip", () => {
	for (const layout of VALID_DIFF_LAYOUTS) {
		it(`persists diffLayout=${layout}`, () => {
			saveConfig({ diffLayout: layout } as WierdFaceliftConfig, configFile);
			expect(existsSync(configFile)).toBe(true);
			expect(loadConfig(configFile)).toEqual({ diffLayout: layout });
		});
	}

	it("sanitises unknown fields back to defaults", () => {
		writeFileSync(
			configFile,
			JSON.stringify({ diffLayout: "consistent", iconMode: "rainbow", junk: 42 }),
		);
		expect(loadConfig(configFile)).toEqual({ diffLayout: "consistent" });
	});

	it("rejects invalid diffLayout strings and falls back to default", () => {
		writeFileSync(configFile, JSON.stringify({ diffLayout: "tutti-frutti" }));
		expect(loadConfig(configFile)).toEqual({ diffLayout: "consistent" });
	});

	it("returns defaults when the file is missing (no write)", () => {
		expect(existsSync(configFile)).toBe(false);
		expect(loadConfig(configFile)).toEqual({ diffLayout: "consistent" });
		expect(existsSync(configFile)).toBe(false);
	});

	it("returns defaults when the file is malformed JSON", () => {
		writeFileSync(configFile, "{ not valid json");
		expect(loadConfig(configFile)).toEqual({ diffLayout: "consistent" });
	});

	it("writes a trailing newline", () => {
		saveConfig({ diffLayout: "split" } as WierdFaceliftConfig, configFile);
		expect(readFileSync(configFile, "utf-8").endsWith("\n")).toBe(true);
	});
});

describe("loadOrInitConfig", () => {
	it("seeds a missing file from env defaults", () => {
		expect(existsSync(configFile)).toBe(false);
		const cfg = loadOrInitConfig(configFile);
		expect(cfg).toEqual({ diffLayout: "consistent" });
		expect(existsSync(configFile)).toBe(true);
		expect(JSON.parse(readFileSync(configFile, "utf-8"))).toEqual({ diffLayout: "consistent" });
	});

	it("respects DIFF_LAYOUT when seeding", () => {
		process.env.DIFF_LAYOUT = "unified";
		const cfg = loadOrInitConfig(configFile);
		expect(cfg).toEqual({ diffLayout: "unified" });
		expect(JSON.parse(readFileSync(configFile, "utf-8"))).toEqual({ diffLayout: "unified" });
	});

	it("does not overwrite an existing file", () => {
		writeFileSync(configFile, JSON.stringify({ diffLayout: "split" }));
		process.env.DIFF_LAYOUT = "unified"; // would override on a fresh seed
		const cfg = loadOrInitConfig(configFile);
		expect(cfg).toEqual({ diffLayout: "split" });
	});
});
