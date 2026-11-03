import assert from "node:assert/strict";
import { test } from "vitest";
import { UI_DIMENSIONS } from "./constants/ui.ts";
import { createInitialState } from "./state/create.ts";
import {
	applyNumberShortcut,
	enterOptionNoteMode,
	enterQuestionNoteMode,
	saveNote,
} from "./state/transitions.ts";
import { renderSubmitScreen } from "./ui/render-submit.ts";

function plainTheme() {
	return {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	} as never;
}

test("submit screen renders the compact action labels without extra prompt copy", () => {
	const state = createInitialState({
		questions: [
			{
				id: "q1",
				label: "Single",
				prompt: "Pick one primary demo style.",
				options: [{ value: "code", label: "Code demo" }],
			},
		],
	});

	const lines: string[] = [];
	renderSubmitScreen(
		lines,
		state,
		plainTheme(),
		UI_DIMENSIONS.submitWideMinWidth + 16
	);

	assert.equal(lines[0], "❯ 1. Submit      Review answers");
	assert.equal(lines[1], "  2. Elaborate  ");
	assert.equal(lines[2], "  3. Cancel      Single");
	assert(!lines.join("\n").includes("Submit answers?"));
	assert(!lines.join("\n").includes("Submit answers"));
});

test("submit screen keeps review and actions grouped side by side on wide screens", () => {
	const state = createInitialState({
		questions: [
			{
				id: "q1",
				label: "Color",
				prompt: "Pick one color.",
				options: [{ value: "blue", label: "Blue" }],
			},
		],
	});

	const lines: string[] = [];
	renderSubmitScreen(
		lines,
		state,
		plainTheme(),
		UI_DIMENSIONS.submitWideMinWidth + 16
	);

	assert.deepEqual(lines, [
		"❯ 1. Submit      Review answers",
		"  2. Elaborate  ",
		"  3. Cancel      Color",
		"                   → unanswered",
	]);
});

test("submit screen stacks review above actions on narrow screens", () => {
	const state = createInitialState({
		questions: [
			{
				id: "q1",
				label: "Color",
				prompt: "Pick one color.",
				options: [{ value: "blue", label: "Blue" }],
			},
		],
	});

	const lines: string[] = [];
	renderSubmitScreen(
		lines,
		state,
		plainTheme(),
		UI_DIMENSIONS.submitWideMinWidth - 14
	);

	assert.deepEqual(lines, [
		" Review answers",
		"",
		" Color",
		"   → unanswered",
		"",
		"❯ 1. Submit",
		"  2. Elaborate",
		"  3. Cancel",
	]);
});

test("submit screen can show a review shortcut hint below the actions", () => {
	const state = createInitialState({
		questions: [
			{
				id: "q1",
				label: "Color",
				prompt: "Pick one color.",
				options: [{ value: "blue", label: "Blue" }],
			},
		],
	});

	const lines: string[] = [];
	renderSubmitScreen(
		lines,
		state,
		plainTheme(),
		UI_DIMENSIONS.submitWideMinWidth - 14,
		"Press 1, 2, or 3 twice to confirm a review action."
	);

	assert.equal(
		lines.includes(" Press 1, 2, or 3 twice to confirm a review"),
		true
	);
	assert.equal(lines.includes(" action."), true);
});

test("submit screen shows notes only for answered questions in submit mode", () => {
	let state = createInitialState({
		questions: [
			{
				id: "q1",
				label: "Single",
				prompt: "Pick one primary demo style.",
				options: [{ value: "code", label: "Code demo" }],
			},
			{
				id: "q2",
				label: "Multi",
				prompt: "Pick any extra things to include.",
				options: [{ value: "extra", label: "Extra" }],
			},
		],
	});

	state = enterQuestionNoteMode(state, "q1");
	state = saveNote(state, "Question note");
	state = applyNumberShortcut(state, 1);
	state = enterOptionNoteMode(state, "q1", "code");
	state = saveNote(state, "Option note");
	state = enterQuestionNoteMode(state, "q2");
	state = saveNote(state, "Second note");

	const lines: string[] = [];
	renderSubmitScreen(
		lines,
		state,
		plainTheme(),
		UI_DIMENSIONS.submitWideMinWidth + 76
	);

	const firstQuestionIndex = lines.findIndex((line) => line.includes("Single"));
	const firstQuestionNoteIndex = lines.findIndex((line) =>
		line.includes("Question note")
	);
	const firstAnswerIndex = lines.findIndex((line) =>
		line.includes("→ Code demo")
	);
	const optionNoteIndex = lines.findIndex((line) =>
		line.includes("Option note")
	);
	const secondQuestionIndex = lines.findIndex((line) => line.includes("Multi"));

	assert.notEqual(firstQuestionIndex, -1);
	assert.notEqual(firstQuestionNoteIndex, -1);
	assert.notEqual(firstAnswerIndex, -1);
	assert.notEqual(optionNoteIndex, -1);
	assert.notEqual(secondQuestionIndex, -1);
	assert(firstQuestionNoteIndex < firstAnswerIndex);
	assert(optionNoteIndex > firstAnswerIndex);
	assert(lines[firstQuestionNoteIndex]?.startsWith("     "));
	assert(lines[optionNoteIndex]?.startsWith("     "));
	assert.equal(lines[secondQuestionIndex - 1]?.trim(), "");
	assert(lines.some((line) => line.includes("Note:")));
	assert(!lines.some((line) => line.includes("Second note")));
	assert(!lines.some((line) => line.includes("Question note:")));
	assert(!lines.some((line) => line.includes("Code demo note:")));
	assert(!lines.some((line) => line.includes("Pick one primary demo style.")));
	assert(
		!lines.some((line) => line.includes("Pick any extra things to include."))
	);
});

test("submit screen shows all notes when elaborate action is selected", () => {
	let state = createInitialState({
		questions: [
			{
				id: "q1",
				label: "Single",
				prompt: "Pick one primary demo style.",
				options: [
					{ value: "code", label: "Code demo" },
					{ value: "slides", label: "Slides demo" },
				],
			},
			{
				id: "q2",
				label: "Multi",
				prompt: "Pick any extra things to include.",
				options: [{ value: "extra", label: "Extra" }],
			},
		],
	});

	state = enterQuestionNoteMode(state, "q1");
	state = saveNote(state, "Question note");
	state = applyNumberShortcut(state, 1);
	state = enterOptionNoteMode(state, "q1", "code");
	state = saveNote(state, "Selected option note");
	state = enterOptionNoteMode(state, "q1", "slides");
	state = saveNote(state, "Unselected option note");
	state = enterQuestionNoteMode(state, "q2");
	state = saveNote(state, "Second note");
	state = { ...state, activeSubmitActionIndex: 1 };

	const lines: string[] = [];
	renderSubmitScreen(
		lines,
		state,
		plainTheme(),
		UI_DIMENSIONS.submitWideMinWidth + 16
	);

	assert(lines.some((line) => line.includes("Question note")));
	assert(lines.some((line) => line.includes("Selected option note")));
	assert(lines.some((line) => line.includes("Unselected option note")));
	assert(lines.some((line) => line.includes("Slides demo Note:")));
	assert(lines.some((line) => line.includes("Second note")));
});

test("submit screen renders multi-select option notes under their related answers", () => {
	let state = createInitialState({
		questions: [
			{
				id: "q1",
				label: "Multi",
				prompt: "Pick extras",
				type: "multi",
				options: [
					{ value: "follow-up", label: "Follow-up action" },
					{ value: "docs", label: "Docs demo" },
				],
			},
		],
	});

	state = applyNumberShortcut(state, 1);
	state = applyNumberShortcut(state, 2);
	state = enterOptionNoteMode(state, "q1", "follow-up");
	state = saveNote(state, "First note");
	state = enterOptionNoteMode(state, "q1", "docs");
	state = saveNote(state, "Second note");

	const lines: string[] = [];
	renderSubmitScreen(
		lines,
		state,
		plainTheme(),
		UI_DIMENSIONS.submitWideMinWidth + 76
	);

	const firstAnswerIndex = lines.findIndex((line) =>
		line.includes("→ Follow-up action")
	);
	const firstNoteIndex = lines.findIndex((line) => line.includes("First note"));
	const secondAnswerIndex = lines.findIndex((line) =>
		line.includes("→ Docs demo")
	);
	const secondNoteIndex = lines.findIndex((line) =>
		line.includes("Second note")
	);

	assert.notEqual(firstAnswerIndex, -1);
	assert.notEqual(firstNoteIndex, -1);
	assert.notEqual(secondAnswerIndex, -1);
	assert.notEqual(secondNoteIndex, -1);
	assert(firstAnswerIndex < firstNoteIndex);
	assert(firstNoteIndex < secondAnswerIndex);
	assert(secondAnswerIndex < secondNoteIndex);
});

test("submit action column keeps all three actions on consecutive rows at the wide breakpoint", () => {
	const state = createInitialState({
		questions: [
			{
				id: "q1",
				label: "Color",
				prompt: "Pick one color.",
				options: [{ value: "blue", label: "Blue" }],
			},
		],
	});

	const lines: string[] = [];
	renderSubmitScreen(
		lines,
		state,
		plainTheme(),
		UI_DIMENSIONS.submitWideMinWidth
	);

	assert.equal(lines[0], "❯ 1. Submit      Review answers");
	assert.equal(lines[1], "  2. Elaborate  ");
	assert.equal(lines[2], "  3. Cancel      Color");
	assert.equal(lines[3], "                   → unanswered");
});
