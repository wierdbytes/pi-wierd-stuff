/**
 * @wierdbytes/pi-facelift — Cosmetic facelift for built-in pi tool output.
 *
 * @module @wierdbytes/pi-facelift
 * @see https://github.com/wierdbytes/pi-wierd-stuff/tree/master/packages/pi-facelift
 *
 * Enhances:
 *   • read  — syntax-highlighted file content with line numbers
 *   • bash  — colored exit status, stderr highlighting
 *   • ls    — tree-view directory listing with file-type icons
 *   • find  — grouped results with file-type icons
 *   • grep  — syntax-highlighted match context with line numbers
 *
 * Architecture:
 *   1. Wrap SDK factory tools (createReadTool, createBashTool, etc.)
 *   2. Delegate to original execute() — no behavior changes
 *   3. Attach metadata in result.details for custom renderCall/renderResult
 *   4. Async Shiki highlighting with ctx.invalidate() for non-blocking renders
 *
 * Performance:
 *   • Shared Shiki singleton (managed by @shikijs/cli)
 *   • LRU cache for highlighted blocks
 *   • Large-file fallback (skip highlighting, still show line numbers)
 */

import * as childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolInput,
	EditToolDetails,
	EditToolInput,
	ExtensionCommandContext,
	ExtensionContext,
	FindToolInput,
	GrepToolInput,
	LsToolInput,
	ReadToolInput,
	ToolRenderResultOptions,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
// Runtime SDK values are imported *statically* (not via `require()`).
//
// pi loads extensions through jiti, which aliases bare package specifiers
// (e.g. `@earendil-works/pi-ai`) to a single `dist/index.js` file. A runtime
// `require("@earendil-works/pi-coding-agent")` makes jiti resolve the SDK's
// transitive subpath imports (notably `@earendil-works/pi-ai/base`, pulled in
// by `@earendil-works/pi-agent-core` since pi 0.79.x) via prefix string
// replacement — yielding `.../pi-ai/dist/index.js/base`, which does not exist.
// The throw used to be swallowed by a `try/catch { return }`, silently
// disabling the whole extension (tools fell back to pi's default rendering).
// Static `import` resolves subpath exports correctly, so we use it instead.
import * as piCodingAgentSdk from "@earendil-works/pi-coding-agent";
import { Text as PiText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { codeToANSI } from "@shikijs/cli";
import { bundledThemes } from "shiki";
import {
	applyDiffPalette,
	canRenderSplit,
	hlBlock as hlDiffBlock,
	lang as diffLang,
	parseDiff,
	renderSplit,
	resolveDiffColors,
	summarize as summarizeDiff,
	themeCacheKey,
	type DiffColors,
	type DiffLayout,
	type ParsedDiff,
} from "@wierdbytes/pi-common/diff";
import { openSettingsModal, type Field } from "@wierdbytes/pi-common";
import {
	envDefaults as faceliftEnvDefaults,
	getConfigPath as getFaceliftConfigPath,
	loadOrInitConfig as loadFaceliftConfig,
	saveConfig as saveFaceliftConfig,
	VALID_DIFF_LAYOUTS,
	type DiffLayoutPreference,
	type WierdFaceliftConfig,
} from "./config.ts";
import {
	formatDuration,
	frameBodyLines,
	frameBottom,
	frameBottomWithLabel,
	frameResult,
	frameResultWithBottomLabel,
	frameTop,
	getFrameStatus,
	renderToolError,
	type FrameStatus,
} from "@wierdbytes/pi-common/tool-frame";
import type { BundledLanguage, BundledTheme } from "shiki";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_THEME: BundledTheme = "github-dark";

/**
 * Aliases that map common pi/host theme names (or popular external
 * themes that aren't bundled with Shiki) to their closest Shiki
 * `BundledTheme` equivalent.
 *
 * Keys are lowercased; values must be valid `BundledTheme` keys.
 * The full Shiki theme list lives at https://shiki.style/themes.
 *
 * Why this exists: pi's `settings.theme` is consumed by the host UI
 * and may use names Shiki doesn't ship (e.g. `tokyo-night-storm`).
 * Without aliasing, `codeToANSI` throws and `hlBlock` silently falls
 * back to plain text — leaving every `read` body uncolored.
 */
const THEME_ALIASES: Record<string, BundledTheme> = {
	// Tokyo Night family (storm/night/day are Tokyo Night palette variants;
	// Shiki only ships the storm-equivalent under the bare `tokyo-night` name).
	"tokyo-night-storm": "tokyo-night",
	"tokyo-night-night": "tokyo-night",
	"tokyo-night-day": "tokyo-night",
	tokyonight: "tokyo-night",
	"tokyonight-storm": "tokyo-night",
	"tokyonight-night": "tokyo-night",
	"tokyonight-day": "tokyo-night",
	// Catppuccin (default → mocha, the most common dark variant)
	catppuccin: "catppuccin-mocha",
	// Dracula
	"dracula-pro": "dracula",
	// Material
	material: "material-theme",
	"material-darker": "material-theme-darker",
	"material-lighter": "material-theme-lighter",
	"material-ocean": "material-theme-ocean",
	"material-palenight": "material-theme-palenight",
	// Gruvbox (medium contrast is the canonical default)
	"gruvbox-dark": "gruvbox-dark-medium",
	"gruvbox-light": "gruvbox-light-medium",
	// Solarized (default → dark)
	solarized: "solarized-dark",
	// One Dark
	"one-dark": "one-dark-pro",
	onedark: "one-dark-pro",
};

const _themeWarningShown = new Set<string>();

function isBundledTheme(name: string): name is BundledTheme {
	return Object.prototype.hasOwnProperty.call(bundledThemes, name);
}

function warnInvalidTheme(rawName: string, fallback: BundledTheme): void {
	if (_themeWarningShown.has(rawName)) return;
	_themeWarningShown.add(rawName);
	console.error(
		`pi-facelift: theme "${rawName}" is not a Shiki bundled theme; ` +
			`falling back to "${fallback}". ` +
			`Set FACELIFT_THEME to one of: ${Object.keys(bundledThemes).sort().join(", ")}.`,
	);
}

/** Resolve a raw theme name to a valid `BundledTheme`, applying aliases. */
function resolveBundledTheme(rawName: string | undefined): BundledTheme {
	if (!rawName) return DEFAULT_THEME;
	const trimmed = rawName.trim();
	if (!trimmed) return DEFAULT_THEME;
	if (isBundledTheme(trimmed)) return trimmed;
	const aliased = THEME_ALIASES[trimmed.toLowerCase()];
	if (aliased) return aliased;
	warnInvalidTheme(trimmed, DEFAULT_THEME);
	return DEFAULT_THEME;
}

function getDefaultAgentDir(): string | undefined {
	const home = process.env.HOME ?? "";
	return home ? join(home, ".pi/agent") : undefined;
}

function readThemeFromSettings(agentDir?: string): string | undefined {
	const resolvedAgentDir = agentDir ?? getDefaultAgentDir();
	if (!resolvedAgentDir) return undefined;

	try {
		const settings = JSON.parse(readFileSync(join(resolvedAgentDir, "settings.json"), "utf8")) as {
			theme?: unknown;
		};
		return typeof settings.theme === "string" ? settings.theme : undefined;
	} catch {
		return undefined;
	}
}

function resolvePrettyTheme(agentDir?: string): BundledTheme {
	const raw = process.env.FACELIFT_THEME ?? readThemeFromSettings(agentDir);
	return resolveBundledTheme(raw);
}

let THEME: BundledTheme = resolvePrettyTheme();

/** Test-only hooks for theme resolution (alias map, bundled validation, fallback warning). */
export const __themeInternals = {
	DEFAULT_THEME,
	THEME_ALIASES,
	isBundledTheme,
	resolveBundledTheme,
	resetWarningsForTests: () => _themeWarningShown.clear(),
};

function setPrettyTheme(agentDir?: string): void {
	const resolvedTheme = resolvePrettyTheme(agentDir);
	if (resolvedTheme === THEME) return;
	THEME = resolvedTheme;
	_cache.clear();
	_hlErrorLogged.clear();
	codeToANSI("", "typescript", THEME).catch(() => {});
}

function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

const MAX_HL_CHARS = envInt("FACELIFT_MAX_HL_CHARS", 80_000);
const MAX_PREVIEW_LINES = envInt("FACELIFT_MAX_PREVIEW_LINES", 80);
const CACHE_LIMIT = envInt("FACELIFT_CACHE_LIMIT", 128);

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

let RST = "\x1b[0m";
const BOLD = "\x1b[1m";

const FG_LNUM = "\x1b[38;2;100;100;100m";
const FG_DIM = "\x1b[38;2;80;80;80m";
const FG_RULE = "\x1b[38;2;50;50;50m";
const FG_GREEN = "\x1b[38;2;100;180;120m";
const FG_RED = "\x1b[38;2;200;100;100m";
const FG_YELLOW = "\x1b[38;2;220;180;80m";
const FG_BLUE = "\x1b[38;2;100;140;220m";
const FG_MUTED = "\x1b[38;2;139;148;158m";

const BG_DEFAULT = "\x1b[49m";
let BG_BASE = BG_DEFAULT; // tool box success/base bg — updated from theme's toolBg/background
// Note: pi-facelift no longer fills tool blocks with toolSuccessBg/toolErrorBg.
// Each tool sets `renderShell: "self"` and draws its own frame instead
// (see frameTop/frameBottom/frameBodyLines).

type BgTheme = { getBgAnsi?: (key: string) => string };
type FgTheme = { fg: (key: string, text: string) => string };

/** Parse an ANSI 24-bit color escape into { r, g, b }. Handles both fg (38;2) and bg (48;2). */
function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	const m = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

function getThemeBgAnsi(theme: BgTheme, key: string): string | null {
	try {
		const bgAnsi = theme.getBgAnsi?.(key);
		return bgAnsi && parseAnsiRgb(bgAnsi) ? bgAnsi : null;
	} catch {
		return null;
	}
}

/** Read themed tool background and update BG_BASE + RST.
 *  Recompute on each render so runtime theme changes are respected.
 *
 *  Used only to keep ANSI resets blending into the host theme's background
 *  on terminals that paint tool rows with a custom bg — the open-right
 *  frame itself never relies on a fill. */
function resolveBaseBackground(theme: BgTheme | null | undefined): void {
	if (!theme?.getBgAnsi) return;

	BG_BASE = getThemeBgAnsi(theme, "toolBg") ?? getThemeBgAnsi(theme, "background") ?? BG_DEFAULT;
	RST = `\x1b[0m${BG_BASE}`;
}

const ESC_RE = "\u001b";
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");

// ---------------------------------------------------------------------------
// Low-contrast fix (same as pi-diff)
// ---------------------------------------------------------------------------

function isLowContrastShikiFg(params: string): boolean {
	if (params === "30" || params === "90") return true;
	if (params === "38;5;0" || params === "38;5;8") return true;
	if (!params.startsWith("38;2;")) return false;
	const parts = params.split(";").map(Number);
	if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return false;
	const [, , r, g, b] = parts;
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance < 72;
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) => (isLowContrastShikiFg(params) ? FG_MUTED : seq));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function termW(): number {
	const stderrWithColumns = process.stderr as NodeJS.WriteStream & { columns?: number };
	const raw =
		process.stdout.columns || stderrWithColumns.columns || Number.parseInt(process.env.COLUMNS ?? "", 10) || 200;
	// pi-tui's `Text.render(width)` is called with `terminal.columns` (see
	// pi-tui/dist/tui.js — `const width = this.terminal.columns`). Frames must
	// match that exact width or Text.render pads the line with trailing spaces,
	// which used to leave a visible right-side gap on the open-right frame.
	return Math.max(1, raw);
}

/**
 * 1-based line number of the first character of `snippet` inside
 * `content`. Used by the `edit` tool wrapper to shift per-edit diff
 * line numbers so the rendered gutter matches the file (instead of
 * starting at 1 for every edit). Returns 1 when content is empty or
 * the snippet isn't found — best-effort fallback.
 */
function findLineOffset(content: string | null, snippet: string): number {
	if (!content || !snippet) return 1;
	const idx = content.indexOf(snippet);
	if (idx < 0) return 1;
	let line = 1;
	for (let i = 0; i < idx; i++) {
		if (content.charCodeAt(i) === 10) line += 1;
	}
	return line;
}

function shortPath(cwd: string, home: string, p: string): string {
	if (!p) return "";
	const r = relative(cwd, p);
	if (!r.startsWith("..") && !r.startsWith("/")) return r;
	return p.replace(home, "~");
}

function lnum(n: number, w: number): string {
	const v = String(n);
	return `${FG_LNUM}${" ".repeat(Math.max(0, w - v.length))}${v}${RST}`;
}

// ---------------------------------------------------------------------------
// Frame helpers now live in `@wierdbytes/pi-common/tool-frame`. Status
// border colours follow host theme tokens (`success` / `warning` /
// `error`) instead of the previous fixed RGB palette.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	less: "css",
	json: "json",
	jsonc: "jsonc",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	mdx: "mdx",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	php: "php",
	dart: "dart",
	xml: "xml",
	graphql: "graphql",
	svelte: "svelte",
	vue: "vue",
	dockerfile: "dockerfile",
	makefile: "make",
	zig: "zig",
	nim: "nim",
	elixir: "elixir",
	ex: "elixir",
	erb: "erb",
	hbs: "handlebars",
};

function lang(fp: string): BundledLanguage | undefined {
	const base = basename(fp).toLowerCase();
	if (base === "dockerfile") return "dockerfile";
	if (base === "makefile" || base === "gnumakefile") return "make";
	if (base === ".envrc" || base === ".env") return "bash";
	return EXT_LANG[extname(fp).slice(1).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Terminal image rendering (iTerm2 / Kitty / Ghostty inline image protocols)
// Handles tmux passthrough for image protocols.
// ---------------------------------------------------------------------------

type ImageProtocol = "iterm2" | "kitty" | "none";

let _tmuxClientTermCache: string | null | undefined;
let _tmuxAllowPassthroughCache: boolean | null | undefined;
let _tmuxClientTermOverrideForTests: string | null | undefined;
let _tmuxAllowPassthroughOverrideForTests: boolean | null | undefined;

function isTmuxSession(): boolean {
	return !!process.env.TMUX || /^(tmux|screen)/.test(process.env.TERM ?? "");
}

function normalizeTerminalName(term: string): string {
	const t = term.toLowerCase();
	if (t.includes("kitty")) return "kitty";
	if (t.includes("ghostty")) return "ghostty";
	if (t.includes("wezterm")) return "WezTerm";
	if (t.includes("iterm")) return "iTerm.app";
	if (t.includes("mintty")) return "mintty";
	return term;
}

function readTmuxClientTerm(): string | null {
	if (_tmuxClientTermOverrideForTests !== undefined) {
		return _tmuxClientTermOverrideForTests ? normalizeTerminalName(_tmuxClientTermOverrideForTests) : null;
	}
	if (!isTmuxSession()) return null;
	if (_tmuxClientTermCache !== undefined) return _tmuxClientTermCache;
	try {
		const term = childProcess
			.execFileSync("tmux", ["display-message", "-p", "#{client_termname}"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 200,
			})
			.trim();
		_tmuxClientTermCache = term ? normalizeTerminalName(term) : null;
	} catch {
		_tmuxClientTermCache = null;
	}
	return _tmuxClientTermCache;
}

/**
 * Detect the outer terminal when running inside tmux.
 * tmux sets TERM_PROGRAM=tmux, but the real terminal is often in
 * the environment of the tmux server or can be inferred.
 */
function getOuterTerminal(): string {
	// Environment hints that often survive inside tmux
	if (process.env.LC_TERMINAL === "iTerm2") return "iTerm.app";
	if (process.env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (process.env.KITTY_WINDOW_ID || process.env.KITTY_PID) return "kitty";
	if (process.env.WEZTERM_EXECUTABLE || process.env.WEZTERM_CONFIG_DIR || process.env.WEZTERM_CONFIG_FILE) {
		return "WezTerm";
	}

	const termProgram = process.env.TERM_PROGRAM ?? "";
	if (termProgram && termProgram !== "tmux" && termProgram !== "screen") {
		return normalizeTerminalName(termProgram);
	}

	const tmuxClientTerm = readTmuxClientTerm();
	if (tmuxClientTerm) return tmuxClientTerm;

	const term = process.env.TERM ?? "";
	if (term) return normalizeTerminalName(term);
	if (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit") return "unknown-modern";
	return termProgram;
}

function detectImageProtocol(): ImageProtocol {
	const forced = (process.env.FACELIFT_IMAGE_PROTOCOL ?? "").toLowerCase();
	if (forced === "kitty" || forced === "iterm2" || forced === "none") {
		return forced;
	}

	const term = getOuterTerminal();
	// Ghostty and Kitty use the Kitty graphics protocol
	if (term === "ghostty" || term === "kitty") return "kitty";
	// iTerm2, WezTerm, Mintty support the iTerm2 protocol
	if (["iTerm.app", "WezTerm", "mintty"].includes(term)) return "iterm2";
	if (process.env.LC_TERMINAL === "iTerm2") return "iterm2";
	return "none";
}

function tmuxAllowsPassthrough(): boolean | null {
	if (_tmuxAllowPassthroughOverrideForTests !== undefined) return _tmuxAllowPassthroughOverrideForTests;
	if (!isTmuxSession()) return null;
	if (_tmuxAllowPassthroughCache !== undefined) return _tmuxAllowPassthroughCache;
	try {
		const value = childProcess
			.execFileSync("tmux", ["show-options", "-gv", "allow-passthrough"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 200,
			})
			.trim()
			.toLowerCase();
		_tmuxAllowPassthroughCache = value === "on" || value === "all";
	} catch {
		_tmuxAllowPassthroughCache = null;
	}
	return _tmuxAllowPassthroughCache;
}

function getTmuxPassthroughWarning(protocol: ImageProtocol): string | null {
	if (!isTmuxSession() || protocol === "none") return null;
	if (tmuxAllowsPassthrough() === false) {
		return "tmux allow-passthrough is off. Run: tmux set -g allow-passthrough on";
	}
	return null;
}

/**
 * Wrap escape sequence for tmux passthrough.
 * tmux requires: ESC Ptmux; <escaped-sequence> ESC \
 * Inner ESC chars must be doubled.
 */
function tmuxWrap(seq: string): string {
	if (!isTmuxSession()) return seq;
	// Double all ESC chars inside the sequence
	const escaped = seq.split("\x1b").join("\x1b\x1b");
	return `\x1bPtmux;${escaped}\x1b\\`;
}

export const __imageInternals = {
	isTmuxSession,
	getOuterTerminal,
	detectImageProtocol,
	tmuxWrap,
	tmuxAllowsPassthrough,
	getTmuxPassthroughWarning,
	setTmuxClientTermOverrideForTests: (value: string | null | undefined) => {
		_tmuxClientTermOverrideForTests = value;
	},
	setTmuxAllowPassthroughOverrideForTests: (value: boolean | null | undefined) => {
		_tmuxAllowPassthroughOverrideForTests = value;
	},
	resetCachesForTests: () => {
		_tmuxClientTermCache = undefined;
		_tmuxAllowPassthroughCache = undefined;
		_tmuxClientTermOverrideForTests = undefined;
		_tmuxAllowPassthroughOverrideForTests = undefined;
	},
};

/**
 * Get human-readable file size
 */
function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// File-type icons — Nerd Font glyphs (Seti-UI + Devicons, stable in NF v3+)
//
// Requires a Nerd Font installed (e.g., JetBrainsMono Nerd Font, FiraCode NF).
// Fallback: set FACELIFT_ICONS=none to disable icons.
// ---------------------------------------------------------------------------

const ICONS_MODE = (process.env.FACELIFT_ICONS ?? "nerd").toLowerCase();
const USE_ICONS = ICONS_MODE !== "none" && ICONS_MODE !== "off";

// Nerd Font codepoints + ANSI color per file type
const NF_DIR = `${FG_BLUE}\ue5ff${RST}`; // folder
const NF_DEFAULT = `${FG_DIM}\uf15b${RST}`; // generic file

const EXT_ICON: Record<string, string> = {
	// TypeScript / JavaScript
	ts: `\x1b[38;2;49;120;198m\ue628${RST}`, // blue
	tsx: `\x1b[38;2;49;120;198m\ue7ba${RST}`, // react blue
	js: `\x1b[38;2;241;224;90m\ue74e${RST}`, // yellow
	jsx: `\x1b[38;2;97;218;251m\ue7ba${RST}`, // react cyan
	mjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,
	cjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,

	// Systems / Backend
	py: `\x1b[38;2;55;118;171m\ue73c${RST}`, // python blue
	rs: `\x1b[38;2;222;165;132m\ue7a8${RST}`, // rust orange
	go: `\x1b[38;2;0;173;216m\ue724${RST}`, // go cyan
	java: `\x1b[38;2;204;62;68m\ue738${RST}`, // java red
	swift: `\x1b[38;2;255;172;77m\ue755${RST}`, // swift orange
	rb: `\x1b[38;2;204;52;45m\ue739${RST}`, // ruby red
	kt: `\x1b[38;2;126;103;200m\ue634${RST}`, // kotlin purple
	c: `\x1b[38;2;85;154;211m\ue61e${RST}`, // c blue
	cpp: `\x1b[38;2;85;154;211m\ue61d${RST}`, // cpp blue
	h: `\x1b[38;2;140;160;185m\ue61e${RST}`, // header muted
	hpp: `\x1b[38;2;140;160;185m\ue61d${RST}`,
	cs: `\x1b[38;2;104;33;122m\ue648${RST}`, // c# purple

	// Web
	html: `\x1b[38;2;228;77;38m\ue736${RST}`, // html orange
	css: `\x1b[38;2;66;165;245m\ue749${RST}`, // css blue
	scss: `\x1b[38;2;207;100;154m\ue749${RST}`, // scss pink
	less: `\x1b[38;2;66;165;245m\ue749${RST}`,
	vue: `\x1b[38;2;65;184;131m\ue6a0${RST}`, // vue green
	svelte: `\x1b[38;2;255;62;0m\ue697${RST}`, // svelte red-orange

	// Config / Data
	json: `\x1b[38;2;241;224;90m\ue60b${RST}`, // json yellow
	jsonc: `\x1b[38;2;241;224;90m\ue60b${RST}`,
	yaml: `\x1b[38;2;160;116;196m\ue6a8${RST}`, // yaml purple
	yml: `\x1b[38;2;160;116;196m\ue6a8${RST}`,
	toml: `\x1b[38;2;160;116;196m\ue6b2${RST}`, // toml purple
	xml: `\x1b[38;2;228;77;38m\ue619${RST}`, // xml orange
	sql: `\x1b[38;2;218;218;218m\ue706${RST}`, // sql gray

	// Markdown / Docs
	md: `\x1b[38;2;66;165;245m\ue73e${RST}`, // markdown blue
	mdx: `\x1b[38;2;66;165;245m\ue73e${RST}`,

	// Shell / Scripts
	sh: `\x1b[38;2;137;180;130m\ue795${RST}`, // shell green
	bash: `\x1b[38;2;137;180;130m\ue795${RST}`,
	zsh: `\x1b[38;2;137;180;130m\ue795${RST}`,
	fish: `\x1b[38;2;137;180;130m\ue795${RST}`,
	lua: `\x1b[38;2;81;160;207m\ue620${RST}`, // lua blue
	php: `\x1b[38;2;137;147;186m\ue73d${RST}`, // php purple
	dart: `\x1b[38;2;87;182;240m\ue798${RST}`, // dart blue

	// Images
	png: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpeg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	gif: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	svg: `\x1b[38;2;255;180;50m\uf1c5${RST}`,
	webp: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	ico: `\x1b[38;2;160;116;196m\uf1c5${RST}`,

	// Misc
	lock: `\x1b[38;2;130;130;130m\uf023${RST}`, // lock gray
	env: `\x1b[38;2;241;224;90m\ue615${RST}`, // env yellow
	graphql: `\x1b[38;2;224;51;144m\ue662${RST}`, // graphql pink
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`,
};

const NAME_ICON: Record<string, string> = {
	"package.json": `\x1b[38;2;137;180;130m\ue71e${RST}`, // npm green
	"package-lock.json": `\x1b[38;2;130;130;130m\ue71e${RST}`, // npm gray
	"tsconfig.json": `\x1b[38;2;49;120;198m\ue628${RST}`, // ts blue
	"biome.json": `\x1b[38;2;96;165;250m\ue615${RST}`, // config blue
	".gitignore": `\x1b[38;2;222;165;132m\ue702${RST}`, // git orange
	".git": `\x1b[38;2;222;165;132m\ue702${RST}`,
	".env": `\x1b[38;2;241;224;90m\ue615${RST}`, // env yellow
	".envrc": `\x1b[38;2;241;224;90m\ue615${RST}`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`, // docker blue
	makefile: `\x1b[38;2;130;130;130m\ue615${RST}`, // make gray
	gnumakefile: `\x1b[38;2;130;130;130m\ue615${RST}`,
	"readme.md": `\x1b[38;2;66;165;245m\ue73e${RST}`, // readme blue
	license: `\x1b[38;2;218;218;218m\ue60a${RST}`, // license white
	"cargo.toml": `\x1b[38;2;222;165;132m\ue7a8${RST}`, // rust
	"go.mod": `\x1b[38;2;0;173;216m\ue724${RST}`, // go
	"pyproject.toml": `\x1b[38;2;55;118;171m\ue73c${RST}`, // python
};

function fileIcon(fp: string): string {
	if (!USE_ICONS) return "";
	const base = basename(fp).toLowerCase();
	if (NAME_ICON[base]) return `${NAME_ICON[base]} `;
	const ext = extname(fp).slice(1).toLowerCase();
	return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `;
}

function dirIcon(): string {
	return USE_ICONS ? `${NF_DIR} ` : "";
}

// ---------------------------------------------------------------------------
// Shiki ANSI cache
// ---------------------------------------------------------------------------

// Pre-warm
codeToANSI("", "typescript", THEME).catch(() => {});

const _cache = new Map<string, string[]>();
const _hlErrorLogged = new Set<string>();

function _touch(k: string, v: string[]): string[] {
	_cache.delete(k);
	_cache.set(k, v);
	while (_cache.size > CACHE_LIMIT) {
		const first = _cache.keys().next().value;
		if (first === undefined) break;
		_cache.delete(first);
	}
	return v;
}

async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	if (!code) return [""];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");

	const k = `${THEME}\0${language}\0${code}`;
	const hit = _cache.get(k);
	if (hit) return _touch(k, hit);

	try {
		const ansi = normalizeShikiContrast(await codeToANSI(code, language, THEME));
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return _touch(k, out);
	} catch (err) {
		// Log once per (theme, language) so silent regressions are visible
		// during dev (e.g. an unsupported theme name slipping through, or a
		// grammar load failure for a niche language) without spamming on
		// every render. The plain-text fallback below keeps the body usable.
		const tag = `${THEME}\0${language}`;
		if (!_hlErrorLogged.has(tag)) {
			_hlErrorLogged.add(tag);
			const msg = err instanceof Error ? err.message : String(err);
			console.error(
				`pi-facelift: shiki highlighting failed for theme="${THEME}" language="${language}": ${msg}`,
			);
		}
		return code.split("\n");
	}
}

/** Test-only hooks for the Shiki highlighter pipeline. */
export const __hlInternals = {
	hlBlock,
	resetErrorLogForTests: () => _hlErrorLogged.clear(),
	resetCacheForTests: () => _cache.clear(),
};

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Render syntax-highlighted file content with line numbers. */
async function renderFileContent(
	content: string,
	filePath: string,
	offset = 1,
	maxLines = MAX_PREVIEW_LINES,
): Promise<string> {
	const normalizedContent = normalizeLineEndings(content);
	const lines = normalizedContent.split("\n");
	const total = lines.length;
	const show = lines.slice(0, maxLines);
	const lg = lang(filePath);
	const hl = await hlBlock(show.join("\n"), lg);

	// Reserve 1 col for the outer frame's `│` rail (drawn later by
	// `frameBodyLines`) so the highlighted lines fit inside the frame.
	const tw = Math.max(1, termW() - 1);
	const startLine = offset;
	const endLine = startLine + show.length - 1;
	const nw = Math.max(3, String(endLine).length);
	const gw = nw + 3; // num + " │ "
	const cw = Math.max(1, tw - gw);

	const out: string[] = [];

	for (let i = 0; i < hl.length; i++) {
		const ln = startLine + i;
		const code = hl[i] ?? show[i] ?? "";
		const display = truncateToWidth(code, cw, `${FG_DIM}›`);
		out.push(`${lnum(ln, nw)} ${FG_RULE}│${RST} ${display}${RST}`);
	}

	if (total > maxLines) {
		out.push(`${FG_DIM}  … ${total - maxLines} more lines (${total} total)${RST}`);
	}
	return out.join("\n");
}

/** Render ls output as a tree view with icons. */
function renderTree(text: string, _basePath: string): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return `${FG_DIM}(empty directory)${RST}`;

	const out: string[] = [];
	const total = lines.length;
	const show = lines.slice(0, MAX_PREVIEW_LINES);

	for (let i = 0; i < show.length; i++) {
		const entry = show[i].trim();
		const isLast = i === show.length - 1 && total <= MAX_PREVIEW_LINES;
		const prefix = isLast ? "└── " : "├── ";
		const connector = `${FG_RULE}${prefix}${RST}`;

		// Detect directories (entries ending with /)
		const isDir = entry.endsWith("/");
		const name = isDir ? entry.slice(0, -1) : entry;
		const icon = isDir ? dirIcon() : fileIcon(name);
		const fg = isDir ? FG_BLUE + BOLD : "";
		const reset = isDir ? RST : "";

		out.push(`${connector}${icon}${fg}${name}${reset}`);
	}

	if (total > MAX_PREVIEW_LINES) {
		out.push(`${FG_RULE}└── ${RST}${FG_DIM}… ${total - MAX_PREVIEW_LINES} more entries${RST}`);
	}

	return out.join("\n");
}

/** Render find results grouped by directory with icons. */
function renderFindResults(text: string): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return `${FG_DIM}(no matches)${RST}`;

	// Group by directory
	const groups = new Map<string, string[]>();
	for (const line of lines) {
		const trimmed = line.trim();
		const dir = dirname(trimmed) || ".";
		const file = basename(trimmed);
		if (!groups.has(dir)) groups.set(dir, []);
		const bucket = groups.get(dir);
		if (bucket) bucket.push(file);
	}

	const out: string[] = [];
	let count = 0;

	for (const [dir, files] of groups) {
		if (count > 0) out.push(""); // blank line between groups
		out.push(`${dirIcon()}${FG_BLUE}${BOLD}${dir}/${RST}`);
		for (let i = 0; i < files.length; i++) {
			if (count >= MAX_PREVIEW_LINES) {
				out.push(`  ${FG_DIM}… ${lines.length - count} more files${RST}`);
				return out.join("\n");
			}
			const isLast = i === files.length - 1;
			const prefix = isLast ? "└── " : "├── ";
			const icon = fileIcon(files[i]);
			out.push(`  ${FG_RULE}${prefix}${RST}${icon}${files[i]}`);
			count++;
		}
	}

	return out.join("\n");
}

/** Render grep results with highlighted matches and line numbers. */
async function renderGrepResults(text: string, pattern: string): Promise<string> {
	const lines = normalizeLineEndings(text).split("\n");
	if (!lines.length || (lines.length === 1 && !lines[0].trim())) return `${FG_DIM}(no matches)${RST}`;

	const out: string[] = [];
	let currentFile = "";
	let count = 0;

	// Try to build a regex for highlighting
	let re: RegExp | null = null;
	try {
		re = new RegExp(`(${pattern})`, "gi");
	} catch {
		// invalid regex — skip highlighting
	}

	for (const line of lines) {
		if (count >= MAX_PREVIEW_LINES) {
			out.push(`${FG_DIM}  … more matches${RST}`);
			break;
		}

		// ripgrep-style: "file:line:content" or "file-line-content" or just "file"
		const fileMatch = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
		if (fileMatch) {
			const [, file, lineNo, content] = fileMatch;
			if (file !== currentFile) {
				if (currentFile) out.push(""); // blank line between files
				const icon = fileIcon(file);
				out.push(`${icon}${FG_BLUE}${BOLD}${file}${RST}`);
				currentFile = file;
			}

			const nw = Math.max(3, lineNo.length);
			let display = content;
			if (re) {
				display = content.replace(re, `${RST}${FG_YELLOW}${BOLD}$1${RST}`);
			}
			out.push(`  ${lnum(Number(lineNo), nw)} ${FG_RULE}│${RST} ${display}${RST}`);
			count++;
		} else if (line.trim() === "--") {
			// ripgrep separator
			out.push(`  ${FG_DIM}  ···${RST}`);
		} else if (line.trim()) {
			out.push(line);
			count++;
		}
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// SDK tool wiring — shared types + helpers for the wrapped read/bash/ls/find/grep
// tool definitions registered below.
// ---------------------------------------------------------------------------

type ToolTextContent = TextContent;
type ToolImageContent = ImageContent;
type ToolContent = TextContent | ImageContent;
type ToolResultLike<TDetails = unknown> = AgentToolResult<TDetails | undefined>;
type TextComponentLike = { setText(value: string): void; getText?: () => string };
type TextComponentCtor = new (text?: string, x?: number, y?: number) => TextComponentLike;
type ThemeLike = BgTheme & FgTheme & { bold: (text: string) => string };

/**
 * Cast the loose `ThemeLike` (used by the duck-typed render hooks) to the
 * real `Theme` class expected by the shared
 * `@wierdbytes/pi-common/tool-frame` helpers. The helpers only call
 * `theme.fg(token, str)`, which `ThemeLike` already provides, so the cast
 * is structurally safe at runtime.
 */
const asTheme = (theme: ThemeLike): Theme => theme as unknown as Theme;
type RenderContextLike<TState extends Record<string, unknown> = Record<string, unknown>> = {
	lastComponent?: TextComponentLike;
	state: TState;
	expanded: boolean;
	isError: boolean;
	/** Streaming/pending flag from pi core's ToolRenderContext. Optional in tests. */
	isPartial?: boolean;
	/** Whether `execute()` has actually started (true once pi calls markExecutionStarted). */
	executionStarted?: boolean;
	invalidate: () => void;
};
type SessionContextLike = ExtensionContext;
type CommandContextLike = ExtensionCommandContext;
type ToolExecutor<TParams, TDetails = unknown> = (
	toolCallId: string,
	params: TParams,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails | undefined>,
	ctx?: ExtensionContext,
) => Promise<ToolResultLike<TDetails>>;
type ToolFactory<TParams, TDetails = unknown> = (cwd: string) => {
	name?: string;
	description?: string;
	label?: string;
	parameters?: unknown;
	execute: ToolExecutor<TParams, TDetails>;
};
type PiFaceliftSdk = {
	createReadToolDefinition?: ToolFactory<ReadToolInput>;
	createReadTool?: ToolFactory<ReadToolInput>;
	createBashToolDefinition?: ToolFactory<BashToolInput>;
	createBashTool?: ToolFactory<BashToolInput>;
	createLsToolDefinition?: ToolFactory<LsToolInput>;
	createLsTool?: ToolFactory<LsToolInput>;
	createFindToolDefinition?: ToolFactory<FindToolInput>;
	createFindTool?: ToolFactory<FindToolInput>;
	createGrepToolDefinition?: ToolFactory<GrepToolInput>;
	createGrepTool?: ToolFactory<GrepToolInput>;
	createWriteToolDefinition?: ToolFactory<WriteToolInput>;
	createWriteTool?: ToolFactory<WriteToolInput>;
	createEditToolDefinition?: ToolFactory<EditToolInput, EditToolDetails>;
	createEditTool?: ToolFactory<EditToolInput, EditToolDetails>;
	getAgentDir?: () => string;
};
type PiFaceliftApi = {
	registerTool: (tool: unknown) => void;
	registerCommand: (
		name: string,
		command: {
			description?: string;
			handler: (args: string, ctx: CommandContextLike) => Promise<void> | void;
		},
	) => void;
	on: (event: string, handler: (event: unknown, ctx: SessionContextLike) => Promise<void> | void) => void;
};
type ReadParams = ReadToolInput;
type BashParams = BashToolInput;
type LsParams = LsToolInput;
type FindParams = FindToolInput;
type GrepParams = GrepToolInput;
type WriteParams = WriteToolInput;
type EditParams = EditToolInput;
type ReadRenderState = { _rk?: string; _rt?: string };
type GrepRenderState = { _gk?: string; _gt?: string };
type WriteRenderState = { _wk?: string; _wt?: string };
type EditRenderState = { _ek?: string; _et?: string };
type BashRenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: NodeJS.Timeout;
};
type FindResultDetails = { _type: "findResult"; text: string; pattern: string; matchCount: number };
type GrepResultDetails = { _type: "grepResult"; text: string; pattern: string; matchCount: number };
type WriteResultDetails =
	| { _type: "writeDiff"; filePath: string; diff: ParsedDiff; language: string | undefined }
	| { _type: "writeNew"; filePath: string; content: string; lineCount: number; language: string | undefined }
	| { _type: "writeNoChange"; filePath: string };
type EditResultDetails = {
	_type: "editDiff";
	filePath: string;
	edits: Array<{ oldText: string; newText: string; diff: ParsedDiff }>;
	totalAdded: number;
	totalRemoved: number;
	language: string | undefined;
};
type RenderDetails =
	| { _type: "readImage"; filePath: string; data: string; mimeType: string }
	| { _type: "readFile"; filePath: string; content: string; offset: number; lineCount: number }
	| { _type: "bashResult"; text: string; exitCode: number | null; command: string }
	| { _type: "lsResult"; text: string; path: string; entryCount: number }
	| FindResultDetails
	| GrepResultDetails
	| WriteResultDetails
	| EditResultDetails;

function isTextContent(content: ToolContent): content is ToolTextContent {
	return content.type === "text";
}

function isImageContent(content: ToolContent): content is ToolImageContent {
	return content.type === "image";
}

function getTextContent(result: ToolResultLike): string {
	return (
		result.content
			?.filter(isTextContent)
			.map((content) => content.text || "")
			.join("\n") ?? ""
	);
}

function setResultDetails<T>(result: ToolResultLike, details: T): void {
	result.details = details;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Dependencies that can be injected for testing.
 * In production, omit `deps` — the extension uses the statically-imported
 * SDK (`@earendil-works/pi-coding-agent`) and pi-tui `Text` component.
 */
export interface PiFaceliftDeps {
	sdk: PiFaceliftSdk;
	TextComponent: TextComponentCtor;
}

export default function piFaceliftExtension(pi: PiFaceliftApi, deps?: PiFaceliftDeps): void {
	let createReadTool: ToolFactory<ReadToolInput> | undefined;
	let createBashTool: ToolFactory<BashToolInput> | undefined;
	let createLsTool: ToolFactory<LsToolInput> | undefined;
	let createFindTool: ToolFactory<FindToolInput> | undefined;
	let createGrepTool: ToolFactory<GrepToolInput> | undefined;
	let createWriteTool: ToolFactory<WriteToolInput> | undefined;
	let createEditTool: ToolFactory<EditToolInput, EditToolDetails> | undefined;
	let TextComponent: TextComponentCtor;

	let sdk: PiFaceliftSdk;

	if (deps) {
		// Test path: use injected dependencies
		sdk = deps.sdk;
		createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
		createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
		createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
		createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
		createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;
		createWriteTool = sdk.createWriteToolDefinition ?? sdk.createWriteTool;
		createEditTool = sdk.createEditToolDefinition ?? sdk.createEditTool;
		TextComponent = deps.TextComponent;
	} else {
		// Production path: use the statically-imported SDK + pi-tui Text.
		sdk = piCodingAgentSdk as unknown as PiFaceliftSdk;
		createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
		createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
		createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
		createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
		createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;
		createWriteTool = sdk.createWriteToolDefinition ?? sdk.createWriteTool;
		createEditTool = sdk.createEditToolDefinition ?? sdk.createEditTool;
		TextComponent = PiText as unknown as TextComponentCtor;
	}
	if (!createReadTool || !TextComponent) return;

	const cwd = process.cwd();
	const home = process.env.HOME ?? "";
	const sp = (p: string) => shortPath(cwd, home, p);

	const getAgentDir = sdk.getAgentDir;
	setPrettyTheme(
		(() => {
			try {
				return getAgentDir?.() ?? getDefaultAgentDir();
			} catch {
				return getDefaultAgentDir();
			}
		})(),
	);

	// Pre-load diff palette (env vars + ~/.pi/settings.json overrides). Cheap
	// and idempotent — `resolveDiffColors` auto-derives bg tints from the
	// host theme later anyway.
	applyDiffPalette();

	// Load (or seed) the per-package config at
	// `~/.pi/agent/wierd-facelift/config.json`. Held in a closure-local
	// `let` so the `/facelift` settings modal can mutate it without going
	// through a global. `decideDiffLayout` reads this object directly.
	let faceliftConfig: WierdFaceliftConfig = (() => {
		try {
			return loadFaceliftConfig();
		} catch {
			return faceliftEnvDefaults();
		}
	})();

	// ===================================================================
	// read — syntax-highlighted file content
	// ===================================================================

	const origRead = createReadTool(cwd);

	pi.registerTool({
		...origRead,
		name: "read",
		renderShell: "self",

		async execute(
			tid: string,
			params: ReadParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		) {
			const result = (await origRead.execute(tid, params, sig, upd, ctx)) as ToolResultLike;

			const fp = params.path ?? "";
			const offset = params.offset ?? 1;

			const imageBlock = result.content?.find(isImageContent);
			if (imageBlock) {
				setResultDetails(result, {
					_type: "readImage",
					filePath: fp,
					data: imageBlock.data,
					mimeType: imageBlock.mimeType ?? "image/png",
				});
				return result;
			}

			const textContent = getTextContent(result);
			if (textContent && fp) {
				const normalizedContent = normalizeLineEndings(textContent);
				const lineCount = normalizedContent.split("\n").length;
				setResultDetails(result, {
					_type: "readFile",
					filePath: fp,
					content: normalizedContent,
					offset,
					lineCount,
				});
			}

			return result;
		},

		renderCall(args: ReadParams, theme: ThemeLike, ctx: RenderContextLike) {
			resolveBaseBackground(theme);
			const fp = args.path ?? "";
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			const offset = args.offset ? ` ${theme.fg("muted", `from line ${args.offset}`)}` : "";
			const limit = args.limit ? ` ${theme.fg("muted", `(${args.limit} lines)`)}` : "";
			const title = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", sp(fp))}${offset}${limit}`;
			text.setText(frameTop(title, getFrameStatus(ctx), asTheme(theme), termW()));
			return text;
		},

		renderResult(
			result: ToolResultLike,
			_opt: ToolRenderResultOptions,
			theme: ThemeLike,
			ctx: RenderContextLike<ReadRenderState>,
		) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			const status = getFrameStatus(ctx);
			const t = asTheme(theme);
			const w = termW();

			if (ctx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", t, w));
				return text;
			}

			const d = result.details as RenderDetails | undefined;

			// Image reads keep the original image content so Pi's native TUI renderer
			// can display it exactly once. pi-facelift only renders metadata here;
			// rendering another inline image caused duplicate previews.
			if (d?._type === "readImage") {
				const byteSize = Math.ceil(((d.data as string).length * 3) / 4);
				const sizeStr = humanSize(byteSize);
				const mimeStr = d.mimeType ?? "image";

				text.setText(frameResult(`${fileIcon(d.filePath)}${FG_DIM}${mimeStr} · ${sizeStr}${RST}`, status, t, w));
				return text;
			}

			if (d?._type === "readFile" && d.content) {
				const key = `read:${d.filePath}:${d.offset}:${d.lineCount}:${w}:${status}`;
				if (ctx.state._rk !== key) {
					ctx.state._rk = key;
					// Initial render: just the frame chrome until shiki resolves.
					// Once `renderFileContent` returns we re-cache with the highlighted body.
					ctx.state._rt = frameResult("", status, t, w);

					const maxShow = ctx.expanded ? d.lineCount : MAX_PREVIEW_LINES;
					renderFileContent(d.content, d.filePath, d.offset, maxShow)
						.then((rendered: string) => {
							if (ctx.state._rk !== key) return;
							ctx.state._rt = frameResult(rendered, status, t, w);
							ctx.invalidate();
						})
						.catch((err: unknown) => {
							// Surface to stderr so silent regressions in the highlighter
							// (e.g. a stale helper reference) are visible during dev
							// instead of producing an empty-body frame.
							const msg = err instanceof Error ? err.message : String(err);
							console.error(`pi-facelift: read render failed: ${msg}`);
						});
				}
				text.setText(ctx.state._rt ?? frameResult("", status, t, w));
				return text;
			}

			// Fallback
			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "read";
			text.setText(frameResult(theme.fg("dim", String(fallbackText).slice(0, 120)), status, t, w));
			return text;
		},
	});

	// ===================================================================
	// bash — colored exit status
	// ===================================================================

	if (createBashTool) {
		const origBash = createBashTool(cwd);

		pi.registerTool({
			...origBash,
			name: "bash",
			renderShell: "self",

			async execute(
				tid: string,
				params: BashParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const result = (await origBash.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
				const textContent = getTextContent(result);

				let exitCode: number | null = 0;
				if (textContent) {
					const exitMatch = textContent.match(/(?:exit code|exited with|exit status)[:\s]*(\d+)/i);
					if (exitMatch) exitCode = Number(exitMatch[1]);
					if (textContent.includes("command not found") || textContent.includes("No such file")) {
						exitCode = 1;
					}
				}

				setResultDetails(result, {
					_type: "bashResult",
					text: textContent ?? "",
					exitCode,
					command: params.command ?? "",
				});

				return result;
			},

			renderCall(args: BashParams, theme: ThemeLike, ctx: RenderContextLike<BashRenderState>) {
				resolveBaseBackground(theme);
				const cmd = args.command ?? "";
				const t = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const state = ctx.state;
				if (ctx.executionStarted && state.startedAt === undefined) {
					state.startedAt = Date.now();
					state.endedAt = undefined;
				}
				const timeout = args.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";

				// Multi-line bash commands (shell line continuations with `\`, here-docs,
				// or embedded newlines) need each line wrapped in the accent color
				// separately so the color survives line splitting in `frameTop`. Leading
				// whitespace on continuation lines is dropped — the sub-tree connector
				// already provides visual indentation, so the user's heredoc indent
				// would just push content right and misalign the tree.
				//
				// The full command is always rendered in the title — no length-based
				// truncation in compact mode. `frameTop` still right-truncates any
				// individual line that exceeds the frame width, which is a separate
				// (display-fit) concern from hiding command content.
				const cmdLines = cmd.split("\n");
				const firstCmd = cmdLines[0];
				const restCmd = cmdLines.slice(1).map((line) => line.replace(/^\s+/, ""));
				const firstTitle = `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", firstCmd)}${timeout}`;
				const title = [firstTitle, ...restCmd.map((line) => theme.fg("accent", line))].join("\n");
				t.setText(frameTop(title, getFrameStatus(ctx), asTheme(theme), termW()));
				return t;
			},

			renderResult(
				result: ToolResultLike,
				opt: ToolRenderResultOptions,
				theme: ThemeLike,
				ctx: RenderContextLike<BashRenderState>,
			) {
				resolveBaseBackground(theme);
				const t = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const status = getFrameStatus(ctx);
				const frameTheme = asTheme(theme);
				const frameWidth = termW();
				const state = ctx.state;

				// Live timer: tick every second while still streaming, freeze on final/error.
				const stillRunning = !!opt.isPartial && !ctx.isError;
				if (state.startedAt !== undefined && stillRunning && !state.interval) {
					state.interval = setInterval(() => ctx.invalidate(), 1000);
				}
				if (!stillRunning) {
					if (state.startedAt !== undefined) state.endedAt ??= Date.now();
					if (state.interval) {
						clearInterval(state.interval);
						state.interval = undefined;
					}
				}

				// Resolve the body text + status (works for success, error, streaming, fallback).
				const d = result.details as RenderDetails | undefined;
				let bodyText = d?._type === "bashResult" ? d.text : (getTextContent(result) ?? "");
				let exitCode: number | null = d?._type === "bashResult" ? d.exitCode : null;
				let timedOut = false;
				let aborted = false;

				// pi's bash appends `Command exited with code N` / `Command timed out…` /
				// `Command aborted` to the result text on failure. Lift that line into the
				// bottom-border label so the body stays clean and the summary is consistent.
				const tail = bodyText.match(
					/(?:\n\n|^)Command (?:exited with code (\d+)|timed out after \d+ seconds|aborted)\s*$/,
				);
				if (tail) {
					if (tail[1]) exitCode = Number(tail[1]);
					else if (/timed out/.test(tail[0])) timedOut = true;
					else if (/aborted/.test(tail[0])) aborted = true;
					bodyText = bodyText.slice(0, tail.index);
				}
				if (exitCode === null && !opt.isPartial && !ctx.isError) exitCode = 0;

				// Build the bottom-border label: `<duration> <icon> exit <N> (<lines>)`.
				const elapsedMs = state.startedAt !== undefined ? (state.endedAt ?? Date.now()) - state.startedAt : undefined;
				const durationStr = elapsedMs !== undefined ? `${FG_DIM}${formatDuration(elapsedMs)}${RST}` : "";

				let summary = "";
				if (!opt.isPartial) {
					if (timedOut) summary = `${FG_YELLOW}⚡ timed out${RST}`;
					else if (aborted) summary = `${FG_YELLOW}⚡ aborted${RST}`;
					else if (exitCode !== null) {
						const isOk = exitCode === 0;
						summary = `${isOk ? FG_GREEN : FG_RED}${isOk ? "✓" : "✗"} exit ${exitCode}${RST}`;
					}
				}

				const lines = bodyText.length > 0 ? bodyText.split("\n") : [];
				const lineCount = lines.length;
				const lineInfo = summary && lineCount > 1 ? ` ${FG_DIM}(${lineCount} lines)${RST}` : "";
				const labelParts = [durationStr, summary].filter(Boolean);
				const label = labelParts.length ? `${labelParts.join(" ")}${lineInfo}` : "";

				// Render body lines (preview-truncated when collapsed).
				const maxShow = ctx.expanded ? lineCount : MAX_PREVIEW_LINES;
				const show = lines.slice(0, Math.max(0, maxShow));
				const out: string[] = [...show];
				if (lineCount > maxShow) {
					out.push(`${FG_DIM}… ${lineCount - maxShow} more lines${RST}`);
				}
				const body = out.join("\n");

				if (label) {
					t.setText(frameResultWithBottomLabel(body, label, status, frameTheme, frameWidth));
				} else {
					t.setText(frameResult(body, status, frameTheme, frameWidth));
				}
				return t;
			},
		});
	}

	// ===================================================================
	// ls — tree view with icons
	// ===================================================================

	if (createLsTool) {
		const origLs = createLsTool(cwd);

		pi.registerTool({
			...origLs,
			name: "ls",
			renderShell: "self",

			async execute(
				tid: string,
				params: LsParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const result = (await origLs.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
				const textContent = getTextContent(result);
				const fp = params.path ?? cwd;
				const entryCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				setResultDetails(result, {
					_type: "lsResult",
					text: textContent ?? "",
					path: fp,
					entryCount,
				});

				return result;
			},

			renderCall(args: LsParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const fp = args.path ?? ".";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const title = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", sp(fp))}`;
				text.setText(frameTop(title, getFrameStatus(ctx), asTheme(theme), termW()));
				return text;
			},

			renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const status = getFrameStatus(ctx);
				const t = asTheme(theme);
				const w = termW();

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", t, w));
					return text;
				}

				const d = result.details as RenderDetails | undefined;
				if (d?._type === "lsResult" && d.text) {
					const tree = renderTree(d.text, d.path);
					const info = `${FG_DIM}${d.entryCount} entries${RST}`;
					text.setText(frameResultWithBottomLabel(tree, info, status, t, w));
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "listed";
				text.setText(frameResult(theme.fg("dim", String(fallbackText).slice(0, 120)), status, t, w));
				return text;
			},
		});
	}

	// ===================================================================
	// find — grouped file list with icons
	// ===================================================================

	if (createFindTool) {
		const origFind = createFindTool(cwd);

		pi.registerTool({
			...origFind,
			name: "find",
			renderShell: "self",

			async execute(
				tid: string,
				params: FindParams,
				sig: AbortSignal | undefined,
				upd: unknown,
				ctx: ExtensionContext,
			) {
				const result = await origFind.execute(tid, params, sig, upd as never, ctx);
				const textContent = getTextContent(result);
				const matchCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				setResultDetails<FindResultDetails>(result, {
					_type: "findResult",
					text: textContent,
					pattern: params.pattern,
					matchCount,
				});

				return result;
			},

			renderCall(args: FindParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const pattern = args.pattern ?? "";
				const path = args.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const title = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${path}`;
				text.setText(frameTop(title, getFrameStatus(ctx), asTheme(theme), termW()));
				return text;
			},

			renderResult(
				result: ToolResultLike<FindResultDetails>,
				_opt: ToolRenderResultOptions,
				theme: ThemeLike,
				ctx: RenderContextLike,
			) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const status = getFrameStatus(ctx);
				const t = asTheme(theme);
				const w = termW();

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", t, w));
					return text;
				}

				const d = result.details;
				if (d?._type === "findResult" && d.text) {
					const rendered = renderFindResults(d.text);
					const info = `${FG_DIM}${d.matchCount} files${RST}`;
					text.setText(frameResultWithBottomLabel(rendered, info, status, t, w));
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "found";
				text.setText(frameResult(theme.fg("dim", String(fallbackText).slice(0, 120)), status, t, w));
				return text;
			},
		});
	}

	// ===================================================================
	// grep — highlighted matches with line numbers
	// ===================================================================

	if (createGrepTool) {
		const origGrep = createGrepTool(cwd);

		pi.registerTool({
			...origGrep,
			name: "grep",
			renderShell: "self",

			async execute(
				tid: string,
				params: GrepParams,
				sig: AbortSignal | undefined,
				upd: unknown,
				ctx: ExtensionContext,
			) {
				const result = await origGrep.execute(tid, params, sig, upd as never, ctx);
				const textContent = normalizeLineEndings(getTextContent(result));
				if (result.content) {
					for (const content of result.content) {
						if (isTextContent(content)) content.text = normalizeLineEndings(content.text || "");
					}
				}
				const matchCount = textContent
					? textContent
							.trim()
							.split("\n")
							.filter((line) => /^.+?[:-]\d+[:-]/.test(line)).length
					: 0;

				setResultDetails<GrepResultDetails>(result, {
					_type: "grepResult",
					text: textContent,
					pattern: params.pattern,
					matchCount,
				});

				return result;
			},

			renderCall(args: GrepParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const pattern = args.pattern ?? "";
				const path = args.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const glob = args.glob ? ` ${theme.fg("muted", `(${args.glob})`)}` : "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const title = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", pattern)}${path}${glob}`;
				text.setText(frameTop(title, getFrameStatus(ctx), asTheme(theme), termW()));
				return text;
			},

			renderResult(
				result: ToolResultLike<GrepResultDetails>,
				_opt: ToolRenderResultOptions,
				theme: ThemeLike,
				ctx: RenderContextLike<GrepRenderState>,
			) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const status = getFrameStatus(ctx);
				const t = asTheme(theme);
				const w = termW();

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", t, w));
					return text;
				}

				const d = result.details;
				if (d?._type === "grepResult" && d.text) {
					const key = `grep:${d.pattern}:${d.matchCount}:${w}:${status}`;
					if (ctx.state._gk !== key) {
						ctx.state._gk = key;
						const info = `${FG_DIM}${d.matchCount} matches${RST}`;
						ctx.state._gt = frameResultWithBottomLabel("", info, status, t, w);

						renderGrepResults(d.text, d.pattern)
							.then((rendered: string) => {
								if (ctx.state._gk !== key) return;
								ctx.state._gt = frameResultWithBottomLabel(rendered, info, status, t, w);
								ctx.invalidate();
							})
							.catch((err: unknown) => {
								const msg = err instanceof Error ? err.message : String(err);
								console.error(`pi-facelift: grep render failed: ${msg}`);
							});
					}
					text.setText(
						ctx.state._gt ?? frameResultWithBottomLabel("", `${FG_DIM}${d.matchCount} matches${RST}`, status, t, w),
					);
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "searched";
				text.setText(frameResult(theme.fg("dim", String(fallbackText).slice(0, 120)), status, t, w));
				return text;
			},
		});
	}

	// ===================================================================
	// Shared layout decision — honors the `diffLayout` knob in the
	// facelift config (~/.pi/agent/wierd-facelift/config.json), settable
	// via the `/facelift` slash command.
	//
	// In "consistent" mode (the default) a single tool call decides one
	// layout for every diff it shows: split iff every diff fits without
	// excessive wrapping, otherwise unified for all. This stops the
	// `Edit 1/2 = split, Edit 2/2 = unified` visual mix you'd otherwise
	// get when one edit happens to contain very long lines.
	// ===================================================================
	const decideDiffLayout = (
		diffs: ParsedDiff[],
		innerW: number,
		maxLines: number,
	): DiffLayout | undefined => {
		const pref = faceliftConfig.diffLayout;
		if (pref === "split") return "split";
		if (pref === "unified") return "unified";
		if (pref === "per-edit") return undefined;
		// "consistent" (default)
		if (diffs.length === 0) return undefined;
		const allFit = diffs.every((d) => canRenderSplit(d, innerW, maxLines));
		return allFit ? "split" : "unified";
	};

	// ===================================================================
	// /facelift slash command — opens the settings overlay (matches the
	// /voice and /web conventions). Bare `/facelift` opens the modal;
	// `/facelift status` prints the current config + path; `/facelift
	// reset` restores defaults.
	// ===================================================================
	const persistFaceliftConfig = (extCtx: ExtensionContext): void => {
		try {
			saveFaceliftConfig(faceliftConfig);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			extCtx.ui.notify(
				`pi-facelift: failed to save config to ${getFaceliftConfigPath()}: ${msg}`,
				"error",
			);
		}
	};

	const diffLayoutLabels: Record<DiffLayoutPreference, string> = {
		consistent: "consistent (same layout for every edit in a call)",
		split: "split (always side-by-side)",
		unified: "unified (always stacked)",
		"per-edit": "per-edit (each diff decides independently)",
	};

	const openFaceliftSettings = async (extCtx: ExtensionContext): Promise<void> => {
		const fields: Field[] = [
			{
				key: "diffLayout",
				type: "enum",
				label: "Diff layout",
				description:
					"How to lay out write/edit diffs. `consistent` keeps every edit in one tool call on the same layout (split when all fit, unified when any would wrap). The other modes force a specific layout or let each edit decide.",
				value: faceliftConfig.diffLayout,
				options: VALID_DIFF_LAYOUTS,
				optionLabels: diffLayoutLabels,
			},
		];
		await openSettingsModal(extCtx, {
			title: "@wierdbytes/pi-facelift",
			fields,
			onChange: (key, value) => {
				if (key === "diffLayout") {
					faceliftConfig = { ...faceliftConfig, diffLayout: value as DiffLayoutPreference };
					persistFaceliftConfig(extCtx);
				}
			},
		});
	};

	const showFaceliftStatus = (extCtx: ExtensionContext): void => {
		const lines = [
			`config:     ${getFaceliftConfigPath()}`,
			`diffLayout: ${faceliftConfig.diffLayout}`,
		];
		extCtx.ui.notify(`@wierdbytes/pi-facelift\n${lines.join("\n")}`, "info");
	};

	const resetFaceliftConfig = (extCtx: ExtensionContext): void => {
		faceliftConfig = faceliftEnvDefaults();
		persistFaceliftConfig(extCtx);
		extCtx.ui.notify("pi-facelift: config reset to defaults.", "info");
	};

	pi.registerCommand("facelift", {
		description:
			"Open the @wierdbytes/pi-facelift settings overlay (no args). Subcommands: status | reset",
		handler: async (args: string, extCtx: ExtensionCommandContext) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				await openFaceliftSettings(extCtx);
				return;
			}
			const [sub] = trimmed.split(/\s+/, 1);
			if (sub === "status") {
				showFaceliftStatus(extCtx);
				return;
			}
			if (sub === "reset") {
				resetFaceliftConfig(extCtx);
				return;
			}
			extCtx.ui.notify(
				"Usage: /facelift [status|reset]  (no args ⇒ open settings overlay)",
				"warning",
			);
		},
		getArgumentCompletions: (prefix: string) => {
			const subs = ["status", "reset"];
			const lcPrefix = prefix.toLowerCase();
			return subs.filter((s) => s.startsWith(lcPrefix)).map((s) => ({ value: s, label: s }));
		},
	});

	// ===================================================================
	// Per-path mutation lock
	// -------------------------------------------------------------------
	// Both `write` and `edit` snapshot the file *before* delegating to the
	// built-in tool's execute(). When two mutations to the same path are
	// queued concurrently the built-in tool serializes the actual write,
	// but our pre-execute snapshots run in parallel — so the second call
	// would diff against the file state from *before* the first call, not
	// the state the first call left behind. Result: stale, misleading
	// diffs in the rendered output.
	//
	// We fix it here (not in the built-in tool) by chaining
	// snapshot→execute pairs per resolved path. The chain is purely
	// in-process and only covers mutations going through our wrapper;
	// external writers (other processes, the user) are still racy, but
	// that's the same correctness contract the built-in tool already has.
	// ===================================================================

	const pathMutationTails = new Map<string, Promise<void>>();
	function serializePerPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
		if (!path) return fn();
		const key = (() => {
			try {
				return resolvePath(path);
			} catch {
				return path;
			}
		})();
		const prev = pathMutationTails.get(key) ?? Promise.resolve();
		// `prev.then(fn, fn)` — run fn after prev settles, regardless of
		// whether prev rejected. We must not let an earlier failure poison
		// later snapshots on the same path.
		const result = prev.then(fn, fn);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		pathMutationTails.set(key, tail);
		tail.then(() => {
			// Drop the entry only if no newer caller has chained onto us;
			// otherwise we'd unblock callers waiting in the chain.
			if (pathMutationTails.get(key) === tail) pathMutationTails.delete(key);
		});
		return result;
	}

	// ===================================================================
	// write — split diff (or syntax-highlighted preview for new files)
	// ===================================================================

	if (createWriteTool) {
		const origWrite = createWriteTool(cwd);

		pi.registerTool({
			...origWrite,
			name: "write",
			renderShell: "self",

			async execute(
				tid: string,
				params: WriteParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const fp = params.path ?? "";
				// Snapshot + execute must run atomically per-path so concurrent
				// writes to the same file don't both diff against the same
				// stale pre-state.
				const { oldContent, result } = await serializePerPath(fp, async () => {
					let snapshot: string | null = null;
					try {
						if (fp && existsSync(fp)) snapshot = readFileSync(fp, "utf-8");
					} catch {
						snapshot = null;
					}
					const r = (await origWrite.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
					return { oldContent: snapshot, result: r };
				});
				const newContent = params.content ?? "";
				const language = diffLang(fp);

				if (oldContent === null) {
					const lineCount = newContent ? newContent.split("\n").length : 0;
					setResultDetails<WriteResultDetails>(result, {
						_type: "writeNew",
						filePath: fp,
						content: newContent,
						lineCount,
						language,
					});
				} else if (oldContent === newContent) {
					setResultDetails<WriteResultDetails>(result, { _type: "writeNoChange", filePath: fp });
				} else {
					const diff = parseDiff(oldContent, newContent);
					setResultDetails<WriteResultDetails>(result, {
						_type: "writeDiff",
						filePath: fp,
						diff,
						language,
					});
				}
				return result;
			},

			renderCall(args: WriteParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const fp = args.path ?? "";
				const isNew = !fp || !existsSync(fp);
				const label = isNew ? "create" : "write";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const title = `${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", sp(fp))}`;
				text.setText(frameTop(title, getFrameStatus(ctx), asTheme(theme), termW()));
				return text;
			},

			renderResult(
				result: ToolResultLike,
				_opt: ToolRenderResultOptions,
				theme: ThemeLike,
				ctx: RenderContextLike<WriteRenderState>,
			) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const status = getFrameStatus(ctx);
				const t = asTheme(theme);
				const w = termW();

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", t, w));
					return text;
				}

				const d = result.details as RenderDetails | undefined;
				const dc: DiffColors = resolveDiffColors(theme);

				if (d?._type === "writeNoChange") {
					const lab = `${FG_DIM}✓ no changes${RST}`;
					text.setText(frameResultWithBottomLabel("", lab, status, t, w));
					return text;
				}

				if (d?._type === "writeNew") {
					const lab = `${FG_GREEN}✓ new file${RST} ${FG_DIM}(${d.lineCount} lines)${RST}`;
					// Diff/preview output is always rendered in full — no compact
					// mode, no `… N more lines` footer — so `ctx.expanded` is
					// irrelevant to the rendered body and stays out of the key.
					const key = `writeNew:${themeCacheKey(theme)}:${d.filePath}:${d.lineCount}:${w}:${status}`;
					if (ctx.state._wk !== key) {
						ctx.state._wk = key;
						ctx.state._wt = frameResultWithBottomLabel("", lab, status, t, w);
						if (d.content) {
							hlDiffBlock(d.content, d.language)
								.then((hlLines: string[]) => {
									if (ctx.state._wk !== key) return;
									const body = hlLines.join("\n");
									ctx.state._wt = frameResultWithBottomLabel(body, lab, status, t, w);
									ctx.invalidate();
								})
								.catch((err: unknown) => {
									const msg = err instanceof Error ? err.message : String(err);
									console.error(`pi-facelift: write render failed: ${msg}`);
								});
						}
					}
					text.setText(ctx.state._wt ?? frameResultWithBottomLabel("", lab, status, t, w));
					return text;
				}

				if (d?._type === "writeDiff") {
					// `+A -B` already conveys the change size. We used to append
					// `(N diff lines)` to hint at how much was hidden under the
					// preview cap, but that cap is gone (we always render the
					// whole diff). N also included context + hunk separators, so
					// it never matched A+B and just looked like a miscount.
					const lab = summarizeDiff(d.diff.added, d.diff.removed);
					// Diff output is always rendered in full — no compact mode,
					// no `… N more lines` footer — so `ctx.expanded` is
					// irrelevant to the rendered body and stays out of the key.
					const key = `writeDiff:${themeCacheKey(theme)}:${d.filePath}:${d.diff.added}:${d.diff.removed}:${d.diff.lines.length}:${w}:${status}`;
					if (ctx.state._wk !== key) {
						ctx.state._wk = key;
						ctx.state._wt = frameResultWithBottomLabel("", lab, status, t, w);
						const maxLines = d.diff.lines.length;
						const innerW = Math.max(40, w - 1);
						const layout = decideDiffLayout([d.diff], innerW, maxLines);
						// Reserve 1 col for the outer frame rail.
						renderSplit(d.diff, d.language, maxLines, dc, innerW, { frameless: true, layout })
							.then((rendered: string) => {
								if (ctx.state._wk !== key) return;
								ctx.state._wt = frameResultWithBottomLabel(rendered, lab, status, t, w);
								ctx.invalidate();
							})
							.catch((err: unknown) => {
								const msg = err instanceof Error ? err.message : String(err);
								console.error(`pi-facelift: write diff render failed: ${msg}`);
							});
					}
					text.setText(ctx.state._wt ?? frameResultWithBottomLabel("", lab, status, t, w));
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "written";
				text.setText(frameResult(theme.fg("dim", String(fallbackText).slice(0, 120)), status, t, w));
				return text;
			},
		});
	}

	// ===================================================================
	// edit — per-edit split diffs with shared summary
	// ===================================================================

	if (createEditTool) {
		const origEdit = createEditTool(cwd);

		const getEditOperations = (input: Partial<EditToolInput>): Array<{ oldText: string; newText: string }> => {
			if (Array.isArray(input?.edits)) {
				return input.edits
					.map((edit) => ({
						oldText:
							typeof (edit as { oldText?: unknown })?.oldText === "string"
								? ((edit as { oldText: string }).oldText)
								: typeof (edit as { old_text?: unknown })?.old_text === "string"
									? ((edit as { old_text: string }).old_text)
									: "",
						newText:
							typeof (edit as { newText?: unknown })?.newText === "string"
								? ((edit as { newText: string }).newText)
								: typeof (edit as { new_text?: unknown })?.new_text === "string"
									? ((edit as { new_text: string }).new_text)
									: "",
					}))
					.filter((edit) => edit.oldText && edit.oldText !== edit.newText);
			}
			const legacy = input as { oldText?: unknown; old_text?: unknown; newText?: unknown; new_text?: unknown };
			const oldText =
				typeof legacy.oldText === "string"
					? legacy.oldText
					: typeof legacy.old_text === "string"
						? legacy.old_text
						: "";
			const newText =
				typeof legacy.newText === "string"
					? legacy.newText
					: typeof legacy.new_text === "string"
						? legacy.new_text
						: "";
			return oldText && oldText !== newText ? [{ oldText, newText }] : [];
		};

		pi.registerTool({
			...origEdit,
			name: "edit",
			renderShell: "self",

			async execute(
				tid: string,
				params: EditParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<EditToolDetails | undefined> | undefined,
				ctx: ExtensionContext,
			) {
				const fp = params.path ?? "";
				// Snapshot the file BEFORE the edit so each edit's diff knows
				// where its `oldText` actually lives in the file. Without this,
				// `parseDiff(op.oldText, op.newText)` numbers every diff from
				// line 1 and the rendered gutter ends up off by the line
				// offset of the edit inside the file.
				//
				// Pair the snapshot with the underlying execute() inside a
				// per-path lock so concurrent edits to the same file don't
				// both snapshot the same stale pre-state and render diffs
				// against the wrong baseline.
				const { preEditFile, result } = await serializePerPath(fp, async () => {
					let snapshot: string | null = null;
					try {
						if (fp && existsSync(fp)) snapshot = readFileSync(fp, "utf-8");
					} catch {
						snapshot = null;
					}
					const r = (await origEdit.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
					return { preEditFile: snapshot, result: r };
				});
				const ops = getEditOperations(params);
				if (ops.length === 0) return result;

				const language = diffLang(fp);
				// `cumulativeDelta` tracks the net line shift introduced by
				// earlier edits in this same tool call. The model conventionally
				// emits edits in file order so this is correct for the common
				// case; out-of-order edits at most produce slightly off new-side
				// numbers (old-side numbers stay accurate since we always
				// resolve against the pre-edit snapshot).
				let cumulativeDelta = 0;
				const edits = ops.map((op) => {
					const diff = parseDiff(op.oldText, op.newText);
					const oldOffset = findLineOffset(preEditFile, op.oldText);
					const newOffset = oldOffset + cumulativeDelta;
					if (oldOffset !== 1 || cumulativeDelta !== 0) {
						for (const line of diff.lines) {
							if (line.oldNum !== null) line.oldNum += oldOffset - 1;
							if (line.newNum !== null) line.newNum += newOffset - 1;
						}
					}
					cumulativeDelta += diff.added - diff.removed;
					return { oldText: op.oldText, newText: op.newText, diff };
				});
				const totalAdded = edits.reduce((acc, e) => acc + e.diff.added, 0);
				const totalRemoved = edits.reduce((acc, e) => acc + e.diff.removed, 0);

				setResultDetails<EditResultDetails>(result, {
					_type: "editDiff",
					filePath: fp,
					edits,
					totalAdded,
					totalRemoved,
					language,
				});
				return result;
			},

			renderCall(args: EditParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const fp = args.path ?? "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const title = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", sp(fp))}`;
				text.setText(frameTop(title, getFrameStatus(ctx), asTheme(theme), termW()));
				return text;
			},

			renderResult(
				result: ToolResultLike,
				_opt: ToolRenderResultOptions,
				theme: ThemeLike,
				ctx: RenderContextLike<EditRenderState>,
			) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const status = getFrameStatus(ctx);
				const t = asTheme(theme);
				const w = termW();

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", t, w));
					return text;
				}

				const d = result.details as RenderDetails | undefined;
				if (d?._type !== "editDiff") {
					const fallback = result.content?.[0];
					const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "edited";
					text.setText(frameResult(theme.fg("dim", String(fallbackText).slice(0, 120)), status, t, w));
					return text;
				}

				const dc: DiffColors = resolveDiffColors(theme);
				const editCount = d.edits.length;
				const summary = summarizeDiff(d.totalAdded, d.totalRemoved);
				// `+A -B` already conveys the change size. We used to append
				// `(N diff lines)` here, but N counted context rows + hunk
				// separators on top of A+B, so it never matched the +A -B
				// summary and looked like a miscount. With always-full
				// rendering there's nothing useful to disambiguate either.
				//
				// `N edits` keeps the same FG_DIM the old parenthetical used:
				// it's a quiet meta-label so the colored +A -B summary stays
				// the visual anchor of the bottom border.
				const editsCountLabel =
					editCount === 1 ? `${FG_DIM}1 edit${RST}` : `${FG_DIM}${editCount} edits${RST}`;
				const lab = `${editsCountLabel} ${summary}`;

				// Every edit block is rendered in full — no compact mode,
				// no `… N more edit blocks` footer, no per-edit line cap —
				// so `ctx.expanded` doesn't affect the body and stays out of
				// the key.
				const key = `editDiff:${themeCacheKey(theme)}:${d.filePath}:${editCount}:${d.totalAdded}:${d.totalRemoved}:${w}:${status}`;
				if (ctx.state._ek !== key) {
					ctx.state._ek = key;
					ctx.state._et = frameResultWithBottomLabel("", lab, status, t, w);

					const innerW = Math.max(40, w - 1);

					// Pick one layout for every edit in this call ("consistent" mode,
					// the default) so we never end up with `Edit 1 split, Edit 2
					// unified`. The user can override via .pi/settings.json's
					// `diffLayout` ("split"/"unified"/"per-edit"). We probe layout
					// with the longest edit so a single tall diff doesn't force
					// every other edit into unified mode unnecessarily.
					const probeCap = Math.max(
						1,
						...d.edits.map((e) => e.diff.lines.length),
					);
					const layout = decideDiffLayout(
						d.edits.map((e) => e.diff),
						innerW,
						probeCap,
					);

					Promise.all(
						d.edits.map((edit, idx) =>
							renderSplit(
								edit.diff,
								d.language,
								edit.diff.lines.length,
								dc,
								innerW,
								{ frameless: true, layout },
							)
								.then((rendered) =>
									editCount > 1
										? `${FG_DIM}Edit ${idx + 1}/${editCount}${RST} ${summarizeDiff(edit.diff.added, edit.diff.removed)}\n${rendered}`
										: rendered,
								)
								.catch(() =>
									editCount > 1
										? `${FG_DIM}Edit ${idx + 1}/${editCount}${RST} ${summarizeDiff(edit.diff.added, edit.diff.removed)}`
										: summarizeDiff(edit.diff.added, edit.diff.removed),
								),
						),
					)
						.then((sections) => {
							if (ctx.state._ek !== key) return;
							ctx.state._et = frameResultWithBottomLabel(sections.join("\n\n"), lab, status, t, w);
							ctx.invalidate();
						})
						.catch((err: unknown) => {
							const msg = err instanceof Error ? err.message : String(err);
							console.error(`pi-facelift: edit diff render failed: ${msg}`);
						});
				}

				text.setText(ctx.state._et ?? frameResultWithBottomLabel("", lab, status, t, w));
				return text;
			},
		});
	}

}
