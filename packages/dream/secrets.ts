/**
 * Redact credentials before transcript text reaches a model or a note, and
 * detect them when linting what the dream is about to write.
 */

interface Rule {
	kind: string;
	re: RegExp;
	/** Keep capture group 1 (e.g. the key name) and redact the rest. */
	keepPrefix?: boolean;
}

const RULES: Rule[] = [
	{ kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
	{ kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
	{ kind: "openai-key", re: /\bsk-(?!ant-|lf-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
	{ kind: "langfuse-key", re: /\b(?:pk|sk)-lf-[A-Za-z0-9-]{8,}/g },
	{ kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
	{ kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
	{ kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
	{ kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	{ kind: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, keepPrefix: true },
	{
		kind: "assignment",
		re: /\b((?:api[_-]?key|apikey|secret|client[_-]?secret|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|pwd)["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi,
		keepPrefix: true,
	},
];

export function scrubSecrets(text: string): string {
	if (!text) return text;
	let out = text;
	for (const rule of RULES) {
		rule.re.lastIndex = 0;
		out = out.replace(rule.re, (match: string, prefix?: string) =>
			rule.keepPrefix && typeof prefix === "string" ? `${prefix}[REDACTED]` : `[REDACTED:${rule.kind}]`,
		);
	}
	return out;
}

/** Kinds of credentials found in `text` (empty when clean). */
export function findSecrets(text: string): string[] {
	const found = new Set<string>();
	for (const rule of RULES) {
		rule.re.lastIndex = 0;
		for (const m of text.matchAll(rule.re)) {
			// `[REDACTED]` placeholders left by scrubSecrets are not secrets.
			const value = rule.keepPrefix ? (m[2] ?? m[0]) : m[0];
			if (!value.includes("[REDACTED")) found.add(rule.kind);
		}
	}
	return [...found];
}

const INJECTION: Array<[string, RegExp]> = [
	["ignore-instructions", /ignore (?:all |any )?(?:the )?(?:previous|prior|above) instructions/i],
	["disregard-instructions", /disregard (?:all |any )?(?:the )?(?:previous|prior|above)/i],
	["fake-prompt-tag", /<\/?(?:system|instructions|memory|project_context)>/i],
	["role-override", /you are now\b/i],
];

const RISKY: Array<[string, RegExp]> = [["pipe-to-shell", /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i]];

/** Prompt-injection phrases: never acceptable as memory text. */
export function findInjection(text: string): string[] {
	return INJECTION.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Risky but possibly legitimate content (e.g. an installer piped to sh): flagged for the reviewer. */
export function findRisky(text: string): string[] {
	return RISKY.filter(([, re]) => re.test(text)).map(([name]) => name);
}
