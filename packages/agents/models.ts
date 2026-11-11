/**
 * Turns what the model asked for (`"sonnet"`, `"anthropic/claude-sonnet-5-5"`,
 * `"gpt-6.1-sol"`) into one `provider/id` from the parent's model registry,
 * so a typo fails in the parent with a useful list instead of in a child
 * terminal nobody is looking at.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const isThinkingLevel = (v: unknown): v is ThinkingLevel =>
  typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);

export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

export type ModelResolution = { ok: true; model: ModelLike } | { ok: false; error: string };

const key = (m: ModelLike) => `${m.provider}/${m.id}`;
const norm = (s: string) => s.toLowerCase().replace(/[\s_.]+/g, "-");

/** Natural order: `claude-sonnet-5-5` after `claude-sonnet-5`, `gpt-6.10` after `gpt-6.9`. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

export interface ResolveOptions {
  /** The session's scoped models (`enabledModels` / `--models`): preferred among several matches. */
  scoped?: readonly ModelLike[];
  /** The parent's provider: preferred next. */
  provider?: string;
}

/**
 * `available` are the models with credentials. Among several matches the
 * scoped ones win, then the parent's provider, then the newest-looking id
 * (natural order, highest first).
 */
export function resolveModel(query: string, available: readonly ModelLike[], opts: ResolveOptions = {}): ModelResolution {
  const scoped = new Set((opts.scoped ?? []).map(key));
  const q = query.trim();
  if (!q) return { ok: false, error: "empty model" };
  const slash = q.indexOf("/");
  if (slash > 0) {
    const provider = q.slice(0, slash);
    const id = q.slice(slash + 1);
    const exact = available.find((m) => m.provider === provider && m.id === id);
    if (exact) return { ok: true, model: exact };
  }
  const byId = available.filter((m) => m.id === q);
  const rank = (m: ModelLike) => (scoped.has(key(m)) ? 0 : 2) + (m.provider === opts.provider ? 0 : 1);
  const pick = (list: readonly ModelLike[]): ModelLike =>
    [...list].sort((a, b) => rank(a) - rank(b) || naturalCompare(b.id, a.id) || key(a).localeCompare(key(b)))[0]!;
  if (byId.length) return { ok: true, model: pick(byId) };

  const nq = norm(q);
  const fuzzy = available.filter(
    (m) => norm(key(m)).includes(nq) || norm(m.id).includes(nq) || (m.name ? norm(m.name).includes(nq) : false),
  );
  if (fuzzy.length) return { ok: true, model: pick(fuzzy) };

  const list = available.map(key).sort();
  const shown = list.slice(0, 30).join(", ");
  return {
    ok: false,
    error: `Unknown model "${q}". Available: ${shown}${list.length > 30 ? `, … (${list.length - 30} more)` : ""}`,
  };
}
