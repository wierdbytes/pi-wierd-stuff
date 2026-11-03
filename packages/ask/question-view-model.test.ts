import assert from "node:assert/strict";
import { test } from "vitest";
import { createInitialState } from "./state/create.ts";
import { getRenderableOptions } from "./state/selectors.ts";
import {
	applyNumberShortcut,
	enterQuestionNoteMode,
	submitCustomAnswer,
} from "./state/transitions.ts";
import { buildQuestionScreenModel } from "./ui/view-models/question.ts";

function buildContext(state: ReturnType<typeof createInitialState>) {
	return {
		editor: {
			getText() {
				return "";
			},
			render() {
				return [];
			},
		} as never,
		lines: [],
		options: getRenderableOptions(state.questions[0]),
		question: state.questions[0],
		state,
		theme: {
			fg(_color: string, text: string) {
				return text;
			},
			bg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		} as never,
		width: 80,
	};
}

test("question view model marks active custom option as inline editor", () => {
	let state = createInitialState({
		questions: [
			{
				id: "q1",
				prompt: "Pick one",
				options: [{ value: "a", label: "A" }],
			},
		],
	});
	state = applyNumberShortcut(state, 2);

	const model = buildQuestionScreenModel(buildContext(state));
	assert.equal(model.mode, "standard");
	assert.equal(model.rows[1]?.detail?.kind, "editor");
	assert.equal(model.rows[1]?.detail?.placeholder, "Type answer...");
});

test("question view model marks multi custom answer as checked", () => {
	let state = createInitialState({
		questions: [
			{
				id: "q1",
				prompt: "Pick many",
				type: "multi",
				options: [{ value: "a", label: "A" }],
			},
		],
	});
	state = applyNumberShortcut(state, 2);
	state = submitCustomAnswer(state, "Other answer");

	const model = buildQuestionScreenModel(buildContext(state));
	assert.equal(model.rows[1]?.prefix, "[x] ");
	assert.equal(model.rows[1]?.color, "success");
	assert.equal(model.rows[1]?.detail?.kind, "custom-text");
});

test("question view model exposes saved question notes", () => {
	let state = enterQuestionNoteMode(
		createInitialState({
			questions: [
				{
					id: "q1",
					prompt: "Question?",
					options: [{ value: "a", label: "A" }],
				},
			],
		}),
		"q1"
	);
	state = {
		...state,
		view: { kind: "navigate" },
		answers: { q1: { selected: [], note: "saved" } },
	};

	const model = buildQuestionScreenModel(buildContext(state));
	assert.deepEqual(model.questionNote, { kind: "saved", text: "saved" });
});

test("preview view model selects stacked vs custom layouts", () => {
	const base = createInitialState({
		questions: [
			{
				id: "q1",
				prompt: "Pick one",
				type: "preview",
				options: [{ value: "a", label: "A", preview: "Preview A" }],
			},
		],
	});

	const stacked = buildQuestionScreenModel(buildContext(base));
	assert.equal(stacked.mode, "preview");
	assert.equal(stacked.previewLayout, "stacked");

	const custom = buildQuestionScreenModel(
		buildContext({
			...base,
			activeOptionIndex: 1,
			view: { kind: "input", questionId: "q1" },
		})
	);
	assert.equal(custom.previewLayout, "custom");
});
