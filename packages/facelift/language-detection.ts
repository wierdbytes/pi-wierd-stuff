import * as languageDetectionModule from "@vscode/vscode-languagedetection";
import type { ModelOperations, ModelResult } from "@vscode/vscode-languagedetection";
import type { BundledLanguage } from "shiki";

// The package is CommonJS. Bun exposes its named export directly while Node
// ESM places it under `default`, so normalize both loader shapes.
const LanguageDetection =
	(languageDetectionModule as unknown as { default?: typeof languageDetectionModule }).default ??
	languageDetectionModule;
const ModelOperationsCtor = LanguageDetection.ModelOperations;

/** Only inspect a small prefix; tool output can be very large. */
export const LANGUAGE_SAMPLE_BYTES = 4 * 1024;

/**
 * Guesslang's confidence is intentionally conservative on snippets. These
 * thresholds reject prose/logs while accepting a clear winner on incomplete
 * source. The margin prevents close calls such as shell-vs-batch output.
 */
export const MIN_LANGUAGE_CONFIDENCE = 0.1;
export const MIN_LANGUAGE_MARGIN = 0.04;

const LANGUAGE_ALIASES: Readonly<Record<string, BundledLanguage>> = {
	bat: "bat",
	c: "c",
	clj: "clojure",
	cmake: "cmake",
	coffee: "coffeescript",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	csv: "csv",
	dockerfile: "dockerfile",
	erl: "erlang",
	go: "go",
	groovy: "groovy",
	hs: "haskell",
	html: "html",
	ini: "ini",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "jsx",
	kt: "kotlin",
	lua: "lua",
	makefile: "makefile",
	markdown: "markdown",
	md: "markdown",
	mm: "objective-cpp",
	pas: "pascal",
	php: "php",
	pl: "perl",
	ps1: "powershell",
	py: "python",
	r: "r",
	rb: "ruby",
	rs: "rust",
	scala: "scala",
	sh: "shellscript",
	sql: "sql",
	swift: "swift",
	tex: "latex",
	ts: "typescript",
	tsx: "tsx",
	xml: "xml",
	yaml: "yaml",
};

let model: ModelOperations | undefined;

function getModel(): ModelOperations {
	model ??= new ModelOperationsCtor({
		minContentSize: 20,
		maxContentSize: LANGUAGE_SAMPLE_BYTES,
	});
	return model;
}

/** Return at most `maxBytes` of valid UTF-8 without splitting a code point. */
export function sampleUtf8(text: string, maxBytes = LANGUAGE_SAMPLE_BYTES): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) return text;

	let end = maxBytes;
	// `end` points at the first excluded byte. If it is a continuation byte
	// (10xxxxxx), the limit split a code point; omit that whole code point.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

export function selectDetectedLanguage(results: readonly ModelResult[]): BundledLanguage | undefined {
	const best = results[0];
	if (!best) return undefined;
	const secondConfidence = results[1]?.confidence ?? 0;
	if (
		best.confidence < MIN_LANGUAGE_CONFIDENCE ||
		best.confidence - secondConfidence < MIN_LANGUAGE_MARGIN
	) {
		return undefined;
	}
	return LANGUAGE_ALIASES[best.languageId.toLowerCase()];
}

/**
 * Detect code in an incomplete tool-output prefix. Ambiguous text, ordinary
 * prose, logs, and unsupported languages deliberately return `undefined`.
 */
export async function detectCodeLanguage(text: string): Promise<BundledLanguage | undefined> {
	const sample = sampleUtf8(text).trim();
	if (sample.length < 20) return undefined;

	try {
		return selectDetectedLanguage(await getModel().runModel(sample));
	} catch {
		// Detection is cosmetic; never make a tool result fail to render.
		return undefined;
	}
}

export function disposeLanguageDetector(): void {
	model?.dispose();
	model = undefined;
}
