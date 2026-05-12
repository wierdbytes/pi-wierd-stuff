import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

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

const mockTheme = {
	fg: (_key: string, text: string) => text,
	bold: (text: string) => text,
};

const ansiMockTheme = {
	fg: (_key: string, text: string) => `\x1b[31m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

function mockToolFactory(exec: any) {
	return (_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	});
}

function withStdoutColumns<T>(columns: number, fn: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
	try {
		return fn();
	} finally {
		if (descriptor) {
			Object.defineProperty(process.stdout, "columns", descriptor);
		} else {
			delete (process.stdout as NodeJS.WriteStream & { columns?: number }).columns;
		}
	}
}

function loadBashTool() {
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
			getAgentDir: () => "/tmp/pi-facelift-test",
		},
		TextComponent: MockText,
	});

	return tools.get("bash");
}

describe("bash renderCall expansion", () => {
	it("shows the full command even when collapsed (no length-based truncation)", () => {
		withStdoutColumns(200, () => {
			const bashTool = loadBashTool();
			// 120-char command fits inside a 200-col frame, so the only previous
			// reason it would have been clipped was the old 80-char compact cap.
			const command = `printf '${"x".repeat(120)}'`;

			const rendered = bashTool.renderCall({ command }, mockTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: false,
				invalidate: () => {},
			});

			expect(rendered.getText()).toContain("bash");
			expect(rendered.getText()).toContain(command);
		});
	});

	it("shows the full command when expanded", () => {
		const bashTool = loadBashTool();
		const command = `printf '${"x".repeat(120)}'`;

		const rendered = bashTool.renderCall({ command }, mockTheme, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: true,
			invalidate: () => {},
		});

		expect(rendered.getText()).toContain(command);
	});

	it("preserves timeout text in both collapsed and expanded states", () => {
		const bashTool = loadBashTool();
		const command = `printf '${"x".repeat(120)}'`;

		const collapsed = bashTool.renderCall({ command, timeout: 5 }, mockTheme, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: false,
			invalidate: () => {},
		});
		const expanded = bashTool.renderCall({ command, timeout: 5 }, mockTheme, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: true,
			invalidate: () => {},
		});

		expect(collapsed.getText()).toContain("5s timeout");
		expect(expanded.getText()).toContain("5s timeout");
	});

	it("truncates expanded ANSI tool headers to fit the terminal width", () => {
		withStdoutColumns(84, () => {
			const bashTool = loadBashTool();
			const command = `printf '${"界".repeat(120)}'`;

			const rendered = bashTool.renderCall({ command }, ansiMockTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: true,
				invalidate: () => {},
			});

			// pi-facelift draws its own frame and pi-tui's `Text.render(width)` is
			// called with `terminal.columns`, so frame lines should be ≤ cols.
			for (const line of rendered.getText().split("\n")) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(84);
			}
		});
	});

	it("does not exceed narrow terminal widths", () => {
		withStdoutColumns(24, () => {
			const bashTool = loadBashTool();
			const command = `printf '${"x".repeat(120)}'`;

			const rendered = bashTool.renderCall({ command }, ansiMockTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: true,
				invalidate: () => {},
			});

			for (const line of rendered.getText().split("\n")) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(24);
			}
		});
	});

	it("keeps trailing dashes on the first line for multi-line commands", () => {
		withStdoutColumns(120, () => {
			const bashTool = loadBashTool();
			// User-typed multi-line command (line continuation with `\`)
			const command = `cd /tmp && \\\n  echo "hello"`;

			const rendered = bashTool.renderCall({ command }, mockTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: true,
				invalidate: () => {},
			});

			const lines = rendered.getText().split("\n");
			expect(lines.length).toBeGreaterThanOrEqual(2);

			// First line: top border with `╭── bash cd /tmp && \` and trailing dashes.
			expect(lines[0]).toMatch(/^.*╭──.*bash.*cd \/tmp && \\.*─/);
			expect(lines[0]).toContain("\\");
			expect(lines[0]).toMatch(/─{2,}/); // trailing dashes survive on first line

			// Continuation line: outer rail + sub-tree connector + content (no trailing dashes).
			const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
			const plainCont = stripAnsi(lines[1]);
			expect(plainCont).toMatch(/^│/);
			expect(plainCont).toMatch(/[│╰] /); // sub-tree connector before content
			expect(plainCont).toContain("echo");
			expect(plainCont).not.toMatch(/─{2,}/);
		});
	});

	it("renders multi-line commands as a sub-tree with `│`/`╰` connectors", () => {
		withStdoutColumns(200, () => {
			const bashTool = loadBashTool();
			const command = `cd /tmp && \\\n  echo "line 1" \\\n  echo "line 2"`;

			const rendered = bashTool.renderCall({ command }, mockTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: true,
				invalidate: () => {},
			});

			const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
			const plain = rendered.getText().split("\n").map(stripAnsi);

			expect(plain.length).toBe(3);
			// Non-last continuation row uses `│`.
			expect(plain[1]).toMatch(/^│ +│ echo "line 1" \\$/);
			// Last continuation row uses `╰`.
			expect(plain[2]).toMatch(/^│ +╰ echo "line 2"$/);
		});
	});

	it("aligns sub-tree continuations under the first arg, ignoring heredoc indent", () => {
		withStdoutColumns(120, () => {
			const bashTool = loadBashTool();
			// Continuation has 4 leading spaces — those should be stripped so the
			// sub-tree connector aligns the content under the first row's first arg.
			const command = "cd /tmp && \\\n    echo hi";

			const rendered = bashTool.renderCall({ command }, mockTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: true,
				invalidate: () => {},
			});

			const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
			const [firstLine, secondLine] = rendered.getText().split("\n").map(stripAnsi);

			// `╭── bash ` is 9 chars, so `c` of `cd` is at col 10 (0-indexed: 9).
			const firstArgCol = firstLine.indexOf("cd /tmp");
			expect(firstArgCol).toBe(9);

			// Continuation: `│` (col 0) + 6 spaces + connector (col 7) + space (col 8) + content (col 9).
			// Content col must equal the first row's first arg col, regardless of
			// the user's heredoc indent (4 leading spaces above are stripped).
			const echoCol = secondLine.indexOf("echo");
			expect(echoCol).toBe(firstArgCol);
		});
	});

	it("colors continuation lines with the same accent as the first arg", () => {
		withStdoutColumns(120, () => {
			const bashTool = loadBashTool();
			const accentTheme = {
				fg: (key: string, text: string) => (key === "accent" ? `\x1b[36m${text}\x1b[0m` : `\x1b[31m${text}\x1b[0m`),
				bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
			};
			const command = "cd /tmp && \\\n  echo hi";

			const rendered = bashTool.renderCall({ command }, accentTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: true,
				invalidate: () => {},
			});

			const lines = rendered.getText().split("\n");
			// First-row args are wrapped in the accent open code (`\x1b[36m`); the
			// continuation row must independently carry the same accent wrap so the
			// rendered text doesn't fall back to the terminal's default fg.
			expect(lines[0]).toContain("\x1b[36mcd /tmp");
			expect(lines[1]).toContain("\x1b[36mecho hi");
		});
	});
});

describe("bash renderResult body rails", () => {
	it("keeps the left rail on lines that contain a `\\r` (terminal-style overwrite)", () => {
		withStdoutColumns(120, () => {
			const bashTool = loadBashTool();

			// Simulates `git rebase` output, which prints `Rebasing (1/1)\rSuccessfully …`
			const text = [
				"=== before ===",
				"abc1234 some change",
				"Rebasing (1/1)\rSuccessfully rebased and updated refs/heads/master.",
				"=== after ===",
			].join("\n");

			const result = {
				content: [{ type: "text", text }],
				details: { _type: "bashResult", text, exitCode: 0, command: "git pull --rebase" },
			};

			const rendered = bashTool.renderResult(
				result as any,
				{ isPartial: false } as any,
				mockTheme,
				{
					lastComponent: new MockText(),
					isError: false,
					state: {},
					expanded: true,
					invalidate: () => {},
				} as any,
			);

			const out = rendered.getText() as string;
			const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
			const lines = out.split("\n").map(stripAnsi);

			// Find the line that ends with the success message — it must be rail-prefixed,
			// not raw `Successfully…` (which would mean the rail got clobbered).
			const successLine = lines.find((l) => l.includes("Successfully rebased"));
			expect(successLine).toBeDefined();
			expect(successLine!.startsWith("│")).toBe(true);
			// `\r` and the discarded progress prefix are stripped from the rendered line.
			expect(successLine!).not.toContain("\r");
			expect(successLine!).not.toContain("Rebasing (1/1)");

			// Sanity check: every body line keeps a rail prefix.
			const bodyLines = lines.filter((l) => !l.startsWith("╭") && !l.startsWith("╰") && l.length > 0);
			for (const line of bodyLines) {
				expect(line.startsWith("│")).toBe(true);
			}
		});
	});
});
