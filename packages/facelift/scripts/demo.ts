#!/usr/bin/env bun
/**
 * scripts/demo.ts — visual smoke harness for @wierdbytes/pi-facelift.
 *
 * Renders every tool block (read with shiki highlighting, bash in
 * success / non-zero / streaming / timeout states, ls tree, find groups,
 * grep matches) directly to your terminal so you can eyeball the
 * open-right rounded frame, the status-aware coloring, and the
 * duration/exit summary in the bottom border.
 *
 * Run from the package root with:
 *
 *     bun scripts/demo.ts
 *
 * or via the npm script:
 *
 *     bun run demo
 */
/* eslint-disable no-console */

import piFaceliftExtension, { type PiFaceliftDeps } from "../index.ts";

// ── mock pi infrastructure ───────────────────────────────────────────────────

class MockText {
	private text = "";
	constructor(_text = "", _x = 0, _y = 0) {}
	setText(value: string): void {
		this.text = value;
	}
	getText(): string {
		return this.text;
	}
}

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	unbold: "\x1b[22m",
	toolTitle: "\x1b[1;37m",
	accent: "\x1b[36m",
	muted: "\x1b[90m",
	dim: "\x1b[2m",
	error: "\x1b[31m",
	warning: "\x1b[33m",
	success: "\x1b[32m",
	toolOutput: "\x1b[37m",
};

const theme = {
	fg: (key: string, text: string): string => {
		const c = (ANSI as Record<string, string>)[key] ?? "";
		return `${c}${text}${ANSI.reset}`;
	},
	bold: (text: string): string => `${ANSI.bold}${text}${ANSI.unbold}`,
	bg: (_key: string, text: string): string => text,
	getBgAnsi: (): string | undefined => undefined,
};

type MockExec = (
	tid: string,
	params: unknown,
	signal?: unknown,
	upd?: unknown,
	ctx?: unknown,
) => Promise<{
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: unknown;
}>;

const noopExec: MockExec = async () => ({ content: [{ type: "text", text: "" }] });

function mockToolFactory(exec: MockExec) {
	// `as any` because pi-coding-agent types `content[].type` as the literal
	// `"text" | "image"`. We're feeding hand-built fixtures here, not real
	// tool output, so we widen the cast at the boundary instead of carrying
	// the typed literals everywhere.
	return ((_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	})) as any;
}

function loadTools(execMap: Partial<Record<"read" | "bash" | "ls" | "find" | "grep", MockExec>> = {}) {
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: () => {},
		on: () => {},
	};
	const deps: PiFaceliftDeps = {
		sdk: {
			createReadToolDefinition: mockToolFactory(execMap.read ?? noopExec),
			createBashToolDefinition: mockToolFactory(execMap.bash ?? noopExec),
			createLsToolDefinition: mockToolFactory(execMap.ls ?? noopExec),
			createFindToolDefinition: mockToolFactory(execMap.find ?? noopExec),
			createGrepToolDefinition: mockToolFactory(execMap.grep ?? noopExec),
			getAgentDir: () => "/tmp/pi-facelift-demo",
		},
		TextComponent: MockText as any,
	};
	piFaceliftExtension(pi, deps);
	return tools;
}

// ── render context helpers ───────────────────────────────────────────────────

interface DemoRenderCtx {
	lastComponent?: MockText;
	state: Record<string, unknown>;
	expanded: boolean;
	isError: boolean;
	isPartial?: boolean;
	executionStarted?: boolean;
	invalidate: () => void;
}

function makeCtx(overrides: Partial<DemoRenderCtx> = {}): DemoRenderCtx {
	return {
		lastComponent: new MockText(),
		state: {},
		expanded: false,
		isError: false,
		isPartial: false,
		executionStarted: true,
		invalidate: () => {},
		...overrides,
	};
}

// Wait until the renderer's async pipeline (e.g. shiki) calls
// ctx.invalidate(), then re-render to pick up the cached output.
async function renderAsync(
	tool: any,
	method: "renderResult",
	args: unknown[],
	ctx: DemoRenderCtx,
	timeoutMs = 1500,
): Promise<MockText> {
	let resolve!: () => void;
	const inv = new Promise<void>((r) => {
		resolve = r;
	});
	const renderCtx = { ...ctx, invalidate: () => resolve() };
	(tool[method] as any)(...args, theme, renderCtx);
	await Promise.race([inv, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
	const final = new MockText();
	(tool[method] as any)(...args, theme, { ...renderCtx, lastComponent: final });
	return final;
}

function header(title: string): void {
	const w = Math.min(process.stdout.columns ?? 80, 100);
	const bar = "═".repeat(Math.max(2, w - title.length - 4));
	console.log(`\n${ANSI.bold}${ANSI.dim}══ ${title} ${bar}${ANSI.reset}\n`);
}

// ── individual demos ─────────────────────────────────────────────────────────

async function demoRead(): Promise<void> {
	header("read — syntax-highlighted file with line numbers");
	const sample = [
		`import { foo } from "./bar.ts";`,
		``,
		`/** Greet someone. */`,
		`export function greet(name: string): void {`,
		"  console.log(`Hello, ${name}!`);",
		`}`,
		``,
		`greet("world");`,
	].join("\n");
	const tools = loadTools({
		read: async () => ({ content: [{ type: "text", text: sample }] }),
	});
	const read = tools.get("read");
	const callCtx = makeCtx();
	console.log(read.renderCall({ path: "src/example.ts" }, theme, callCtx).getText());

	const result = await read.execute("t1", { path: "src/example.ts" }, undefined, undefined, {});
	const resCtx = makeCtx();
	const out = await renderAsync(read, "renderResult", [result, { isPartial: false, expanded: false }], resCtx);
	console.log(out.getText());
}

async function demoBashSuccess(): Promise<void> {
	header("bash date — success (green, ✓ exit 0)");
	const tools = loadTools({
		bash: async () => ({
			content: [{ type: "text", text: "Fri May  8 19:07:33 CEST 2026" }],
			details: { _type: "bashResult", text: "Fri May  8 19:07:33 CEST 2026", exitCode: 0, command: "date" },
		}),
	});
	const bash = tools.get("bash");
	const state: { startedAt?: number; endedAt?: number } = { startedAt: Date.now() - 3300 };
	const callCtx = makeCtx({ state });
	console.log(bash.renderCall({ command: "date" }, theme, callCtx).getText());
	const result = await bash.execute("t1", { command: "date" }, undefined, undefined, {});
	state.endedAt = Date.now();
	const resCtx = makeCtx({ state });
	console.log(
		bash.renderResult(result, { isPartial: false, expanded: false }, theme, resCtx).getText(),
	);
}

async function demoBashError(): Promise<void> {
	header("bash false — non-zero exit (red, ✗ exit 1)");
	const tools = loadTools();
	const bash = tools.get("bash");
	const state = { startedAt: Date.now() - 200, endedAt: Date.now() };
	const result = {
		isError: true,
		content: [{ type: "text", text: "(no output)\n\nCommand exited with code 1" }],
		details: undefined,
	};
	const callCtx = makeCtx({ state, isError: true });
	console.log(bash.renderCall({ command: "false" }, theme, callCtx).getText());
	const resCtx = makeCtx({ state, isError: true });
	console.log(
		bash.renderResult(result, { isPartial: false, expanded: false }, theme, resCtx).getText(),
	);
}

async function demoBashStreaming(): Promise<void> {
	header("bash sleep 5 — streaming (yellow, live counter)");
	const tools = loadTools();
	const bash = tools.get("bash");
	const state = { startedAt: Date.now() - 3300 };
	const callCtx = makeCtx({ state, isPartial: true });
	console.log(bash.renderCall({ command: "sleep 5" }, theme, callCtx).getText());
	const result = { content: [{ type: "text", text: "" }] };
	const resCtx = makeCtx({ state, isPartial: true });
	console.log(
		bash.renderResult(result, { isPartial: true, expanded: false }, theme, resCtx).getText(),
	);
	// renderResult installs a setInterval(invalidate, 1000) while partial.
	if ((state as any).interval) clearInterval((state as any).interval);
}

async function demoBashTimeout(): Promise<void> {
	header("bash sleep 60 (5s timeout) — ⚡ timed out");
	const tools = loadTools();
	const bash = tools.get("bash");
	const state = { startedAt: Date.now() - 5400, endedAt: Date.now() };
	const result = {
		isError: true,
		content: [
			{ type: "text", text: "partial output line\n\nCommand timed out after 5 seconds" },
		],
	};
	const callCtx = makeCtx({ state, isError: true });
	console.log(
		bash.renderCall({ command: "sleep 60", timeout: 5 }, theme, callCtx).getText(),
	);
	const resCtx = makeCtx({ state, isError: true });
	console.log(
		bash.renderResult(result, { isPartial: false, expanded: false }, theme, resCtx).getText(),
	);
}

async function demoBashMultiline(): Promise<void> {
	header("bash multi-line command — sub-tree title + \\r-safe body rails");
	// Multi-line shell command (line continuations with `\`). The title
	// renders as a sub-tree with `│`/`╰` connectors aligned under the first
	// arg of the first row; continuation lines stay in the same accent
	// color as the first row.
	const command = [
		"cd /Users/mentor/me/dev/pi-wierd-stuff && \\",
		'  echo "=== before ===" && \\',
		"  git log --oneline -3 origin/master && \\",
		"  git pull --rebase && \\",
		'  echo "=== after ==="',
	].join("\n");

	// Body intentionally contains `Rebasing (1/1)\rSuccessfully rebased…`,
	// the exact pattern `git rebase` writes to stderr. Without terminal-style
	// `\r` handling, the embedded carriage return would clobber the `│` rail
	// when the terminal honors `\r` as cursor-reset.
	const bodyText = [
		"=== before ===",
		"981c12d facelift: add @wierdbytes/pi-facelift v0.1.0",
		"4517d9c README: fix stale npm package names",
		"046a5c2 web: rename slash command from /wierd-web to /web, bump to 0.3.1",
		"Rebasing (1/1)\rSuccessfully rebased and updated refs/heads/master.",
		"=== after ===",
		"8770a5e facelift: add @wierdbytes/pi-facelift v0.1.0",
		"046a5c2 web: rename slash command from /wierd-web to /web, bump to 0.3.1",
		"f87cbcf voice: rename slash command from /wierd-voice to /voice, bump to 0.4.1",
	].join("\n");

	const tools = loadTools({
		bash: async () => ({
			content: [{ type: "text", text: bodyText }],
			details: { _type: "bashResult", text: bodyText, exitCode: 0, command },
		}),
	});
	const bash = tools.get("bash");
	const state: { startedAt?: number; endedAt?: number } = { startedAt: Date.now() - 1200 };

	const callCtx = makeCtx({ state, expanded: true });
	console.log(bash.renderCall({ command }, theme, callCtx).getText());

	const result = await bash.execute("t1", { command }, undefined, undefined, {});
	state.endedAt = Date.now();
	const resCtx = makeCtx({ state, expanded: true });
	console.log(
		bash.renderResult(result, { isPartial: false, expanded: true }, theme, resCtx).getText(),
	);
}

async function demoLs(): Promise<void> {
	header("ls — tree view with Nerd Font icons");
	const tools = loadTools({
		ls: async () => ({
			content: [
				{
					type: "text",
					text: [
						"index.ts",
						"package.json",
						"README.md",
						"media/",
						"scripts/",
					].join("\n"),
				},
			],
		}),
	});
	const ls = tools.get("ls");
	const callCtx = makeCtx();
	console.log(ls.renderCall({ path: "." }, theme, callCtx).getText());
	const result = await ls.execute("t1", { path: "." }, undefined, undefined, {});
	const resCtx = makeCtx();
	console.log(ls.renderResult(result, { isPartial: false, expanded: false }, theme, resCtx).getText());
}

async function demoFind(): Promise<void> {
	header('find pattern="*.ts" — grouped with file-type icons');
	const tools = loadTools({
		find: async () => ({
			content: [
				{
					type: "text",
					text: [
						"index.ts",
						"bash-rendering.test.ts",
						"image-rendering.test.ts",
						"scripts/demo.ts",
					].join("\n"),
				},
			],
		}),
	});
	const find = tools.get("find");
	const callCtx = makeCtx();
	console.log(find.renderCall({ pattern: "*.ts" }, theme, callCtx).getText());
	const result = await find.execute("t1", { pattern: "*.ts" }, undefined, undefined, {});
	const resCtx = makeCtx();
	console.log(find.renderResult(result, { isPartial: false, expanded: false }, theme, resCtx).getText());
}

async function demoGrep(): Promise<void> {
	header('grep pattern="renderResult" — highlighted matches');
	const grepText = [
		"index.ts:1340:    renderResult(result, opt, theme, ctx) {",
		"index.ts:1410:    renderResult(result, opt, theme, ctx) {",
		"index.ts:1488:    renderResult(",
		"index.ts:1570:    renderResult(",
	].join("\n");
	const tools = loadTools({
		grep: async () => ({ content: [{ type: "text", text: grepText }] }),
	});
	const grep = tools.get("grep");
	const callCtx = makeCtx();
	console.log(grep.renderCall({ pattern: "renderResult" }, theme, callCtx).getText());
	const result = await grep.execute("t1", { pattern: "renderResult" }, undefined, undefined, {});
	const resCtx = makeCtx();
	const out = await renderAsync(grep, "renderResult", [result, { isPartial: false, expanded: false }], resCtx);
	console.log(out.getText());
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const cols = process.stdout.columns ?? 80;
	console.log(
		`${ANSI.bold}@wierdbytes/pi-facelift${ANSI.reset} demo · terminal width ${cols} cols\n`,
	);

	await demoRead();
	await demoBashSuccess();
	await demoBashError();
	await demoBashStreaming();
	await demoBashTimeout();
	await demoBashMultiline();
	await demoLs();
	await demoFind();
	await demoGrep();

	console.log(`\n${ANSI.dim}Done. (Resize your terminal and re-run to verify wide / narrow layouts.)${ANSI.reset}`);
	// Exit cleanly even if a stray timer is still pending.
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
