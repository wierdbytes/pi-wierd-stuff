import assert from "node:assert/strict";
import { test } from "vitest";
import { createAskAutocompleteProvider } from "./ui/autocomplete.ts";

test("ask autocomplete explicitly triggers on file mention marker", () => {
	const provider = createAskAutocompleteProvider(process.cwd());

	assert.deepEqual(provider.triggerCharacters, ["@"]);
});
