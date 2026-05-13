/**
 * @wierdbytes/pi-common/diff — Shiki-powered terminal diff renderer.
 *
 * Ports the rendering core of `@heyhuynhgiabuu/pi-diff` (split + unified
 * side-by-side views with word-level emphasis) so other extensions in
 * this monorepo can render write/edit diffs without depending on the
 * external package.
 *
 * Public API (composition pattern):
 *
 *     import {
 *       parseDiff,
 *       renderSplit,
 *       renderUnified,
 *       resolveDiffColors,
 *       applyDiffPalette,
 *       lang,
 *       summarize,
 *       themeCacheKey,
 *     } from "@wierdbytes/pi-common/diff";
 *
 *     applyDiffPalette(); // once at extension boot
 *     const diff = parseDiff(oldText, newText);
 *     const colors = resolveDiffColors(theme);
 *     const body = await renderSplit(diff, lang(filePath), 60, colors, width, {
 *       frameless: true, // omit top/bottom rule lines if you wrap in your own frame
 *     });
 *
 * Both `renderSplit` and `renderUnified` return an ANSI string. Lines
 * already include themed backgrounds, so wrap callers should reserve
 * the right number of columns for any outer frame chrome (typically one
 * column for the left rail).
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

import { codeToANSI } from "@shikijs/cli";
import * as Diff from "diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single diff line (context / addition / deletion / hunk separator). */
export interface DiffLine {
	type: "ctx" | "add" | "del" | "sep";
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

/** Parsed diff with line list + summary stats. */
export interface ParsedDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
	chars: number;
}

/** Diff foreground colors resolved from the host theme. */
export interface DiffColors {
	fgAdd: string;
	fgDel: string;
	fgCtx: string;
}

/** Which side-by-side / stacked layout to use when rendering a diff. */
export type DiffLayout = "split" | "unified";

/**
 * User-facing preference for picking a layout across one tool call:
 *
 *   • `"consistent"` (default) — all diffs in the same call share one
 *     layout: `split` if **every** diff fits without excessive wrapping,
 *     `unified` otherwise. Avoids mixing layouts within a single edit.
 *   • `"split"` — always render side-by-side, even if long lines wrap.
 *   • `"unified"` — always render stacked single-column.
 *   • `"per-edit"` — each diff picks its own layout based on wrap fit
 *     (original pi-diff behaviour; can produce mixed layouts in one call).
 */
export type DiffLayoutPreference = "consistent" | "split" | "unified" | "per-edit";

/** Optional knobs for the split/unified renderers. */
export interface DiffRenderOptions {
	/**
	 * When `true`, skip the surrounding rule lines (`────`) at the top
	 * and bottom of the rendered diff. Use this when wrapping the output
	 * in an external frame (e.g. `@wierdbytes/pi-common/tool-frame`) so
	 * the borders don't double up.
	 */
	frameless?: boolean;
	/**
	 * Force a specific layout, bypassing the wrap-fit heuristic. When
	 * omitted, `renderSplit` auto-falls back to `renderUnified` for
	 * diffs that would wrap excessively.
	 */
	layout?: DiffLayout;
}

/** Minimal duck-typed Theme surface used for color resolution. */
export interface DiffThemeLike {
	fg?: (key: string, text: string) => string;
	bold?: (text: string) => string;
	getFgAnsi?: (key: string) => string;
	getBgAnsi?: (key: string) => string;
	bg?: (key: string, text: string) => string;
}

// ---------------------------------------------------------------------------
// Config / Presets
// ---------------------------------------------------------------------------

interface DiffPreset {
	name: string;
	description: string;
	bgAdd?: string;
	bgDel?: string;
	bgAddHighlight?: string;
	bgDelHighlight?: string;
	bgGutterAdd?: string;
	bgGutterDel?: string;
	bgEmpty?: string;
	fgAdd?: string;
	fgDel?: string;
	fgDim?: string;
	fgLnum?: string;
	fgRule?: string;
	fgStripe?: string;
	fgSafeMuted?: string;
	shikiTheme?: string;
}

const DIFF_PRESETS: Record<string, DiffPreset> = {
	default: {
		name: "default",
		description: "Original pi-diff colors — tuned for dark theme bases (~#1e1e2e)",
		bgAdd: "#162620",
		bgDel: "#2d1919",
		bgAddHighlight: "#234b32",
		bgDelHighlight: "#502323",
		bgGutterAdd: "#12201a",
		bgGutterDel: "#261616",
		bgEmpty: "#121212",
		fgDim: "#505050",
		fgLnum: "#646464",
		fgRule: "#323232",
		fgStripe: "#282828",
		fgSafeMuted: "#8b949e",
	},
	midnight: {
		name: "midnight",
		description: "Subtle tints for pure black (#000000) terminal backgrounds",
		bgAdd: "#0d1a12",
		bgDel: "#1a0d0d",
		bgAddHighlight: "#1a3825",
		bgDelHighlight: "#381a1a",
		bgGutterAdd: "#091208",
		bgGutterDel: "#120908",
		bgEmpty: "#080808",
		fgDim: "#404040",
		fgLnum: "#505050",
		fgRule: "#282828",
		fgStripe: "#1e1e1e",
		fgSafeMuted: "#8b949e",
	},
	subtle: {
		name: "subtle",
		description: "Minimal backgrounds — barely-there tints for a clean look",
		bgAdd: "#081008",
		bgDel: "#100808",
		bgAddHighlight: "#122818",
		bgDelHighlight: "#281212",
		bgGutterAdd: "#060c06",
		bgGutterDel: "#0c0606",
		bgEmpty: "#060606",
		fgDim: "#383838",
		fgLnum: "#484848",
		fgRule: "#242424",
		fgStripe: "#181818",
		fgSafeMuted: "#8b949e",
	},
	neon: {
		name: "neon",
		description: "Higher contrast backgrounds for better visibility",
		bgAdd: "#1a3320",
		bgDel: "#331a16",
		bgAddHighlight: "#2d5c3a",
		bgDelHighlight: "#5c2d2d",
		bgGutterAdd: "#142818",
		bgGutterDel: "#28120e",
		bgEmpty: "#141414",
		fgDim: "#606060",
		fgLnum: "#787878",
		fgRule: "#404040",
		fgStripe: "#303030",
		fgSafeMuted: "#9da5ae",
	},
};

const SPLIT_MIN_WIDTH = envInt("DIFF_SPLIT_MIN_WIDTH", 150);
const SPLIT_MIN_CODE_WIDTH = envInt("DIFF_SPLIT_MIN_CODE_WIDTH", 60);
const SPLIT_MAX_WRAP_RATIO = 0.2;
const SPLIT_MAX_WRAP_LINES = 8;
const MAX_HL_CHARS = envInt("DIFF_MAX_HL_CHARS", 80_000);
const CACHE_LIMIT = envInt("DIFF_CACHE_LIMIT", 192);
const WORD_DIFF_MIN_SIM = 0.15;
const MAX_WRAP_ROWS_WIDE = 3;
const MAX_WRAP_ROWS_MED = 2;
const MAX_WRAP_ROWS_NARROW = 1;
const DEFAULT_RENDER_WIDTH = 120;
const MIN_RENDER_WIDTH = 40;

// ---------------------------------------------------------------------------
// ANSI state — mutable so applyDiffPalette / resolveDiffColors can update
// ---------------------------------------------------------------------------

// Plain reset. We intentionally do NOT redefine RST to re-apply BG_BASE here:
// the diff renderer is designed to be embedded inside an outer frame (see
// `@wierdbytes/pi-common/tool-frame`), and a sticky BG_BASE would leak past
// the trailing `\n` of the diff body into the frame's bottom border, painting
// the closing `╰── … ────` row in a different bg from the opening row.
//
// Background roles after the 0.4.x ctx/chrome split:
//   • BG_BASE  — internal only. Auto-derived from `toolSuccessBg` and
//     used as the mixing base for BG_ADD/BG_DEL gradients. No longer
//     painted directly anywhere in the rendered output.
//   • BG_CTX   — unchanged ("ctx") code rows. Terminal default so the
//     user can tell "this line did not change" apart from chrome at
//     a glance.
//   • BG_EMPTY — diff chrome (empty filler halves opposite an unpaired
//     add/del, hunk separators, the rule helper, the `… more lines`
//     footer). Auto-derived from `theme.userMessageBg` so it matches
//     the host UI's secondary surface (e.g. Tokyo Night's #292e42), or
//     falls back to a neutral dark gray when the theme is unavailable.
//     This keeps "missing-line" fillers visually distinct from real
//     context rows (which use the terminal default) and from
//     success-bg-tinted +/- rows.
const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

let BG_ADD = envBg("DIFF_BG_ADD", "\x1b[48;2;22;38;32m");
let BG_DEL = envBg("DIFF_BG_DEL", "\x1b[48;2;45;25;25m");
let BG_ADD_W = envBg("DIFF_BG_ADD_HL", "\x1b[48;2;35;75;50m");
let BG_DEL_W = envBg("DIFF_BG_DEL_HL", "\x1b[48;2;80;35;35m");
let BG_GUTTER_ADD = envBg("DIFF_BG_GUTTER_ADD", "\x1b[48;2;18;32;26m");
let BG_GUTTER_DEL = envBg("DIFF_BG_GUTTER_DEL", "\x1b[48;2;38;22;22m");
// Fallback for BG_EMPTY when the host theme doesn't expose a
// `userMessageBg` we can pull. Kept as a module-level constant so theme
// changes can reset BG_EMPTY back to a known default before the next
// auto-derive pass runs.
const BG_EMPTY_FALLBACK = "\x1b[48;2;18;18;18m";
let BG_EMPTY = envBg("DIFF_BG_EMPTY", BG_EMPTY_FALLBACK);

let FG_ADD = envFg("DIFF_FG_ADD", "\x1b[38;2;100;180;120m");
let FG_DEL = envFg("DIFF_FG_DEL", "\x1b[38;2;200;100;100m");
let FG_DIM = "\x1b[38;2;80;80;80m";
let FG_LNUM = "\x1b[38;2;100;100;100m";
let FG_RULE = "\x1b[38;2;50;50;50m";
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";
let FG_STRIPE = "\x1b[38;2;40;40;40m";

const BORDER_BAR = "▌";
const BG_DEFAULT = "\x1b[49m";

let BG_BASE = BG_DEFAULT;
// Background for context rows (unchanged lines). Pinned to the terminal
// default (== `\x1b[49m`) so unchanged code reads as "untinted text"
// against whatever surrounds the diff block — distinct from diff chrome
// (BG_EMPTY) and changed rows (BG_ADD/BG_DEL).
let BG_CTX = BG_DEFAULT;
let DIVIDER = `${FG_RULE}│${RST}`;
let DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };

const ESC_RE = "\u001b";
const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([^m]*)m`, "g");
const ANSI_PARAM_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");

let THEME: string = process.env.DIFF_THEME ?? "github-dark";
let paletteApplied = false;

let _autoDerivePending = true;
let _hasExplicitBgConfig = false;
let _lastResolvedThemeKey = "";

// ---------------------------------------------------------------------------
// Env / config helpers
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFg(name: string, fallback: string): string {
	const hex = process.env[name];
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
	return hexToFgAnsi(hex) || fallback;
}

function envBg(name: string, fallback: string): string {
	const hex = process.env[name];
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
	return hexToBgAnsi(hex) || fallback;
}

function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	const match = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	return match ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) } : null;
}

function hexToBgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function hexToFgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function mixBg(
	base: { r: number; g: number; b: number },
	accent: { r: number; g: number; b: number },
	intensity: number,
): string {
	const r = Math.round(base.r + (accent.r - base.r) * intensity);
	const g = Math.round(base.g + (accent.g - base.g) * intensity);
	const b = Math.round(base.b + (accent.b - base.b) * intensity);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function autoDeriveBgFromTheme(theme: DiffThemeLike): void {
	if (!theme?.getFgAnsi) return;
	try {
		const fgAddAnsi = theme.getFgAnsi("toolDiffAdded");
		const fgDelAnsi = theme.getFgAnsi("toolDiffRemoved");
		const addRgb = parseAnsiRgb(fgAddAnsi);
		const delRgb = parseAnsiRgb(fgDelAnsi);
		if (!addRgb || !delRgb) return;

		let addBase = { r: 0, g: 0, b: 0 };
		let delBase = addBase;
		if (theme.getBgAnsi) {
			try {
				const successBgAnsi = theme.getBgAnsi("toolSuccessBg");
				const successParsed = parseAnsiRgb(successBgAnsi);
				if (successParsed) {
					addBase = successParsed;
					delBase = successParsed;
					BG_BASE = successBgAnsi;
				}
			} catch {
				/* no toolSuccessBg — use black */
			}
			try {
				const errorParsed = parseAnsiRgb(theme.getBgAnsi("toolErrorBg"));
				if (errorParsed) delBase = errorParsed;
			} catch {
				/* no toolErrorBg — use toolSuccessBg/black */
			}
		}

		BG_ADD = mixBg(addBase, addRgb, 0.08);
		BG_DEL = mixBg(delBase, delRgb, 0.1);
		BG_ADD_W = mixBg(addBase, addRgb, 0.2);
		BG_DEL_W = mixBg(delBase, delRgb, 0.22);
		BG_GUTTER_ADD = mixBg(addBase, addRgb, 0.05);
		BG_GUTTER_DEL = mixBg(delBase, delRgb, 0.06);

		// Pull chrome bg from the host UI's user-message surface so the
		// diff renderer's "missing line" fillers / separators / footer
		// blend with the rest of pi's TUI instead of standing out as
		// arbitrary dark gray. Falls through to BG_EMPTY_FALLBACK when
		// the theme doesn't expose this token (e.g. tests, custom
		// themes pre-userMessageBg). Crucially NOT `toolSuccessBg`:
		// that's the +add tint, and chrome must read as neutral.
		if (theme.getBgAnsi) {
			try {
				const userBgAnsi = theme.getBgAnsi("userMessageBg" as never);
				if (userBgAnsi && parseAnsiRgb(userBgAnsi)) BG_EMPTY = userBgAnsi;
			} catch {
				/* theme has no userMessageBg — keep current BG_EMPTY */
			}
		}

		// Note: RST stays a plain `\x1b[0m` — see the const declaration for
		// why we don't bake BG_BASE into it.
		DIVIDER = `${FG_RULE}│${RST}`;
	} catch {
		// silent fall back to defaults
	}
}

interface DiffConfig {
	diffTheme?: keyof typeof DIFF_PRESETS | string;
	diffColors?: Record<string, string>;
}

function loadDiffConfig(): DiffConfig {
	const paths = [`${process.cwd()}/.pi/settings.json`, `${process.env.HOME ?? ""}/.pi/settings.json`];
	for (const path of paths) {
		try {
			if (existsSync(path)) {
				const raw = JSON.parse(readFileSync(path, "utf-8")) as DiffConfig;
				if (raw.diffTheme || raw.diffColors) {
					return { diffTheme: raw.diffTheme, diffColors: raw.diffColors };
				}
			}
		} catch {
			/* skip invalid files */
		}
	}
	return {};
}

/**
 * Apply the diff palette from `.pi/settings.json` (project then global)
 * → named preset → defaults. Idempotent — safe to call from multiple
 * extensions. Should be called once at extension boot, before the first
 * render.
 */
export function applyDiffPalette(): void {
	if (paletteApplied) return;
	paletteApplied = true;

	const config = loadDiffConfig();
	const preset = config.diffTheme ? DIFF_PRESETS[config.diffTheme as keyof typeof DIFF_PRESETS] : null;
	if (preset) _hasExplicitBgConfig = true;

	const overrides = config.diffColors ?? {};
	if (Object.keys(overrides).length > 0) _hasExplicitBgConfig = true;

	const applyBg = (
		envName: string | null,
		key: string,
		presetValue: string | undefined,
		set: (ansi: string) => void,
	): void => {
		if (envName && process.env[envName]) return;
		const hex = overrides[key] ?? presetValue;
		if (hex) {
			const ansi = hexToBgAnsi(hex);
			if (ansi) set(ansi);
		}
	};

	const applyFg = (
		envName: string | null,
		key: string,
		presetValue: string | undefined,
		set: (ansi: string) => void,
	): void => {
		if (envName && process.env[envName]) return;
		const hex = overrides[key] ?? presetValue;
		if (hex) {
			const ansi = hexToFgAnsi(hex);
			if (ansi) set(ansi);
		}
	};

	applyBg("DIFF_BG_ADD", "bgAdd", preset?.bgAdd, (v) => {
		BG_ADD = v;
	});
	applyBg("DIFF_BG_DEL", "bgDel", preset?.bgDel, (v) => {
		BG_DEL = v;
	});
	applyBg("DIFF_BG_ADD_HL", "bgAddHighlight", preset?.bgAddHighlight, (v) => {
		BG_ADD_W = v;
	});
	applyBg("DIFF_BG_DEL_HL", "bgDelHighlight", preset?.bgDelHighlight, (v) => {
		BG_DEL_W = v;
	});
	applyBg("DIFF_BG_GUTTER_ADD", "bgGutterAdd", preset?.bgGutterAdd, (v) => {
		BG_GUTTER_ADD = v;
	});
	applyBg("DIFF_BG_GUTTER_DEL", "bgGutterDel", preset?.bgGutterDel, (v) => {
		BG_GUTTER_DEL = v;
	});
	applyBg("DIFF_BG_EMPTY", "bgEmpty", preset?.bgEmpty, (v) => {
		BG_EMPTY = v;
	});

	applyFg("DIFF_FG_ADD", "fgAdd", preset?.fgAdd, (v) => {
		FG_ADD = v;
	});
	applyFg("DIFF_FG_DEL", "fgDel", preset?.fgDel, (v) => {
		FG_DEL = v;
	});
	applyFg(null, "fgDim", preset?.fgDim, (v) => {
		FG_DIM = v;
	});
	applyFg(null, "fgLnum", preset?.fgLnum, (v) => {
		FG_LNUM = v;
	});
	applyFg(null, "fgRule", preset?.fgRule, (v) => {
		FG_RULE = v;
	});
	applyFg(null, "fgStripe", preset?.fgStripe, (v) => {
		FG_STRIPE = v;
	});
	applyFg(null, "fgSafeMuted", preset?.fgSafeMuted, (v) => {
		FG_SAFE_MUTED = v;
	});

	const shiki = overrides.shikiTheme ?? preset?.shikiTheme;
	if (shiki) THEME = shiki;

	DIVIDER = `${FG_RULE}│${RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
	_autoDerivePending = !_hasExplicitBgConfig;

	// Pre-warm shiki — first call loads WASM + grammar (~200-500ms).
	codeToANSI("", "typescript", THEME).catch(() => {});
}

/**
 * Stable cache key for the theme's color tokens. Used to detect when the
 * host theme changes between renders so derived backgrounds get
 * re-computed.
 */
export function themeCacheKey(theme: DiffThemeLike | null | undefined): string {
	if (!theme?.fg) return "no-theme";
	const fgKeys = [
		"toolTitle",
		"accent",
		"muted",
		"success",
		"error",
		"toolDiffAdded",
		"toolDiffRemoved",
		"toolDiffContext",
	];
	const bgKeys = ["toolSuccessBg", "toolErrorBg"];
	const parts: string[] = [];
	for (const key of fgKeys) {
		try {
			parts.push(theme.fg(key, key));
		} catch {
			parts.push(key);
		}
	}
	for (const key of bgKeys) {
		try {
			parts.push(theme.bg ? theme.bg(key, key) : key);
		} catch {
			parts.push(key);
		}
	}
	return parts.join("|");
}

/**
 * Resolve diff foreground colors from the host theme (with hardcoded
 * fallbacks). On first call with a valid theme — and whenever the theme
 * cache key changes — auto-derives subtle bg colors that blend with
 * `toolSuccessBg`/`toolErrorBg`. Returns `{ fgAdd, fgDel, fgCtx }`.
 */
export function resolveDiffColors(theme: DiffThemeLike | null | undefined): DiffColors {
	const currentThemeKey = themeCacheKey(theme ?? undefined);
	if (!_hasExplicitBgConfig && _lastResolvedThemeKey && _lastResolvedThemeKey !== currentThemeKey) {
		BG_BASE = BG_DEFAULT;
		// Reset BG_EMPTY to the fallback so the new theme's userMessageBg
		// (re)applies on the next auto-derive pass instead of carrying
		// over the previous theme's value.
		BG_EMPTY = BG_EMPTY_FALLBACK;
		_autoDerivePending = true;
	}
	_lastResolvedThemeKey = currentThemeKey;

	if (theme?.getBgAnsi && BG_BASE === BG_DEFAULT) {
		try {
			const bgAnsi = theme.getBgAnsi("toolSuccessBg");
			const parsed = parseAnsiRgb(bgAnsi);
			if (parsed) {
				BG_BASE = bgAnsi;
			}
		} catch {
			/* ignore */
		}
	}

	if (_autoDerivePending && theme?.getFgAnsi) {
		autoDeriveBgFromTheme(theme);
		_autoDerivePending = false;
	}

	if (!theme?.getFgAnsi) return DEFAULT_DIFF_COLORS;
	try {
		return {
			fgAdd: theme.getFgAnsi("toolDiffAdded") || FG_ADD,
			fgDel: theme.getFgAnsi("toolDiffRemoved") || FG_DEL,
			fgCtx: theme.getFgAnsi("toolDiffContext") || FG_DIM,
		};
	} catch {
		return DEFAULT_DIFF_COLORS;
	}
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_LANG: Record<string, string> = {
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
};

/** Detect a Shiki language id from a file path's extension. */
export function lang(filePath: string): string | undefined {
	return EXT_LANG[extname(filePath).slice(1).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse two text blobs into a diff-line list using `diff` package's
 * `structuredPatch`. Hunk separators are emitted as `{ type: "sep" }`
 * with `newNum` carrying the gap line count.
 */
export function parseDiff(oldContent: string, newContent: string, ctx = 3): ParsedDiff {
	const patch = Diff.structuredPatch("", "", oldContent, newContent, "", "", { context: ctx });
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	for (let hi = 0; hi < patch.hunks.length; hi++) {
		if (hi > 0) {
			const prev = patch.hunks[hi - 1];
			const gap = patch.hunks[hi].oldStart - (prev.oldStart + prev.oldLines);
			lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" });
		}
		const h = patch.hunks[hi];
		let oL = h.oldStart;
		let nL = h.newStart;
		for (const raw of h.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const ch = raw[0];
			const text = raw.slice(1);
			if (ch === "+") {
				lines.push({ type: "add", oldNum: null, newNum: nL++, content: text });
				added++;
			} else if (ch === "-") {
				lines.push({ type: "del", oldNum: oL++, newNum: null, content: text });
				removed++;
			} else {
				lines.push({ type: "ctx", oldNum: oL++, newNum: nL++, content: text });
			}
		}
	}
	return { lines, added, removed, chars: oldContent.length + newContent.length };
}

/** Compact `+N -M` summary string with diff fg colors. */
export function summarize(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0) parts.push(`${FG_ADD}+${added}${RST}`);
	if (removed > 0) parts.push(`${FG_DEL}-${removed}${RST}`);
	return parts.length ? parts.join(" ") : `${FG_DIM}no changes${RST}`;
}

// ---------------------------------------------------------------------------
// Shiki cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, string[]>();

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

/**
 * Syntax-highlight `code` to a list of ANSI lines using Shiki. Falls
 * back to plain split when no language is known or the input is too
 * large. Memoized per `(theme, language, code)` triple.
 */
export async function hlBlock(code: string, language: string | undefined): Promise<string[]> {
	if (!code) return [""];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");

	const k = `${THEME}\0${language}\0${code}`;
	const hit = _cache.get(k);
	if (hit) return _touch(k, hit);

	try {
		const ansi = normalizeShikiContrast(await codeToANSI(code, language as never, THEME as never));
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return _touch(k, out);
	} catch {
		return code.split("\n");
	}
}

// ---------------------------------------------------------------------------
// Render utilities (ANSI-aware width, wrapping, contrast fix)
// ---------------------------------------------------------------------------

function strip(s: string): string {
	return s.replace(ANSI_RE, "");
}

function tabs(s: string): string {
	return s.replace(/\t/g, "  ");
}

function adaptiveWrapRows(width: number): number {
	if (width >= 180) return MAX_WRAP_ROWS_WIDE;
	if (width >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}

function fit(content: string, width: number): string {
	if (width <= 0) return "";
	const plain = strip(content);
	if (plain.length <= width) return content + " ".repeat(width - plain.length);
	const showWidth = width > 2 ? width - 1 : width;
	let visible = 0;
	let index = 0;
	while (index < content.length && visible < showWidth) {
		if (content[index] === "\x1b") {
			const end = content.indexOf("m", index);
			if (end !== -1) {
				index = end + 1;
				continue;
			}
		}
		visible += 1;
		index += 1;
	}
	return width > 2 ? `${content.slice(0, index)}${RST}${FG_DIM}›${RST}` : `${content.slice(0, index)}${RST}`;
}

function ansiState(s: string): string {
	let fg = "";
	let bg = "";
	for (const match of s.matchAll(ANSI_CAPTURE_RE)) {
		const params = match[1] ?? "";
		const seq = match[0] ?? "";
		if (params === "0") {
			fg = "";
			bg = "";
		} else if (params === "39") {
			fg = "";
		} else if (params.startsWith("38;")) {
			fg = seq;
		} else if (params.startsWith("48;")) {
			bg = seq;
		}
	}
	return bg + fg;
}

function isLowContrastShikiFg(params: string): boolean {
	if (params === "30" || params === "90") return true;
	if (params === "38;5;0" || params === "38;5;8") return true;
	if (!params.startsWith("38;2;")) return false;
	const parts = params.split(";").map(Number);
	if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) return false;
	const [, , r, g, b] = parts;
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance < 72;
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(ANSI_PARAM_CAPTURE_RE, (seq, params: string) =>
		isLowContrastShikiFg(params) ? FG_SAFE_MUTED : seq,
	);
}

function wrapAnsi(s: string, w: number, maxRows: number, fillBg = ""): string[] {
	if (w <= 0) return [""];
	const plain = strip(s);
	if (plain.length <= w) {
		const pad = w - plain.length;
		return pad > 0 ? [s + fillBg + " ".repeat(pad) + (fillBg ? RST : "")] : [s];
	}
	const rows: string[] = [];
	let row = "";
	let vis = 0;
	let i = 0;
	let onLastRow = false;
	let effW = w;
	while (i < s.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effW = w > 2 ? w - 1 : w;
		}
		if (s[i] === "\x1b") {
			const end = s.indexOf("m", i);
			if (end !== -1) {
				row += s.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		if (vis >= effW) {
			if (onLastRow) {
				let hasMore = false;
				for (let j = i; j < s.length; j++) {
					if (s[j] === "\x1b") {
						const e2 = s.indexOf("m", j);
						if (e2 !== -1) {
							j = e2;
							continue;
						}
					}
					hasMore = true;
					break;
				}
				if (hasMore && w > 2) row += `${RST}${FG_DIM}›${RST}`;
				else row += fillBg + " ".repeat(Math.max(0, w - vis)) + RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + RST);
			row = state + fillBg;
			vis = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effW = w > 2 ? w - 1 : w;
			}
		}
		row += s[i];
		vis++;
		i++;
	}
	if (row.length > 0 || rows.length === 0) {
		rows.push(row + fillBg + " ".repeat(Math.max(0, w - vis)) + RST);
	}
	return rows;
}

function lnumStr(n: number | null, w: number, fg: string = FG_LNUM): string {
	if (n === null) return " ".repeat(w);
	const v = String(n);
	return `${fg}${" ".repeat(Math.max(0, w - v.length))}${v}${RST}`;
}

function rule(w: number): string {
	return `${BG_EMPTY}${FG_RULE}${"─".repeat(w)}${RST}`;
}

function stripes(w: number): string {
	return `${BG_EMPTY}${FG_STRIPE}${"╱".repeat(w)}${RST}`;
}

function shouldUseSplit(diff: ParsedDiff, width: number, maxRows: number): boolean {
	if (!diff.lines.length) return false;
	if (width < SPLIT_MIN_WIDTH) return false;
	const nw = Math.max(
		2,
		String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
	);
	// Mirror renderSplit's layout: two halves with no center divider, and
	// each half spends `nw + 5` cols on lead+num+gap+sign+gap.
	const half = Math.floor(width / 2);
	const gutter = nw + 5;
	const cw = Math.max(8, half - gutter);
	if (cw < SPLIT_MIN_CODE_WIDTH) return false;
	const vis = diff.lines.slice(0, maxRows);
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const l of vis) {
		if (l.type === "sep") continue;
		contentLines++;
		if (tabs(l.content).length > cw) wrapCandidates++;
	}
	if (contentLines === 0) return true;
	const wrapRatio = wrapCandidates / contentLines;
	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
	if (wrapRatio >= SPLIT_MAX_WRAP_RATIO) return false;
	return true;
}

/**
 * Public sibling of `shouldUseSplit` — wrappers (facelift, etc.) call
 * this for each diff in a multi-edit tool call to decide whether to
 * force a single layout across all of them (e.g., fall every edit back
 * to unified when one of them would wrap excessively in split).
 */
export function canRenderSplit(diff: ParsedDiff, width: number, maxLines: number): boolean {
	return shouldUseSplit(diff, Math.max(MIN_RENDER_WIDTH, width), maxLines);
}

// ---------------------------------------------------------------------------
// Word-level diff + bg injection
// ---------------------------------------------------------------------------

interface WordDiffAnalysis {
	similarity: number;
	oldRanges: Array<[number, number]>;
	newRanges: Array<[number, number]>;
}

function wordDiffAnalysis(a: string, b: string): WordDiffAnalysis {
	if (!a && !b) return { similarity: 1, oldRanges: [], newRanges: [] };
	const parts = Diff.diffWords(a, b);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oPos = 0;
	let nPos = 0;
	let same = 0;
	for (const p of parts) {
		if (p.removed) {
			oldRanges.push([oPos, oPos + p.value.length]);
			oPos += p.value.length;
		} else if (p.added) {
			newRanges.push([nPos, nPos + p.value.length]);
			nPos += p.value.length;
		} else {
			const len = p.value.length;
			same += len;
			oPos += len;
			nPos += len;
		}
	}
	const maxLen = Math.max(a.length, b.length);
	return { similarity: maxLen > 0 ? same / maxLen : 1, oldRanges, newRanges };
}

function injectBg(
	ansiLine: string,
	ranges: Array<[number, number]>,
	baseBg: string,
	hlBg: string,
): string {
	if (!ranges.length) return baseBg + ansiLine + RST;
	let out = baseBg;
	let vis = 0;
	let inHL = false;
	let ri = 0;
	let i = 0;
	while (i < ansiLine.length) {
		if (ansiLine[i] === "\x1b") {
			const m = ansiLine.indexOf("m", i);
			if (m !== -1) {
				const seq = ansiLine.slice(i, m + 1);
				out += seq;
				if (seq === "\x1b[0m") out += inHL ? hlBg : baseBg;
				i = m + 1;
				continue;
			}
		}
		while (ri < ranges.length && vis >= ranges[ri][1]) ri++;
		const want = ri < ranges.length && vis >= ranges[ri][0] && vis < ranges[ri][1];
		if (want !== inHL) {
			inHL = want;
			out += inHL ? hlBg : baseBg;
		}
		out += ansiLine[i];
		vis++;
		i++;
	}
	return out + RST;
}

function plainWordDiff(oldText: string, newText: string): { old: string; new: string } {
	const parts = Diff.diffWords(oldText, newText);
	let o = "";
	let n = "";
	for (const p of parts) {
		if (p.removed) o += `${BG_DEL_W}${p.value}${RST}${BG_DEL}`;
		else if (p.added) n += `${BG_ADD_W}${p.value}${RST}${BG_ADD}`;
		else {
			o += p.value;
			n += p.value;
		}
	}
	return { old: o, new: n };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Stacked single-column GitHub-style diff. One row per source line:
 *
 *     <num right-aligned (nw cols)>  <sign (1 col)>  <code>
 *
 * The entire row sits on a single tint (BG_DEL / BG_ADD / BG_CTX) that
 * fills `width` columns end-to-end — no `│` separators, no `▌` border
 * bars, no `gutter-vs-code` split. Word-level emphasis from
 * `Diff.diffWords` is layered on changed character ranges of paired
 * 1:1 del/add lines.
 */
export async function renderUnified(
	diff: ParsedDiff,
	language: string | undefined,
	maxLines: number,
	colors: DiffColors = DEFAULT_DIFF_COLORS,
	width: number = DEFAULT_RENDER_WIDTH,
	options: DiffRenderOptions = {},
): Promise<string> {
	if (!diff.lines.length) return "";
	const visible = diff.lines.slice(0, maxLines);
	const tw = Math.max(MIN_RENDER_WIDTH, width);
	const nw = Math.max(
		2,
		String(Math.max(...visible.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
	);
	// GitHub-style layout per row, all on the row tint:
	//   [lead 1] [num nw, right-aligned] [gap 1] [sign 1] [gap 2] [code]
	const gutterW = nw + 5;
	const cw = Math.max(20, tw - gutterW);
	const canHL = diff.chars <= MAX_HL_CHARS && visible.length <= maxLines;

	const oldSrc: string[] = [];
	const newSrc: string[] = [];
	for (const l of visible) {
		if (l.type === "ctx" || l.type === "del") oldSrc.push(l.content);
		if (l.type === "ctx" || l.type === "add") newSrc.push(l.content);
	}
	const [oldHL, newHL] = canHL
		? await Promise.all([hlBlock(oldSrc.join("\n"), language), hlBlock(newSrc.join("\n"), language)])
		: [oldSrc, newSrc];

	let oI = 0;
	let nI = 0;
	let idx = 0;
	const out: string[] = [];

	// Optional faint rule at top/bottom when used standalone (not framed).
	if (!options.frameless) out.push(rule(tw));

	/** Emit one logical source line as 1+ visual rows (wrap continuations).
	 *  Gutter pattern: `<lead 1><num nw><gap 1><sign 1><gap 2>` = nw + 5 cols.
	 *  Everything sits on `rowBg` so the tint covers the row end-to-end. */
	const emitRow = (
		num: number | null,
		sign: string,
		rowBg: string,
		numFg: string,
		body: string,
	): void => {
		const numStr = num !== null ? String(num).padStart(nw) : " ".repeat(nw);
		const gutter = `${rowBg} ${numFg}${numStr}${RST}${rowBg} ${BOLD}${numFg}${sign}${RST}${rowBg}  `;
		const contGutter = `${rowBg}${" ".repeat(gutterW)}`;
		const rows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(tw), rowBg);
		out.push(`${gutter}${rows[0]}${RST}`);
		for (let r = 1; r < rows.length; r++) {
			out.push(`${contGutter}${rows[r]}${RST}`);
		}
	};

	while (idx < visible.length) {
		const l = visible[idx];
		if (l.type === "sep") {
			const gap = l.newNum;
			const label = gap && gap > 0 ? ` ${gap} unmodified lines ` : " ··· ";
			const totalW = Math.min(tw, 72);
			const pad = Math.max(0, totalW - label.length - 2);
			const left = Math.floor(pad / 2);
			const right = pad - left;
			out.push(`${BG_EMPTY}${FG_DIM}${"·".repeat(left)}${label}${"·".repeat(right)}${RST}`);
			idx++;
			continue;
		}
		if (l.type === "ctx") {
			const hl = oldHL[oI] ?? l.content;
			// Context rows render on BG_CTX (terminal default) so unchanged
			// lines have no diff tint — only +/- rows are highlighted.
			emitRow(l.newNum, " ", BG_CTX, FG_LNUM, `${BG_CTX}${DIM}${hl}`);
			oI++;
			nI++;
			idx++;
			continue;
		}

		const dels: Array<{ l: DiffLine; hl: string }> = [];
		while (idx < visible.length && visible[idx].type === "del") {
			dels.push({ l: visible[idx], hl: oldHL[oI] ?? visible[idx].content });
			oI++;
			idx++;
		}
		const adds: Array<{ l: DiffLine; hl: string }> = [];
		while (idx < visible.length && visible[idx].type === "add") {
			adds.push({ l: visible[idx], hl: newHL[nI] ?? visible[idx].content });
			nI++;
			idx++;
		}

		const isPaired = dels.length === 1 && adds.length === 1;
		const wd = isPaired ? wordDiffAnalysis(dels[0].l.content, adds[0].l.content) : null;
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			const delBody = injectBg(dels[0].hl, wd.oldRanges, BG_DEL, BG_DEL_W);
			const addBody = injectBg(adds[0].hl, wd.newRanges, BG_ADD, BG_ADD_W);
			emitRow(dels[0].l.oldNum, "-", BG_DEL, colors.fgDel, delBody);
			emitRow(adds[0].l.newNum, "+", BG_ADD, colors.fgAdd, addBody);
			continue;
		}
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const pwd = plainWordDiff(dels[0].l.content, adds[0].l.content);
			emitRow(dels[0].l.oldNum, "-", BG_DEL, colors.fgDel, `${BG_DEL}${pwd.old}`);
			emitRow(adds[0].l.newNum, "+", BG_ADD, colors.fgAdd, `${BG_ADD}${pwd.new}`);
			continue;
		}
		for (const d of dels) {
			const body = canHL ? `${BG_DEL}${d.hl}` : `${BG_DEL}${d.l.content}`;
			emitRow(d.l.oldNum, "-", BG_DEL, colors.fgDel, body);
		}
		for (const a of adds) {
			const body = canHL ? `${BG_ADD}${a.hl}` : `${BG_ADD}${a.l.content}`;
			emitRow(a.l.newNum, "+", BG_ADD, colors.fgAdd, body);
		}
	}

	if (!options.frameless) out.push(rule(tw));
	if (diff.lines.length > visible.length) {
		out.push(`${BG_EMPTY}${FG_DIM}  … ${diff.lines.length - visible.length} more lines${RST}`);
	}
	return out.join("\n");
}

/**
 * Side-by-side diff view. Auto-falls back to `renderUnified` when the
 * terminal is too narrow or too many lines would wrap. Set `options.frameless`
 * to `true` to omit the leading/trailing rule lines.
 */
export async function renderSplit(
	diff: ParsedDiff,
	language: string | undefined,
	maxLines: number,
	colors: DiffColors = DEFAULT_DIFF_COLORS,
	width: number = DEFAULT_RENDER_WIDTH,
	options: DiffRenderOptions = {},
): Promise<string> {
	const tw = Math.max(MIN_RENDER_WIDTH, width);
	// Layout selection:
	//   • `options.layout === "unified"` — caller explicitly wants stacked.
	//   • `options.layout === "split"` — caller explicitly wants side-by-side,
	//     even if long lines would wrap. Skip the heuristic.
	//   • otherwise (undefined) — auto: fall back to unified when the diff
	//     would wrap excessively in split.
	if (options.layout === "unified") {
		return renderUnified(diff, language, maxLines, colors, tw, options);
	}
	if (options.layout !== "split" && !shouldUseSplit(diff, tw, maxLines)) {
		return renderUnified(diff, language, maxLines, colors, tw, options);
	}
	if (!diff.lines.length) return "";

	const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
	let i = 0;
	while (i < diff.lines.length) {
		const l = diff.lines[i];
		if (l.type === "sep" || l.type === "ctx") {
			rows.push({ left: l, right: l });
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (i < diff.lines.length && diff.lines[i].type === "del") {
			dels.push(diff.lines[i]);
			i++;
		}
		while (i < diff.lines.length && diff.lines[i].type === "add") {
			adds.push(diff.lines[i]);
			i++;
		}
		const n = Math.max(dels.length, adds.length);
		for (let j = 0; j < n; j++) rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
	}

	const vis = rows.slice(0, maxLines);
	const nw = Math.max(
		2,
		String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
	);
	// Two halves side-by-side. No center divider — each half sits directly
	// next to the other so the right tint touches the left tint and the row
	// reads as a single GitHub-style two-column table.
	const half = Math.floor(tw / 2);
	// Per-half gutter: `<lead 1><num nw><gap 1><sign 1><gap 2>` = nw + 5
	// cols, then code fills the remainder of the half.
	const gutterW = nw + 5;
	const cw = Math.max(8, half - gutterW);
	// When `tw` is odd, `2 * half = tw - 1` and we'd leave a 1-col gap on
	// the right edge that pi-tui would paint with the terminal default bg
	// (visibly different from the row tint). Mirror it with a default-bg
	// space so the row visually ends cleanly where the frame chrome ends.
	const rowTailPad = Math.max(0, tw - 2 * half);
	const rowTail = rowTailPad > 0 ? `${BG_DEFAULT}${" ".repeat(rowTailPad)}${RST}` : "";
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length * 2 <= maxLines * 2;

	const leftSrc: string[] = [];
	const rightSrc: string[] = [];
	for (const r of vis) {
		if (r.left && r.left.type !== "sep") leftSrc.push(r.left.content);
		if (r.right && r.right.type !== "sep") rightSrc.push(r.right.content);
	}
	const [leftHL, rightHL] = canHL
		? await Promise.all([hlBlock(leftSrc.join("\n"), language), hlBlock(rightSrc.join("\n"), language)])
		: [leftSrc, rightSrc];

	let lI = 0;
	let rI = 0;
	const out: string[] = [];

	/** A full half-row painted with BG_EMPTY — used as filler when one
	 *  side has fewer wrapped rows than the other, and for the empty side
	 *  of unpaired del/add rows. Stays on the neutral chrome gray so
	 *  "this line doesn't exist on this side" reads visually distinct from
	 *  ctx rows (which sit on the terminal default). */
	const emptyHalf = `${BG_EMPTY}${" ".repeat(half)}${RST}`;

	/** Build the per-row pieces of one half (left or right). Returns an
	 *  array of `half`-wide visual rows: row 0 has the line number + sign,
	 *  subsequent rows are wrap continuations (blank gutter, tint preserved). */
	const buildHalf = (
		line: DiffLine | null,
		hl: string,
		ranges: Array<[number, number]> | null,
		side: "left" | "right",
	): string[] => {
		if (!line) return [emptyHalf];

		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap && gap > 0 ? `··· ${gap} lines ···` : "···";
			const labelStr = label.length > half - 2 ? label.slice(0, Math.max(0, half - 2)) : label;
			const pad = Math.max(0, half - labelStr.length);
			const left = Math.floor(pad / 2);
			const right = pad - left;
			return [
				`${BG_EMPTY}${" ".repeat(left)}${FG_DIM}${labelStr}${RST}${BG_EMPTY}${" ".repeat(right)}${RST}`,
			];
		}

		const isDel = line.type === "del";
		const isAdd = line.type === "add";
		// Context rows use BG_CTX (terminal default); only changed rows
		// carry a diff tint.
		const rowBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_CTX;
		const numFg = isDel ? colors.fgDel : isAdd ? colors.fgAdd : FG_LNUM;
		const sign = isDel ? "-" : isAdd ? "+" : " ";
		const num = isDel
			? line.oldNum
			: isAdd
				? line.newNum
				: side === "left"
					? line.oldNum
					: line.newNum;

		const numStr = num !== null ? String(num).padStart(nw) : " ".repeat(nw);

		let body: string;
		if (ranges && ranges.length > 0) {
			body = injectBg(hl, ranges, rowBg, isDel ? BG_DEL_W : BG_ADD_W);
		} else if (isDel || isAdd) {
			body = `${rowBg}${hl}`;
		} else {
			// ctx row body — BG_CTX so unchanged code has no diff tint.
			body = `${BG_CTX}${DIM}${hl}`;
		}

		// Gutter pieces are emitted as self-contained segments (each ends in
		// RST then re-applies rowBg) so the body row can carry its own bg
		// codes without conflict. The row as a whole ends with the final RST
		// emitted by wrapAnsi on the body padding.
		// Layout: `<lead 1><num nw><gap 1><sign 1><gap 2>` = nw + 5 cols.
		const gutter = `${rowBg} ${numFg}${numStr}${RST}${rowBg} ${BOLD}${numFg}${sign}${RST}${rowBg}  `;
		const continuation = `${rowBg}${" ".repeat(gutterW)}`;

		const bodyRows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(tw), rowBg);
		return bodyRows.map((rowText, i) => {
			const prefix = i === 0 ? gutter : continuation;
			return `${prefix}${rowText}${RST}`;
		});
	};

	for (const r of vis) {
		const paired = r.left && r.right && r.left.type === "del" && r.right.type === "add";
		const wd = paired && r.left && r.right ? wordDiffAnalysis(r.left.content, r.right.content) : null;
		const leftHighlight = r.left && r.left.type !== "sep" ? (leftHL[lI++] ?? r.left.content) : "";
		const rightHighlight = r.right && r.right.type !== "sep" ? (rightHL[rI++] ?? r.right.content) : "";
		const useWordRanges = !!paired && !!wd && wd.similarity >= WORD_DIFF_MIN_SIM;
		const leftRows = buildHalf(r.left, leftHighlight, useWordRanges && wd ? wd.oldRanges : null, "left");
		const rightRows = buildHalf(r.right, rightHighlight, useWordRanges && wd ? wd.newRanges : null, "right");
		const maxRowsLocal = Math.max(leftRows.length, rightRows.length);
		for (let rr = 0; rr < maxRowsLocal; rr++) {
			const lb = leftRows[rr] ?? emptyHalf;
			const rb = rightRows[rr] ?? emptyHalf;
			out.push(`${lb}${rb}${rowTail}`);
		}
	}

	if (rows.length > vis.length) {
		out.push(`${BG_EMPTY}${FG_DIM}  … ${rows.length - vis.length} more lines${RST}`);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Test-only internals
// ---------------------------------------------------------------------------

/** Test-only hooks. Not part of the public API surface. */
export const __testing = {
	normalizeShikiContrast,
	wordDiffAnalysis,
	injectBg,
	shouldUseSplit,
	plainWordDiff,
	getState: () => ({
		BG_BASE,
		BG_CTX,
		BG_EMPTY,
		RST,
		FG_ADD,
		FG_DEL,
		THEME,
	}),
	resetCachesForTests: () => {
		_cache.clear();
	},
};
