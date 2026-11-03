import assert from "node:assert/strict";
import { test } from "vitest";
import { wrapText } from "./text.ts";

test("wrapText wraps prose", () => {
	assert.deepEqual(wrapText("hello world from pi", 8), [
		"hello",
		"world",
		"from pi",
	]);
});

test("wrapText preserves blank lines and indentation", () => {
	assert.deepEqual(wrapText("Title\n\n  indented text", 12), [
		"Title",
		"",
		"  indented",
		"  text",
	]);
});

test("wrapText breaks long words", () => {
	assert.deepEqual(wrapText("supercalifragilistic", 5), [
		"super",
		"calif",
		"ragil",
		"istic",
	]);
});
