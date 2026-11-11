/**
 * Subscription limits (Claude Pro/Max, ChatGPT plans for Codex) as pi reads
 * them from provider responses, folded into one herdr-core document that
 * every herdr client can show: the herdr app's mods, Wierdr, anything that
 * talks to the core (`doc.get {name: "limits"}`, `doc` events).
 *
 * Providers report the current state of their usage windows on every
 * response: Anthropic in `anthropic-ratelimit-unified-*` headers, Codex in
 * `x-codex-*` headers (SSE) or a `codex.rate_limits` stream event
 * (WebSocket). Parsing follows pi-langfuse's rate-limit scores, with the same
 * account slugs, so both sources name an account alike.
 *
 * Pure functions, except the Codex account lookup (pi's auth.json). The
 * writing lives in `limits-publisher.ts`.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The herdr-core document the limits live in. */
export const LIMITS_DOC = "limits";
export const LIMITS_SCHEMA = 1;

export type LimitStatus = "ok" | "warning" | "exhausted";

export interface ReadingWindow {
  /** Stable within the account: "5h", "7d", "7d_oi", or "<family>.<window>" for extra Codex limit families. */
  id: string;
  label: string;
  windowSeconds?: number;
  /** Share of the window used, in percent. Can exceed 100. */
  usedPercent: number;
  /** Unix seconds. */
  resetsAt?: number;
  status?: LimitStatus;
}

export interface LimitReading {
  provider: "claude" | "codex";
  source: "header" | "stream";
  /** The provider's own account id (Anthropic organization, ChatGPT account), when the response names it. */
  accountId?: string;
  plan?: string;
  /** The window that limits the account right now (Anthropic's representative claim). */
  binding?: string;
  status?: LimitStatus;
  windows: ReadingWindow[];
}

// ============================================
// Parsing
// ============================================

const num = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const unifiedStatus = (value: unknown): LimitStatus | undefined =>
  value === "allowed" ? "ok" : value === "allowed_warning" ? "warning" : value === "rejected" ? "exhausted" : undefined;

/** "5h" → 18000, "7d" → 604800, "7d_oi" → 604800. */
function claimSeconds(claim: string): number | undefined {
  const m = /^(\d+)([mhd])/.exec(claim);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === "m" ? 60 : m[2] === "h" ? 3_600 : 86_400);
}

function durationLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `${Math.round(seconds / 60)} minutes`;
}

function durationId(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

const CLAUDE_PREFIX = "anthropic-ratelimit-unified-";
const CLAUDE_LABELS: Record<string, string> = {
  "5h": "5 hours",
  "7d": "7 days",
  "7d_oi": "7 days + extra",
  "7d_opus": "Opus",
  "7d_sonnet": "Sonnet",
};
// representative-claim names the binding window by its long name.
const CLAUDE_CLAIMS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d_oi",
  seven_day_opus: "7d_opus",
  seven_day_sonnet: "7d_sonnet",
  overage: "overage",
};

function sortWindows(windows: ReadingWindow[]): ReadingWindow[] {
  return windows.sort((a, b) => (a.windowSeconds ?? Infinity) - (b.windowSeconds ?? Infinity) || a.id.localeCompare(b.id));
}

function claudeFromHeaders(headers: Record<string, string>): LimitReading | null {
  const windows: ReadingWindow[] = [];
  for (const [key, raw] of Object.entries(headers)) {
    if (!key.startsWith(CLAUDE_PREFIX) || !key.endsWith("-utilization")) continue;
    const claim = key.slice(CLAUDE_PREFIX.length, -"-utilization".length);
    // Windows only ("5h", "7d", "7d_oi"…): overage, grace and slow-mode budgets are not usage windows.
    if (!/^\d+[mhd](_[a-z0-9_]+)?$/.test(claim)) continue;
    const utilization = num(raw);
    if (utilization === undefined) continue;
    windows.push({
      id: claim,
      label: CLAUDE_LABELS[claim] ?? claim,
      windowSeconds: claimSeconds(claim),
      usedPercent: round2(utilization * 100),
      resetsAt: num(headers[`${CLAUDE_PREFIX}${claim}-reset`]),
      status: unifiedStatus(headers[`${CLAUDE_PREFIX}${claim}-status`]),
    });
  }
  if (!windows.length) return null;
  const claim = headers[`${CLAUDE_PREFIX}representative-claim`];
  return {
    provider: "claude",
    source: "header",
    accountId: headers["anthropic-organization-id"] || undefined,
    binding: claim ? (CLAUDE_CLAIMS[claim] ?? claim) : undefined,
    status: unifiedStatus(headers[`${CLAUDE_PREFIX}status`]),
    windows: sortWindows(windows),
  };
}

interface CodexWindowInput {
  usedPercent?: number;
  windowSeconds?: number;
  resetsAt?: number;
}

function codexWindow(family: string, familyLabel: string | undefined, w: CodexWindowInput): ReadingWindow | null {
  if (w.usedPercent === undefined) return null;
  const seconds = w.windowSeconds;
  const base = seconds ? durationId(seconds) : "window";
  // The main Codex family keeps the plain ids ("5h", "7d") the other providers use.
  const main = family === "codex";
  const id = main ? base : `${family.replace(/[^a-z0-9_-]+/gi, "_")}.${base}`;
  const label = main
    ? seconds
      ? durationLabel(seconds)
      : "Window"
    : `${familyLabel || family} ${seconds ? durationId(seconds) : ""}`.trim();
  return {
    id,
    label,
    windowSeconds: seconds,
    usedPercent: round2(w.usedPercent),
    resetsAt: w.resetsAt,
    status: w.usedPercent >= 100 ? "exhausted" : undefined,
  };
}

function codexFromHeaders(headers: Record<string, string>, nowS: number): LimitReading | null {
  const windows: ReadingWindow[] = [];
  for (const key of Object.keys(headers)) {
    // x-<family>-<primary|secondary>-used-percent; the family is "codex" or another limit
    // ("codex-secondary", "bengalfox"…) that names itself in x-<family>-limit-name.
    const m = /^x-(.+)-(primary|secondary)-used-percent$/.exec(key);
    if (!m) continue;
    const [, family, slot] = m as unknown as [string, string, string];
    const prefix = `x-${family}-${slot}`;
    const minutes = num(headers[`${prefix}-window-minutes`]);
    const after = num(headers[`${prefix}-reset-after-seconds`]);
    const w = codexWindow(family, headers[`x-${family}-limit-name`], {
      usedPercent: num(headers[key]),
      windowSeconds: minutes ? minutes * 60 : undefined,
      resetsAt: num(headers[`${prefix}-reset-at`]) ?? (after !== undefined ? Math.floor(nowS + after) : undefined),
    });
    if (w) windows.push(w);
  }
  if (!windows.length) return null;
  return { provider: "codex", source: "header", windows: sortWindows(windows) };
}

function codexEventWindow(raw: unknown, nowS: number): CodexWindowInput | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const minutes = num(w.window_minutes);
  const seconds = num(w.limit_window_seconds);
  const after = num(w.reset_after_seconds);
  return {
    usedPercent: num(w.used_percent),
    windowSeconds: minutes ? minutes * 60 : seconds,
    resetsAt: num(w.reset_at) ?? num(w.resets_at) ?? (after !== undefined ? Math.floor(nowS + after) : undefined),
  };
}

function codexEventFamily(family: string, label: string | undefined, limits: unknown, nowS: number, out: ReadingWindow[]) {
  if (!limits || typeof limits !== "object") return;
  const l = limits as Record<string, unknown>;
  for (const slot of [l.primary ?? l.primary_window, l.secondary ?? l.secondary_window]) {
    const input = codexEventWindow(slot, nowS);
    const w = input && codexWindow(family, label, input);
    if (w) out.push(w);
  }
}

function codexFromEvent(data: Record<string, unknown>, nowS: number): LimitReading | null {
  const windows: ReadingWindow[] = [];
  const main = data.rate_limits as Record<string, unknown> | null | undefined;
  codexEventFamily("codex", undefined, main, nowS, windows);
  codexEventFamily("code_review", "Code review", data.code_review_rate_limits, nowS, windows);
  const extra = data.additional_rate_limits;
  const items = Array.isArray(extra)
    ? extra
    : extra && typeof extra === "object"
      ? Object.entries(extra as Record<string, unknown>).map(([k, v]) => ({ limit_id: k, ...(v as object) }))
      : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const family = String(it.metered_feature ?? it.limit_id ?? it.limit_name ?? "extra");
    const label = typeof it.limit_name === "string" ? it.limit_name : undefined;
    codexEventFamily(family, label, it.rate_limits ?? it.rate_limit ?? it, nowS, windows);
  }
  if (!windows.length) return null;
  const blocked = main && (main.limit_reached === true || main.allowed === false);
  return {
    provider: "codex",
    source: "stream",
    plan: typeof data.plan_type === "string" ? data.plan_type : undefined,
    status: blocked ? "exhausted" : main?.allowed === true ? "ok" : undefined,
    windows: sortWindows(windows),
  };
}

/** Limits in a provider response's headers (keys lower-case, as pi hands them over). */
export function readingFromHeaders(headers: unknown, nowS = Date.now() / 1_000): LimitReading | null {
  if (!headers || typeof headers !== "object") return null;
  const h = headers as Record<string, string>;
  return claudeFromHeaders(h) ?? codexFromHeaders(h, nowS);
}

/** Limits in a provider stream event (`provider_stream_event.data`). */
export function readingFromStreamEvent(data: unknown, nowS = Date.now() / 1_000): LimitReading | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type === "codex.rate_limits") return codexFromEvent(d, nowS);
  // The WebSocket transport forwards the response headers in this event.
  if (d.type === "codex.response.metadata" && d.headers && typeof d.headers === "object") {
    const headers = Object.fromEntries(
      Object.entries(d.headers as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    const reading = codexFromHeaders(headers, nowS);
    return reading ? { ...reading, source: "stream" } : null;
  }
  return null;
}

/** Cheap pre-check for the stream-event hook, which fires for every delta. */
export function isLimitStreamEvent(data: unknown): boolean {
  const type = (data as { type?: unknown } | null | undefined)?.type;
  return type === "codex.rate_limits" || type === "codex.response.metadata";
}

// ============================================
// Accounts
// ============================================

export interface LimitAccount {
  /** Short, stable and not identifying: the first 8 hex digits of sha256(account id), or "main". */
  slug: string;
  /** The account's e-mail, when pi knows it (Codex). */
  label?: string;
}

export function accountSlug(accountId: string | undefined): string {
  return accountId ? createHash("sha256").update(accountId).digest("hex").slice(0, 8) : "main";
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

let codexAccountCache: { mtimeMs: number; checkedAt: number; account?: { id?: string; label?: string } } | undefined;

function decodeJwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
}

/** The ChatGPT account pi signs in to Codex with (auth.json), re-read when the file changes. */
export function codexAccountFromAuth(path = join(agentDir(), "auth.json"), now = Date.now()): { id?: string; label?: string } | undefined {
  if (codexAccountCache && now - codexAccountCache.checkedAt < 60_000) return codexAccountCache.account;
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (codexAccountCache && codexAccountCache.mtimeMs === mtimeMs) {
      codexAccountCache.checkedAt = now;
      return codexAccountCache.account;
    }
    const credential = (JSON.parse(readFileSync(path, "utf-8")) as Record<string, Record<string, unknown>>)["openai-codex"];
    const claims = decodeJwtClaims(credential?.access);
    const auth = claims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const profile = claims?.["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
    const id =
      typeof credential?.accountId === "string"
        ? credential.accountId
        : typeof auth?.chatgpt_account_id === "string"
          ? auth.chatgpt_account_id
          : undefined;
    const email = typeof profile?.email === "string" ? profile.email : typeof claims?.email === "string" ? claims.email : undefined;
    codexAccountCache = { mtimeMs, checkedAt: now, account: id || email ? { id, label: email } : undefined };
  } catch {
    codexAccountCache = { mtimeMs: -1, checkedAt: now, account: undefined };
  }
  return codexAccountCache.account;
}

export function __resetCodexAccountForTest() {
  codexAccountCache = undefined;
}

export function resolveAccount(reading: LimitReading, codexAccount = codexAccountFromAuth): LimitAccount {
  if (reading.provider === "codex") {
    const account = codexAccount();
    return { slug: accountSlug(reading.accountId ?? account?.id), label: account?.label };
  }
  return { slug: accountSlug(reading.accountId) };
}

// ============================================
// The document
// ============================================

/** One usage window as the document keeps it. Times are unix seconds. */
export interface DocWindow {
  id: string;
  label: string;
  /** The window's length. */
  window_s?: number;
  /** Share used, in percent; can exceed 100. */
  used: number;
  resets_at?: number;
  status?: LimitStatus;
  /** When this window was last read. */
  at: number;
}

export interface DocAccount {
  provider: string;
  /** `accountSlug`: same as pi-langfuse's `rl.<provider>.<account>.*` scores. */
  account: string;
  label?: string;
  plan?: string;
  status?: LimitStatus;
  /** The window limiting the account right now. */
  binding?: string;
  /** Last reading of any window. */
  at: number;
  /** The machine that read it. */
  host?: string;
  source?: "header" | "stream";
  windows: Record<string, DocWindow>;
}

/**
 * The `limits` document: one entry per account, keyed `<provider>.<account>`.
 * Several pi processes write it; each folds its reading into what is there.
 */
export interface LimitsDoc {
  schema: typeof LIMITS_SCHEMA;
  /** Last write, unix seconds. */
  updated_at: number;
  accounts: Record<string, DocAccount>;
}

export const emptyDoc = (): LimitsDoc => ({ schema: LIMITS_SCHEMA, updated_at: 0, accounts: {} });

/** The document as stored, or an empty one when it is missing or not ours to read. */
export function asLimitsDoc(value: unknown): LimitsDoc {
  const v = value as Partial<LimitsDoc> | null | undefined;
  if (!v || typeof v !== "object" || v.schema !== LIMITS_SCHEMA || !v.accounts || typeof v.accounts !== "object") return emptyDoc();
  return { schema: LIMITS_SCHEMA, updated_at: typeof v.updated_at === "number" ? v.updated_at : 0, accounts: { ...v.accounts } };
}

// Two readings of one window can disagree on the reset by a little (Codex derives it).
const SAME_WINDOW_S = 120;

/**
 * Folds window reading `b` into window `a`. Readings of parallel pi sessions
 * land out of order, so within one window (same reset, give or take two
 * minutes) the used share only grows; a later window replaces it; a reading of
 * an earlier window is dropped. A reading without a reset (Anthropic: a window
 * that hasn't started) replaces a window only once its reset has passed.
 */
export function foldWindow(a: DocWindow | undefined, b: DocWindow): DocWindow {
  if (!a) return b;
  if (a.resets_at !== undefined && b.resets_at !== undefined) {
    if (b.resets_at > a.resets_at + SAME_WINDOW_S) return b;
    if (b.resets_at < a.resets_at - SAME_WINDOW_S) return a;
    return {
      ...b,
      used: Math.max(a.used, b.used),
      // The later reset of the two: Codex moves it while a window hasn't started.
      resets_at: Math.max(a.resets_at, b.resets_at),
      at: Math.max(a.at, b.at),
    };
  }
  if (a.resets_at !== undefined && b.resets_at === undefined && b.at < a.resets_at) return a;
  return b.at >= a.at ? b : a;
}

/** The document key of an account. */
export const accountKey = (provider: string, slug: string) => `${provider}.${slug}`;

/** `doc` with `reading` folded in. Returns a new document; `doc` is left as it was. */
export function foldReading(doc: LimitsDoc, reading: LimitReading, account: LimitAccount, nowS: number, host?: string): LimitsDoc {
  const key = accountKey(reading.provider, account.slug);
  const prev = doc.accounts[key];
  const windows: Record<string, DocWindow> = { ...(prev?.windows ?? {}) };
  for (const w of reading.windows) {
    const status = w.status ?? (reading.status === "exhausted" && reading.binding === w.id ? "exhausted" : reading.status ? "ok" : undefined);
    const next: DocWindow = { id: w.id, label: w.label, used: w.usedPercent, at: nowS };
    if (w.windowSeconds !== undefined) next.window_s = w.windowSeconds;
    if (w.resetsAt !== undefined) next.resets_at = Math.floor(w.resetsAt);
    if (status) next.status = status;
    windows[w.id] = foldWindow(windows[w.id], next);
  }
  const latest = !prev || nowS >= prev.at;
  const pick = <T>(mine: T | undefined, theirs: T | undefined) => (latest ? (mine ?? theirs) : (theirs ?? mine));
  const next: DocAccount = { provider: reading.provider, account: account.slug, at: Math.max(prev?.at ?? 0, nowS), windows };
  const label = pick(account.label, prev?.label);
  const plan = pick(reading.plan, prev?.plan);
  const status = latest ? reading.status : prev?.status;
  const binding = latest ? reading.binding : prev?.binding;
  const source = latest ? reading.source : prev?.source;
  const at = latest ? host : prev?.host;
  if (label) next.label = label;
  if (plan) next.plan = plan;
  if (status) next.status = status;
  if (binding) next.binding = binding;
  if (source) next.source = source;
  if (at) next.host = at;
  return { schema: LIMITS_SCHEMA, updated_at: Math.max(doc.updated_at, nowS), accounts: { ...doc.accounts, [key]: next } };
}

