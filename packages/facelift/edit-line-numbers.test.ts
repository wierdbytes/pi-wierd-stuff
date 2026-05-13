/**
 * Regression tests for `edit`-tool line-number shifting.
 *
 * Bug history: the wrapper called `parseDiff(op.oldText, op.newText)`
 * with just the per-edit snippets, so every diff was numbered from
 * line 1 \u2014 even when the edit modified line 50 of the file. The user
 * screenshot showed `1 -`/`1 +` for a change that actually replaced
 * line 3 of `README.md`.
 *
 * The fix snapshots the file BEFORE running the original edit
 * `execute`, then for each edit shifts `oldNum`/`newNum` of every diff
 * line by the file offset where `op.oldText` lives. A `cumulativeDelta`
 * keeps the new-side numbers consistent when earlier edits in the same
 * call add/remove lines.
 *
 * These tests pin both invariants so a future refactor can't silently
 * drift the gutter numbers again.
 */

import { describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piFaceliftExtension from "./index.ts";

class MockText {
	private text = "";
	constructor(_text = "", _x = 0, _y = 0) {}
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
}

function mockToolFactory(exec: any) {
	return (_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	});
}

function loadEditTool(editExec: any) {
	const noopExec = async () => ({ content: [{ type: "text", text: "" }] });
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
	};

	piFaceliftExtension(pi, {
		sdk: {
			createReadToolDefinition: mockToolFactory(noopExec),
			createBashToolDefinition: mockToolFactory(noopExec),
			createLsToolDefinition: mockToolFactory(noopExec),
			createFindToolDefinition: mockToolFactory(noopExec),
			createGrepToolDefinition: mockToolFactory(noopExec),
			createWriteToolDefinition: mockToolFactory(noopExec),
			createEditToolDefinition: mockToolFactory(editExec),
			getAgentDir: () => "/tmp/pi-facelift-test",
		},
		TextComponent: MockText,
	});

	return tools.get("edit");
}

interface DiffLine {
	type: "ctx" | "add" | "del" | "sep";
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

interface EditEntry {
	oldText: string;
	newText: string;
	diff: { lines: DiffLine[]; added: number; removed: number };
}

interface EditDetails {
	_type: "editDiff";
	edits: EditEntry[];
}

describe("edit execute: per-edit line-number offsets", () => {
	it("shifts diff line numbers to match where the edit lives in the file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "facelift-edit-lineno-"));
		const file = join(dir, "README.md");
		const original = [
			"# pi-wierd-stuff", // 1
			"", // 2
			"Monorepo for various extensions for the [pi](https://github.com/badlogic/pi-mono) coding agent.", // 3
			"", // 4
			"## Packages", // 5
		].join("\n");
		writeFileSync(file, original, "utf-8");

		// Mock the original edit `execute` \u2014 we don't need it to actually
		// rewrite the file. The wrapper reads the file BEFORE calling
		// us, then attaches `details` based on its in-memory copy of
		// the edits.
		const editTool = loadEditTool(async () => ({
			content: [
				{
					type: "text",
					text: "Successfully replaced 1 block(s) in README.md.",
				},
			],
		}));

		const oldLine =
			"Monorepo for various extensions for the [pi](https://github.com/badlogic/pi-mono) coding agent.";
		const newLine =
			"Monorepo for various extensions for the [pi](https://github.com/earendil-works/pi) coding agent.";

		const result = await editTool.execute(
			"t1",
			{
				path: file,
				edits: [{ oldText: oldLine, newText: newLine }],
			},
			null,
			null,
			{},
		);

		const details = result.details as EditDetails;
		expect(details._type).toBe("editDiff");
		expect(details.edits).toHaveLength(1);

		const lines = details.edits[0].diff.lines;
		const del = lines.find((l) => l.type === "del");
		const add = lines.find((l) => l.type === "add");
		expect(del?.oldNum).toBe(3);
		expect(add?.newNum).toBe(3);

		rmSync(dir, { recursive: true, force: true });
	});

	it("tracks cumulative line delta across multiple edits in one call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "facelift-edit-cumdelta-"));
		const file = join(dir, "src.ts");
		const original = [
			"export const A = 1;", // 1
			"export const B = 2;", // 2
			"export const C = 3;", // 3
			"export const D = 4;", // 4
			"export const E = 5;", // 5
		].join("\n");
		writeFileSync(file, original, "utf-8");

		const editTool = loadEditTool(async () => ({
			content: [{ type: "text", text: "Successfully replaced 2 block(s) in src.ts." }],
		}));

		const result = await editTool.execute(
			"t2",
			{
				path: file,
				edits: [
					// Edit 1 at line 2: replace with two lines (net +1).
					{ oldText: "export const B = 2;", newText: "export const B = 2;\nexport const BB = 22;" },
					// Edit 2 at line 4: simple in-place replacement (net 0).
					{ oldText: "export const D = 4;", newText: "export const D = 40;" },
				],
			},
			null,
			null,
			{},
		);

		const details = result.details as EditDetails;
		expect(details.edits).toHaveLength(2);

		// Edit 1: oldNum starts at line 2, newNum starts at line 2.
		{
			const lines = details.edits[0].diff.lines;
			const del = lines.find((l) => l.type === "del");
			const adds = lines.filter((l) => l.type === "add");
			expect(del?.oldNum).toBe(2);
			expect(adds.map((l) => l.newNum)).toEqual([2, 3]);
		}

		// Edit 2: oldNum at file line 4. newNum should already be
		// shifted by the +1 introduced by Edit 1 \u2192 line 5.
		{
			const lines = details.edits[1].diff.lines;
			const del = lines.find((l) => l.type === "del");
			const add = lines.find((l) => l.type === "add");
			expect(del?.oldNum).toBe(4);
			expect(add?.newNum).toBe(5);
		}

		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to line 1 when the file can't be read (graceful, no throw)", async () => {
		// Point at a path that does not exist. The wrapper should
		// swallow the read error and leave diff numbers starting at 1
		// rather than crashing the tool call.
		const editTool = loadEditTool(async () => ({
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in missing.md." }],
		}));

		const result = await editTool.execute(
			"t3",
			{
				path: "/tmp/this-path-does-not-exist-12345/missing.md",
				edits: [{ oldText: "a", newText: "b" }],
			},
			null,
			null,
			{},
		);

		const details = result.details as EditDetails;
		expect(details.edits).toHaveLength(1);
		const lines = details.edits[0].diff.lines;
		const del = lines.find((l) => l.type === "del");
		const add = lines.find((l) => l.type === "add");
		expect(del?.oldNum).toBe(1);
		expect(add?.newNum).toBe(1);
	});
});
