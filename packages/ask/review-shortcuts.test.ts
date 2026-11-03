import assert from "node:assert/strict";
import { test } from "vitest";
import {
	getReviewShortcutHint,
	resolveReviewShortcutDoublePress,
} from "./ui/review-shortcuts.ts";

test("review shortcut double press requires the same digit twice", () => {
	const first = resolveReviewShortcutDoublePress(2);
	assert.equal(first.confirmed, false);
	assert.equal(first.actionIndex, 1);
	assert.equal(first.pendingActionIndex, 1);

	const second = resolveReviewShortcutDoublePress(2, first.pendingActionIndex);
	assert.equal(second.confirmed, true);
	assert.equal(second.actionIndex, 1);
	assert.equal(second.pendingActionIndex, undefined);
});

test("review shortcut double press switches pending action when digit changes", () => {
	const first = resolveReviewShortcutDoublePress(1);
	const second = resolveReviewShortcutDoublePress(3, first.pendingActionIndex);

	assert.equal(second.confirmed, false);
	assert.equal(second.actionIndex, 2);
	assert.equal(second.pendingActionIndex, 2);
});

test("review shortcut hint reflects pending confirmation state", () => {
	assert.equal(
		getReviewShortcutHint(),
		"Press 1, 2, or 3 twice to confirm a review action."
	);
	assert.equal(getReviewShortcutHint(1), "Press 2 again to Elaborate.");
});
