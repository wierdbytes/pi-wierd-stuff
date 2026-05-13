/**
 * Regression tests for the per-path mutation lock that pairs the
 * pre-execute file snapshot with the underlying tool's execute() call.
 *
 * Bug history: when two `write` (or `edit`) calls for the *same* path
 * landed in the agent's tool queue concurrently, both wrappers ran
 *
 *     oldContent = readFileSync(path)
 *     result     = await origExecute(...)
 *
 * in parallel. The built-in tool serialized the actual writes, but both
 * wrappers had already captured the same pre-state snapshot — so the
 * second wrapper rendered its diff against the *original* file rather
 * than against whatever the first wrapper had just persisted.
 *
 * The fix routes snapshot + execute through `serializePerPath()`, an
 * in-process per-path promise chain. These tests pin that ordering by
 * making the mock origExecute() the thing that actually updates the
 * file on disk: if the snapshot ran before our chained predecessor's
 * execute(), the second snapshot would be the original contents and
 * the diff details would prove it.
 */

import { describe, expect, it } from "vitest";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function loadTools(opts: { writeExec?: any; editExec?: any } = {}) {
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
			createWriteToolDefinition: mockToolFactory(opts.writeExec ?? noopExec),
			createEditToolDefinition: mockToolFactory(opts.editExec ?? noopExec),
			getAgentDir: () => "/tmp/pi-facelift-test",
		},
		TextComponent: MockText,
	});

	return tools;
}

interface DiffLine {
	type: "ctx" | "add" | "del" | "sep";
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

interface WriteDiffDetails {
	_type: "writeDiff";
	filePath: string;
	diff: { lines: DiffLine[]; added: number; removed: number };
}

interface EditDiffDetails {
	_type: "editDiff";
	edits: Array<{ oldText: string; newText: string; diff: { lines: DiffLine[] } }>;
}

describe("write execute: per-path snapshot/execute serialization", () => {
	it("the second concurrent write diffs against the first write's result, not the original file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "facelift-write-concur-"));
		const file = join(dir, "state.txt");
		writeFileSync(file, "A\n", "utf-8");

		// `writeExec` is what the agent SDK's built-in write tool would
		// do: actually persist `params.content` to disk. By doing this
		// synchronously inside the mock we make the "second snapshot
		// must run after the first execute" property *observable* —
		// the resulting `details.diff` shows which baseline was used.
		const writeExec = async (
			_tid: string,
			params: { path: string; content: string },
		) => {
			// Yield once so a parallel caller has a chance to race with us.
			await Promise.resolve();
			writeFileSync(params.path, params.content, "utf-8");
			return { content: [{ type: "text", text: `wrote ${params.path}` }] };
		};
		const tools = loadTools({ writeExec });
		const writeTool = tools.get("write");

		// Fire both calls without awaiting — the lock should serialize
		// them so the second one sees "B\n", not "A\n".
		const [r1, r2] = await Promise.all([
			writeTool.execute("t1", { path: file, content: "B\n" }, null, null, {}),
			writeTool.execute("t2", { path: file, content: "C\n" }, null, null, {}),
		]);

		const d1 = r1.details as WriteDiffDetails;
		const d2 = r2.details as WriteDiffDetails;

		expect(d1._type).toBe("writeDiff");
		expect(d2._type).toBe("writeDiff");

		// First call: A → B. One deletion of "A", one addition of "B".
		const d1Del = d1.diff.lines.find((l) => l.type === "del");
		const d1Add = d1.diff.lines.find((l) => l.type === "add");
		expect(d1Del?.content).toBe("A");
		expect(d1Add?.content).toBe("B");

		// Second call: with the bug, oldContent would still be "A" and
		// the diff would say "A → C". With the lock, oldContent is the
		// state the first call left behind ("B"), so the diff is B → C.
		const d2Del = d2.diff.lines.find((l) => l.type === "del");
		const d2Add = d2.diff.lines.find((l) => l.type === "add");
		expect(d2Del?.content).toBe("B");
		expect(d2Add?.content).toBe("C");

		// And the file on disk reflects the second write.
		expect(readFileSync(file, "utf-8")).toBe("C\n");

		rmSync(dir, { recursive: true, force: true });
	});

	it("a failing first write does not poison subsequent writes to the same path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "facelift-write-poison-"));
		const file = join(dir, "state.txt");
		writeFileSync(file, "A\n", "utf-8");

		let call = 0;
		const writeExec = async (
			_tid: string,
			params: { path: string; content: string },
		) => {
			call += 1;
			await Promise.resolve();
			if (call === 1) throw new Error("boom");
			writeFileSync(params.path, params.content, "utf-8");
			return { content: [{ type: "text", text: "ok" }] };
		};
		const tools = loadTools({ writeExec });
		const writeTool = tools.get("write");

		// First call rejects; the chain must still let the second call
		// proceed and snapshot the (untouched) "A\n" baseline.
		const p1 = writeTool
			.execute("t1", { path: file, content: "B\n" }, null, null, {})
			.catch((e: Error) => e);
		const p2 = writeTool.execute("t2", { path: file, content: "C\n" }, null, null, {});
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(r1).toBeInstanceOf(Error);
		const d2 = (r2 as any).details as WriteDiffDetails;
		expect(d2._type).toBe("writeDiff");
		// First call never wrote, so the snapshot for the second call
		// is the original "A\n".
		const del = d2.diff.lines.find((l) => l.type === "del");
		const add = d2.diff.lines.find((l) => l.type === "add");
		expect(del?.content).toBe("A");
		expect(add?.content).toBe("C");

		rmSync(dir, { recursive: true, force: true });
	});
});

describe("edit execute: per-path snapshot/execute serialization", () => {
	it("the second concurrent edit sees the file state produced by the first edit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "facelift-edit-concur-"));
		const file = join(dir, "src.ts");
		const original = ["alpha", "beta", "gamma"].join("\n");
		writeFileSync(file, original, "utf-8");

		// Mock built-in edit: replace oldText → newText in the file so
		// the second snapshot can prove it ran after the first execute.
		const editExec = async (
			_tid: string,
			params: { path: string; edits: Array<{ oldText: string; newText: string }> },
		) => {
			await Promise.resolve();
			let body = readFileSync(params.path, "utf-8");
			for (const e of params.edits) body = body.replace(e.oldText, e.newText);
			writeFileSync(params.path, body, "utf-8");
			return { content: [{ type: "text", text: "ok" }] };
		};
		const tools = loadTools({ editExec });
		const editTool = tools.get("edit");

		const [r1, r2] = await Promise.all([
			editTool.execute(
				"t1",
				{ path: file, edits: [{ oldText: "alpha", newText: "ALPHA" }] },
				null,
				null,
				{},
			),
			// Targets the *result* of edit 1. Only succeeds if the
			// snapshot for edit 2 happens after edit 1's execute().
			editTool.execute(
				"t2",
				{ path: file, edits: [{ oldText: "ALPHA", newText: "Alpha!" }] },
				null,
				null,
				{},
			),
		]);

		const d2 = r2.details as EditDiffDetails;
		expect(d2._type).toBe("editDiff");
		// The edit operated on the line that previously was "alpha"
		// (file line 1). Without the lock the snapshot would still show
		// "alpha", `findLineOffset` for "ALPHA" would miss, and the
		// diff would silently number from line 1 of a fake baseline.
		const del = d2.edits[0].diff.lines.find((l) => l.type === "del");
		const add = d2.edits[0].diff.lines.find((l) => l.type === "add");
		expect(del?.content).toBe("ALPHA");
		expect(add?.content).toBe("Alpha!");
		expect(del?.oldNum).toBe(1);
		expect(add?.newNum).toBe(1);

		// Final on-disk content reflects both edits applied in order.
		expect(readFileSync(file, "utf-8")).toBe(["Alpha!", "beta", "gamma"].join("\n"));

		rmSync(dir, { recursive: true, force: true });
	});

	it("does not serialize unrelated paths against each other", async () => {
		const dir = mkdtempSync(join(tmpdir(), "facelift-edit-indep-"));
		const fileA = join(dir, "a.txt");
		const fileB = join(dir, "b.txt");
		writeFileSync(fileA, "a\n", "utf-8");
		writeFileSync(fileB, "b\n", "utf-8");

		// First call to `fileA` is intentionally slow. Second call to
		// `fileB` must NOT wait for it.
		let order: string[] = [];
		const editExec = async (
			_tid: string,
			params: { path: string; edits: Array<{ oldText: string; newText: string }> },
		) => {
			order.push(`start:${params.path}`);
			if (params.path === fileA) await new Promise((r) => setTimeout(r, 30));
			order.push(`end:${params.path}`);
			return { content: [{ type: "text", text: "ok" }] };
		};
		const tools = loadTools({ editExec });
		const editTool = tools.get("edit");

		await Promise.all([
			editTool.execute(
				"a",
				{ path: fileA, edits: [{ oldText: "a", newText: "aa" }] },
				null,
				null,
				{},
			),
			editTool.execute(
				"b",
				{ path: fileB, edits: [{ oldText: "b", newText: "bb" }] },
				null,
				null,
				{},
			),
		]);

		// fileB should finish before fileA — proves the lock is
		// per-path, not a global mutex.
		const endA = order.indexOf(`end:${fileA}`);
		const endB = order.indexOf(`end:${fileB}`);
		expect(endB).toBeLessThan(endA);

		rmSync(dir, { recursive: true, force: true });
	});
});
