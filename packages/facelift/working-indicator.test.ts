/**
 * Tests for the still working indicator: on `session_start` facelift
 * replaces pi's 80ms braille spinner with a single accent `●` frame (a
 * single frame starts no animation timer), unless the config asks for
 * the animated default (`animateWorkingIndicator: true`).
 *
 * The extension reads its config from `${PI_AGENT_DIR}/wierd-facelift/`,
 * so each test points PI_AGENT_DIR at a temp dir with the config it needs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

let dir: string;
let savedAgentDir: string | undefined;
let savedAnimate: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "facelift-indicator-"));
	savedAgentDir = process.env.PI_AGENT_DIR;
	savedAnimate = process.env.FACELIFT_ANIMATE_WORKING;
	process.env.PI_AGENT_DIR = dir;
	delete process.env.FACELIFT_ANIMATE_WORKING;
});

afterEach(() => {
	if (savedAgentDir !== undefined) process.env.PI_AGENT_DIR = savedAgentDir;
	else delete process.env.PI_AGENT_DIR;
	if (savedAnimate !== undefined) process.env.FACELIFT_ANIMATE_WORKING = savedAnimate;
	else delete process.env.FACELIFT_ANIMATE_WORKING;
	rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>) {
	mkdirSync(join(dir, "wierd-facelift"), { recursive: true });
	writeFileSync(join(dir, "wierd-facelift", "config.json"), JSON.stringify(config));
}

function loadExtension(ui: Record<string, unknown> = {}, hasUI = true) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (name: string, h: (event: unknown, ctx: unknown) => void) => handlers.set(name, h),
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	};
	piFaceliftExtension(pi as any, {
		sdk: {
			createReadToolDefinition: (_cwd: string) => ({
				name: "mock",
				description: "mock",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "" }] }),
			}),
			getAgentDir: () => dir,
		},
		TextComponent: MockText as any,
	});
	const setWorkingIndicator = vi.fn();
	const ctx = {
		hasUI,
		ui: {
			setWorkingMessage: vi.fn(),
			setWorkingIndicator,
			theme: { fg: (token: string, text: string) => `<${token}>${text}</${token}>` },
			...ui,
		},
	};
	const fire = (name: string) => handlers.get(name)?.({}, ctx);
	return { fire, setWorkingIndicator, ctx };
}

describe("working indicator", () => {
	it("sets a single still accent frame on session_start by default", () => {
		const { fire, setWorkingIndicator } = loadExtension();
		fire("session_start");
		expect(setWorkingIndicator).toHaveBeenCalledTimes(1);
		expect(setWorkingIndicator).toHaveBeenCalledWith({ frames: ["<accent>●</accent>"] });
	});

	it("keeps an older config file (no field) on the still indicator", () => {
		writeConfig({ diffLayout: "split" });
		const { fire, setWorkingIndicator } = loadExtension();
		fire("session_start");
		expect(setWorkingIndicator).toHaveBeenCalledWith({ frames: ["<accent>●</accent>"] });
	});

	it("restores pi's animated default when animateWorkingIndicator is on", () => {
		writeConfig({ diffLayout: "split", animateWorkingIndicator: true });
		const { fire, setWorkingIndicator } = loadExtension();
		fire("session_start");
		expect(setWorkingIndicator).toHaveBeenCalledTimes(1);
		expect(setWorkingIndicator).toHaveBeenCalledWith();
	});

	it("does nothing without a UI (pi -p, RPC)", () => {
		const { fire, setWorkingIndicator } = loadExtension({}, false);
		fire("session_start");
		expect(setWorkingIndicator).not.toHaveBeenCalled();
	});

	it("tolerates a pi without setWorkingIndicator", () => {
		const { fire } = loadExtension({ setWorkingIndicator: undefined });
		expect(() => fire("session_start")).not.toThrow();
	});

	it("swallows a stale ctx instead of crashing pi", () => {
		const { fire } = loadExtension({
			setWorkingIndicator: () => {
				throw new Error("extension ctx is stale");
			},
		});
		expect(() => fire("session_start")).not.toThrow();
	});
});
