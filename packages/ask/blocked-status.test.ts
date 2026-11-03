import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_ASK_CONFIG } from "./config/defaults.ts";
import { getAskConfigStore } from "./config/store.ts";
import type { AskParams, AskResult } from "./types.ts";
import { getBlockedMessage, runAskFlow } from "./ui/controller.ts";

const QUESTION = {
	id: "decision",
	prompt: "Proceed?",
	options: [
		{ value: "yes", label: "Yes" },
		{ value: "no", label: "No" },
	],
};

function plainTheme() {
	return {
		bg(_color: string, text: string) {
			return text;
		},
		fg(_color: string, text: string) {
			return text;
		},
	};
}

async function captureCustomOptions(params: AskParams): Promise<unknown> {
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	});
	let options: unknown;
	await runAskFlow(
		{
			cwd: process.cwd(),
			mode: "tui",
			ui: {
				custom(callback: (...args: unknown[]) => unknown, opts: unknown) {
					options = opts;
					return new Promise<AskResult>((resolve) => {
						const component = callback(
							{
								requestRender() {
									// Rendering is not needed for this option test.
								},
							},
							plainTheme(),
							{},
							resolve
						) as { handleInput(data: string): void };
						component.handleInput("\x1b");
					});
				},
			},
		} as never,
		params
	);
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
	return options;
}

test("ask flow reports pi as blocked on a question while the form is open", async () => {
	const options = await captureCustomOptions({
		title: "Pick a direction",
		questions: [QUESTION],
	});

	assert.deepEqual(options, {
		blocked: { kind: "question", message: "Pick a direction" },
	});
});

test("blocked message falls back to the first prompt, then a generic text", () => {
	assert.equal(getBlockedMessage({ questions: [QUESTION] }), "Proceed?");
	assert.equal(
		getBlockedMessage({ title: "  ", questions: [{ ...QUESTION, prompt: " " }] }),
		"Waiting for your answer"
	);
});
