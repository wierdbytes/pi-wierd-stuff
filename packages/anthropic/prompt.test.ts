import assert from "node:assert/strict";
import { test } from "node:test";
import { USER_AGENT } from "./auth.ts";
import { sanitizeSystemBlocksForClaudeCode } from "./prompt.ts";

test("inserts a current Claude Code billing version before system blocks", () => {
  const original = [{ type: "text", text: "Keep this prompt." }];

  const result = sanitizeSystemBlocksForClaudeCode(original);

  assert.deepEqual(result, [
    {
      type: "text",
      text: "x-anthropic-billing-header: cc_version=2.1.280.d1a; cc_entrypoint=cli; cch=7e48f;",
    },
    { type: "text", text: "Keep this prompt." },
  ]);
  assert.equal(USER_AGENT, "claude-code/2.1.280");
  assert.deepEqual(original, [{ type: "text", text: "Keep this prompt." }]);
  assert.equal("cache_control" in result[0], false);
});

test("does not duplicate an existing billing block or change non-text blocks", () => {
  const billing = {
    type: "text",
    text: "x-anthropic-billing-header: cc_version=2.1.280.d1a; cc_entrypoint=cli; cch=7e48f;",
  };
  const image = { type: "image", source: { type: "base64", data: "example" } };

  const result = sanitizeSystemBlocksForClaudeCode([billing, image]);

  assert.deepEqual(result, [billing, image]);
  assert.equal(result[1], image);
});
