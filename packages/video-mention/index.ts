/**
 * @wierdbytes/pi-video-mention — attach video files to pi prompts via @mentions.
 *
 * Logic:
 *
 *   1. `input` — every `@path/to/video.ext` mention whose extension is a known
 *      video format (and whose file exists, is non-empty and under the size
 *      cap) is rewritten into an internal marker: `[[pi-video:<path>|<mime>]]`.
 *      Everything else stays untouched.
 *
 *   2. `before_provider_request` — fires on EVERY provider request, so the
 *      decision is re-evaluated against the CURRENT model each turn (the
 *      marker travels inside the message history):
 *
 *        - active model supports video AND speaks the openai-completions
 *          wire format → the marker is replaced with a base64 data-URL
 *          content part:
 *
 *              { "type": "video_url", "video_url": { "url": "data:video/mp4;base64,..." } }
 *
 *          which is what OpenRouter (and OpenAI-compatible gateways that
 *          support video) expect.
 *
 *        - anything else (no model, no "video" in `input`, other API shape,
 *          unreadable file) → the marker degrades back to the plain
 *          `@path` mention so the text stays clean and the agent can still
 *          reach the file with its read tool if it wants to.
 *
 * Video support detection, in order:
 *
 *   1. `PI_VIDEO_MENTION_MODELS` — comma-separated `provider/model` glob
 *      patterns force video support regardless of the registry
 *      (`openrouter/stealth/*`, `openrouter/google/gemini-2.5-pro`, …).
 *   2. The model registry: model's `input` list contains "video". Note that
 *      pi normalizes catalogued modalities to text/image, so for OpenRouter
 *      models this usually needs a `modelOverrides` entry — see README.
 *   3. For OpenRouter baseUrl models: one probe of the public
 *      `/api/v1/models` catalogue per process; a model whose
 *      `architecture.input_modalities` includes "video" qualifies. This
 *      covers catalogues that strip "video" during sync.
 *
 * Slash command: `/video-mention` shows whether the active model supports
 * video input.
 *
 * Configuration:
 *   PI_VIDEO_MENTION_MAX_MB    cap attachment size (default 100 MB)
 *   PI_VIDEO_MENTION_MODELS    forced video-capable model globs
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	wmv: "video/x-ms-wmv",
	flv: "video/x-flv",
	mpg: "video/mpeg",
	mpeg: "video/mpeg",
	"3gp": "video/3gpp",
	ogv: "video/ogg",
	ts: "video/mp2t",
};

const MARKER_RE = /\[\[pi-video:([^|\]]+)\|([^|\]]+)\]\]/g;

const AT_PATH_RE = /(?:^|[\s([{])@(?:"([^"]+)"|(\S+))/g;
const TRAILING_PUNCTUATION_RE = /[)\],.;:!?]+$/;

function maxAttachmentBytes(): number {
	const raw = process.env.PI_VIDEO_MENTION_MAX_MB;
	const mb = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 100 * 1024 * 1024;
}

function mediaTypeFromExtension(path: string): string | undefined {
	return VIDEO_MIME_BY_EXTENSION[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
}

function makeMarker(path: string, mediaType: string): string {
	return `[[pi-video:${path}|${mediaType}]]`;
}

function mentionText(path: string): string {
	return `@${path.includes(" ") ? `"${path}"` : path}`;
}

async function isAttachableVideo(path: string): Promise<boolean> {
	try {
		const stats = await stat(path);
		return stats.isFile() && stats.size > 0 && stats.size <= maxAttachmentBytes();
	} catch {
		return false;
	}
}

/** Replace video @mentions with internal markers; leave everything else as-is. */
export async function markVideoMentions(text: string, cwd: string): Promise<string | undefined> {
	let result = "";
	let last = 0;
	let changed = false;
	for (const match of text.matchAll(AT_PATH_RE)) {
		const quoted = match[1];
		const trailing = quoted ? "" : (match[2].match(TRAILING_PUNCTUATION_RE)?.[0] ?? "");
		const mention = quoted ?? match[2].slice(0, match[2].length - trailing.length);
		if (!mediaTypeFromExtension(mention)) continue;
		const path = resolve(cwd, mention);
		if (!(await isAttachableVideo(path))) continue;
		result += text.slice(last, match.index + match[0].indexOf("@")) + makeMarker(path, mediaTypeFromExtension(mention)!) + trailing;
		last = match.index + match[0].length;
		changed = true;
	}
	return changed ? result + text.slice(last) : undefined;
}

type TextPart = { type: "text"; text: string };
type VideoPart = { type: "video_url"; video_url: { url: string } };

/**
 * Split marked text into parts. With `attach` the markers become video_url
 * data-URL parts (falling back to a plain mention when the file can't be
 * read); without it they degrade back to plain @mentions.
 */
export async function markerTextToParts(text: string, attach: boolean): Promise<Array<TextPart | VideoPart> | undefined> {
	if (!text.includes("[[pi-video:")) return undefined;
	const segments: Array<{ kind: "text"; text: string } | { kind: "media"; path: string; mediaType: string }> = [];
	let last = 0;
	for (const match of text.matchAll(MARKER_RE)) {
		const before = text.slice(last, match.index);
		if (before.trim()) segments.push({ kind: "text", text: before });
		segments.push({ kind: "media", path: match[1], mediaType: match[2] });
		last = match.index + match[0].length;
	}
	const after = text.slice(last);
	if (after.trim()) segments.push({ kind: "text", text: after });
	if (!segments.some((segment) => segment.kind === "media")) return undefined;

	const parts: Array<TextPart | VideoPart> = [];
	for (const segment of segments) {
		if (segment.kind === "text") {
			parts.push({ type: "text", text: segment.text });
			continue;
		}
		if (!attach) {
			parts.push({ type: "text", text: mentionText(segment.path) });
			continue;
		}
		try {
			const bytes = await readFile(segment.path);
			parts.push({
				type: "video_url",
				video_url: { url: `data:${segment.mediaType};base64,${bytes.toString("base64")}` },
			});
		} catch {
			parts.push({ type: "text", text: mentionText(segment.path) });
		}
	}
	return parts;
}

function isTextPart(part: unknown): part is TextPart {
	return (
		!!part &&
		typeof part === "object" &&
		(part as { type?: unknown }).type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
	);
}

async function rewriteContent(content: unknown, attach: boolean): Promise<unknown | undefined> {
	if (typeof content === "string") return markerTextToParts(content, attach);
	if (!Array.isArray(content)) return undefined;
	const results = await Promise.all(
		content.map((part) => (isTextPart(part) ? markerTextToParts(part.text, attach) : undefined)),
	);
	if (results.every((parts) => parts === undefined)) return undefined;
	return content.flatMap((part, index) => results[index] ?? [part]);
}

/** Minimal glob match: `*` spans any characters, `?` exactly one. */
export function globMatches(pattern: string, value: string): boolean {
	const regex = new RegExp(
		`^${[...pattern].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("")}$`,
	);
	return regex.test(value);
}

function forcedVideoModels(): string[] {
	const raw = process.env.PI_VIDEO_MENTION_MODELS;
	return raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

/** Model ids with "video" in architecture.input_modalities, keyed by OpenRouter-compatible baseUrl. */
const openRouterVideoModels = new Map<string, Promise<Set<string> | undefined>>();

async function fetchOpenRouterVideoModels(baseUrl: string): Promise<Set<string> | undefined> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) return undefined;
		const body = (await response.json()) as { data?: Array<{ id?: string; architecture?: { input_modalities?: string[] } }> };
		const ids = new Set<string>();
		for (const entry of body.data ?? []) {
			if (typeof entry.id === "string" && entry.architecture?.input_modalities?.includes("video")) ids.add(entry.id);
		}
		return ids;
	} catch {
		return undefined;
	}
}

/**
 * True when the active model supports video input and uses the
 * chat-completions wire format. Registry first, then explicit overrides,
 * then the OpenRouter public catalogue.
 */
export async function modelSupportsVideo(model: unknown): Promise<boolean> {
	if (!model || typeof model !== "object") return false;
	const candidate = model as { id?: string; api?: unknown; input?: unknown; provider?: string; baseUrl?: string };
	if (candidate.api !== "openai-completions") return false;
	const qualified = `${candidate.provider ?? ""}/${candidate.id ?? ""}`;
	if (forcedVideoModels().some((pattern) => globMatches(pattern, qualified))) return true;
	if (Array.isArray(candidate.input) && candidate.input.includes("video")) return true;
	if (candidate.baseUrl?.includes("openrouter.ai")) {
		let ids = openRouterVideoModels.get(candidate.baseUrl);
		if (!ids) {
			ids = fetchOpenRouterVideoModels(candidate.baseUrl);
			openRouterVideoModels.set(candidate.baseUrl, ids);
		}
		const resolved = await ids;
		if (resolved?.has(candidate.id ?? "")) return true;
	}
	return false;
}

export default function piVideoMention(pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		const text = await markVideoMentions(event.text, ctx.cwd);
		return text === undefined ? { action: "continue" } : { action: "transform", text };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const payload = event.payload;
		if (!payload || typeof payload !== "object") return undefined;
		const messages = (payload as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) return undefined;

		const attach = await modelSupportsVideo(ctx.model);
		const contents = await Promise.all(
			messages.map((message) =>
				message && typeof message === "object"
					? rewriteContent((message as { content?: unknown }).content, attach)
					: undefined,
			),
		);
		if (contents.every((content) => content === undefined)) return undefined;

		return {
			...payload,
			messages: messages.map((message, index) =>
				contents[index] !== undefined ? { ...(message as object), content: contents[index] } : message,
			),
		};
	});

	pi.registerCommand("video-mention", {
		description: "Show whether the active model supports video attachments",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model.", "warning");
				return;
			}
			const id = `${model.provider}/${model.id}`;
			if (await modelSupportsVideo(model)) {
				ctx.ui.notify(`${id}: video supported — @mentions are sent as video_url parts.`, "info");
			} else {
				ctx.ui.notify(`${id}: no video support — @mentions stay plain text.`, "warning");
			}
		},
	});
}
