import { describe, expect, it } from "vitest";
import { buildDigest, clipMiddle, renderDigest, renderEntryFull, stripInjected } from "./digest.ts";
import type { ParsedSession, RawEntry } from "./sessions.ts";

function session(branch: RawEntry[]): ParsedSession {
	return { file: "/tmp/s.jsonl", header: { id: "sess-1", cwd: "/tmp/p", timestamp: "2026-11-07T10:00:00Z" }, branch, lastEntryId: branch.at(-1)?.id };
}

const entries: RawEntry[] = [
	{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "добавь в chezmoi без коммита" }, { type: "image" }] } },
	{ type: "custom", id: "c1", customType: "pi-dream", data: { event: "inject", ids: ["m-000001"] } },
	{
		type: "message",
		id: "a1",
		message: {
			role: "assistant",
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [
				{ type: "thinking" },
				{ type: "text", text: "Сделаю." },
				{ type: "toolCall", name: "bash", arguments: { command: "chezmoi add ~/.config/x token=abcdefghijklmnop" } },
				{ type: "toolCall", name: "memory_read", arguments: { ref: "m-000001" } },
			],
		},
	},
	{ type: "message", id: "r1", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "error: not found" }] } },
	{ type: "message", id: "u2", message: { role: "user", content: '<skill name="x">long body</skill> ok' } },
];

describe("digest", () => {
	it("renders kinds, ids, stats and scrubs secrets", () => {
		const d = buildDigest(session(entries));
		expect(d.meta).toMatchObject({ userMessages: 2, toolCalls: 2, toolErrors: 1, injected: ["m-000001"], read: ["m-000001"], models: ["anthropic/claude-opus-5-5"] });
		const text = renderDigest(d);
		expect(text).toContain("[u1] USER: добавь в chezmoi без коммита\n    [image]");
		expect(text).toContain("[c1] MEMORY: injected notes: m-000001");
		expect(text).toContain("[a1] CALL: bash $ chezmoi add ~/.config/x token=[REDACTED]");
		expect(text).toContain("[r1] ERROR: bash: error: not found");
		expect(text).toContain("[u2] USER: [skill: x] ok");
		expect(text).not.toContain("thinking");
	});

	it("shrinks to fit, keeping user lines longest", () => {
		const big: RawEntry[] = [];
		for (let i = 0; i < 50; i++) {
			big.push({ type: "message", id: `u${i}`, message: { role: "user", content: `question ${i}` } });
			big.push({ type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: "y".repeat(3000) }] } });
			big.push({ type: "message", id: `r${i}`, message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "z".repeat(500) }] } });
		}
		const d = buildDigest(session(big));
		const text = renderDigest(d, 30_000);
		expect(text.length).toBeLessThanOrEqual(30_100);
		expect(text).toContain("question 49");
	});

	it("clips and strips helpers", () => {
		expect(clipMiddle("abcdefghij", 6)).toContain("omitted");
		expect(stripInjected('<file name="a.ts">x</file> hi')).toBe("[file: a.ts] hi");
		expect(renderEntryFull(entries[0])).toContain("[u1] USER:");
	});
});
