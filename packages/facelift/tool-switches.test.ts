/**
 * `tools` in the config decides which built-in tools facelift replaces:
 * a tool switched off is never registered, so pi keeps its own (and
 * another extension may replace it without a conflict).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACELIFT_TOOLS } from "./config.ts";
import piFaceliftExtension from "./index.ts";

class MockText {
	constructor(
		private text = "",
		_x = 0,
		_y = 0,
	) {}
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
}

const factory = (_cwd: string) => ({
	name: "mock",
	description: "mock",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "" }] }),
});

let dir: string;
let savedAgentDir: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "facelift-tools-"));
	savedAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = dir;
});

afterEach(() => {
	if (savedAgentDir !== undefined) process.env.PI_AGENT_DIR = savedAgentDir;
	else delete process.env.PI_AGENT_DIR;
	rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>) {
	mkdirSync(join(dir, "wierd-facelift"), { recursive: true });
	writeFileSync(join(dir, "wierd-facelift", "config.json"), JSON.stringify(config));
}

function registeredTools(): string[] {
	const names: string[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => names.push(tool.name),
		registerCommand: () => {},
		on: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	};
	piFaceliftExtension(pi as any, {
		sdk: {
			createReadToolDefinition: factory,
			createBashToolDefinition: factory,
			createLsToolDefinition: factory,
			createFindToolDefinition: factory,
			createGrepToolDefinition: factory,
			createWriteToolDefinition: factory,
			createEditToolDefinition: factory,
			getAgentDir: () => dir,
		} as any,
		TextComponent: MockText as any,
	});
	return names;
}

describe("tool switches", () => {
	it("replaces every tool by default", () => {
		expect(registeredTools().sort()).toEqual([...FACELIFT_TOOLS].sort());
	});

	it("keeps an older config file (no tools) replacing every tool", () => {
		writeConfig({ diffLayout: "split" });
		expect(registeredTools().sort()).toEqual([...FACELIFT_TOOLS].sort());
	});

	it("leaves a tool switched off to pi", () => {
		writeConfig({ tools: { bash: false } });
		expect(registeredTools().sort()).toEqual(FACELIFT_TOOLS.filter((t) => t !== "bash").sort());
	});

	it("can leave every tool to pi", () => {
		writeConfig({ tools: Object.fromEntries(FACELIFT_TOOLS.map((t) => [t, false])) });
		expect(registeredTools()).toEqual([]);
	});
});
