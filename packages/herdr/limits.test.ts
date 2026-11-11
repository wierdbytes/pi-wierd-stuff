import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCodexAccountForTest,
  accountSlug,
  asLimitsDoc,
  codexAccountFromAuth,
  type DocWindow,
  emptyDoc,
  foldReading,
  foldWindow,
  isLimitStreamEvent,
  type LimitReading,
  readingFromHeaders,
  readingFromStreamEvent,
  resolveAccount,
} from "./limits.ts";

// Captured from a Claude Max OAuth response (organization id replaced).
const CLAUDE_HEADERS = {
  "anthropic-organization-id": "00000000-1111-2222-3333-444444444444",
  "anthropic-ratelimit-unified-5h-reset": "1794321600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.67",
  "anthropic-ratelimit-unified-7d-reset": "1794571200",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.36",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": "1794321600",
  "anthropic-ratelimit-unified-status": "allowed",
  "content-type": "text/event-stream",
};

// Captured from the Codex WebSocket transport (ChatGPT Plus).
const CODEX_EVENT = {
  type: "codex.rate_limits",
  plan_type: "plus",
  rate_limits: {
    allowed: true,
    limit_reached: false,
    primary: { used_percent: 0, window_minutes: 300, reset_after_seconds: 18000, reset_at: 1794334130 },
    secondary: { used_percent: 6, window_minutes: 10080, reset_after_seconds: 174439, reset_at: 1794490569 },
  },
  code_review_rate_limits: null,
  additional_rate_limits: null,
};

afterEach(() => __resetCodexAccountForTest());

describe("parsing", () => {
  it("reads Claude's unified headers as 5h and 7d windows in percent", () => {
    const reading = readingFromHeaders(CLAUDE_HEADERS);
    expect(reading).toMatchObject({ provider: "claude", binding: "5h", status: "ok", accountId: CLAUDE_HEADERS["anthropic-organization-id"] });
    expect(reading?.windows).toEqual([
      { id: "5h", label: "5 hours", windowSeconds: 18000, usedPercent: 67, resetsAt: 1794321600, status: "ok" },
      { id: "7d", label: "7 days", windowSeconds: 604800, usedPercent: 36, resetsAt: 1794571200, status: "ok" },
    ]);
  });

  it("keeps rejected and extra weekly windows, not overage budgets", () => {
    const reading = readingFromHeaders({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-7d-utilization": "1.01",
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.5",
      "anthropic-ratelimit-unified-overage-utilization": "0.2",
    });
    expect(reading?.binding).toBe("7d");
    expect(reading?.windows.map((w) => [w.id, w.label, w.usedPercent, w.status])).toEqual([
      ["7d", "7 days", 101, "exhausted"],
      ["7d_oi", "7 days + extra", 50, undefined],
    ]);
  });

  it("reads Codex's rate-limit event", () => {
    expect(isLimitStreamEvent(CODEX_EVENT)).toBe(true);
    expect(isLimitStreamEvent({ type: "response.output_text.delta" })).toBe(false);
    const reading = readingFromStreamEvent(CODEX_EVENT);
    expect(reading).toMatchObject({ provider: "codex", source: "stream", plan: "plus", status: "ok" });
    expect(reading?.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
      ["5h", 0, 1794334130],
      ["7d", 6, 1794490569],
    ]);
  });

  it("reads Codex headers with extra limit families, also forwarded in a stream event", () => {
    const headers = {
      "x-codex-primary-used-percent": "42.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1794334130",
      "x-codex-secondary-used-percent": "100",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-after-seconds": "100",
      "x-bengalfox-primary-used-percent": "3",
      "x-bengalfox-primary-window-minutes": "300",
      "x-bengalfox-limit-name": "gpt-5.2-codex-sonic",
    };
    const windows = [
      ["5h", "5 hours", 42.5, 1794334130, undefined],
      ["bengalfox.5h", "gpt-5.2-codex-sonic 5h", 3, undefined, undefined],
      ["7d", "7 days", 100, 1100, "exhausted"],
    ];
    const pick = (r: LimitReading | null) => r?.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt, w.status]);
    expect(pick(readingFromHeaders(headers, 1_000))).toEqual(windows);
    const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]));
    const forwarded = readingFromStreamEvent({ type: "codex.response.metadata", headers: upper }, 1_000);
    expect(forwarded?.source).toBe("stream");
    expect(pick(forwarded)).toEqual(windows);
  });

  it("ignores responses without limits", () => {
    expect(readingFromHeaders({ "content-type": "application/json" })).toBeNull();
    expect(readingFromHeaders(undefined)).toBeNull();
    expect(readingFromStreamEvent({ type: "codex.response.metadata", headers: { "x-models-etag": "x" } })).toBeNull();
  });
});

describe("accounts", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("names accounts by a short hash, as pi-langfuse does", () => {
    expect(accountSlug(undefined)).toBe("main");
    expect(accountSlug("acc-1")).toMatch(/^[0-9a-f]{8}$/);
    const claude = readingFromHeaders(CLAUDE_HEADERS)!;
    expect(resolveAccount(claude)).toEqual({ slug: accountSlug(claude.accountId) });
  });

  it("takes the Codex account and its e-mail from pi's auth.json", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-herdr-auth-"));
    const claims = {
      "https://api.openai.com/auth": { chatgpt_account_id: "from-jwt" },
      "https://api.openai.com/profile": { email: "me@example.com" },
    };
    const jwt = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
    const path = join(dir, "auth.json");
    writeFileSync(path, JSON.stringify({ "openai-codex": { access: jwt, accountId: "acc-123" } }));
    expect(codexAccountFromAuth(path)).toEqual({ id: "acc-123", label: "me@example.com" });
    const codex = readingFromStreamEvent(CODEX_EVENT)!;
    expect(resolveAccount(codex, () => ({ id: "acc-123", label: "me@example.com" }))).toEqual({
      slug: accountSlug("acc-123"),
      label: "me@example.com",
    });
  });
});

describe("foldWindow", () => {
  const w = (used: number, resets_at: number | undefined, at: number): DocWindow => ({ id: "5h", label: "5 hours", used, resets_at, at });

  it("only grows within one window, whatever order readings land in", () => {
    expect(foldWindow(w(40, 1000, 10), w(30, 1000, 20))).toMatchObject({ used: 40, at: 20 });
    expect(foldWindow(w(30, 1000, 10), w(40, 1060, 20))).toMatchObject({ used: 40, resets_at: 1060 });
  });

  it("takes a later window and drops a reading of an earlier one", () => {
    expect(foldWindow(w(90, 1000, 10), w(5, 20000, 20))).toMatchObject({ used: 5, resets_at: 20000 });
    expect(foldWindow(w(5, 20000, 20), w(90, 1000, 30))).toMatchObject({ used: 5, resets_at: 20000 });
  });

  it("lets a window that hasn't started replace one only after its reset", () => {
    expect(foldWindow(w(90, 1000, 10), w(0, undefined, 500))).toMatchObject({ used: 90, resets_at: 1000 });
    expect(foldWindow(w(90, 1000, 10), w(0, undefined, 1500))).toEqual(w(0, undefined, 1500));
  });
});

describe("foldReading", () => {
  const claude = readingFromHeaders(CLAUDE_HEADERS)!;
  const account = resolveAccount(claude);
  const key = `claude.${account.slug}`;

  it("adds an account with its windows", () => {
    const doc = foldReading(emptyDoc(), claude, account, 100, "mac");
    expect(doc.updated_at).toBe(100);
    expect(doc.accounts[key]).toEqual({
      provider: "claude",
      account: account.slug,
      status: "ok",
      binding: "5h",
      source: "header",
      host: "mac",
      at: 100,
      windows: {
        "5h": { id: "5h", label: "5 hours", window_s: 18000, used: 67, resets_at: 1794321600, status: "ok", at: 100 },
        "7d": { id: "7d", label: "7 days", window_s: 604800, used: 36, resets_at: 1794571200, status: "ok", at: 100 },
      },
    });
  });

  it("keeps other accounts and windows the reading doesn't mention", () => {
    const codex = readingFromStreamEvent(CODEX_EVENT)!;
    let doc = foldReading(emptyDoc(), codex, { slug: "c0ffee00", label: "me@example.com" }, 50);
    doc = foldReading(doc, { ...claude, windows: [{ id: "7d_opus", label: "Opus", usedPercent: 3 }] }, account, 60);
    doc = foldReading(doc, claude, account, 70);
    expect(Object.keys(doc.accounts).sort()).toEqual(["claude." + account.slug, "codex.c0ffee00"].sort());
    expect(doc.accounts["codex.c0ffee00"]).toMatchObject({ label: "me@example.com", plan: "plus" });
    expect(Object.keys(doc.accounts[key]!.windows).sort()).toEqual(["5h", "7d", "7d_opus"]);
  });

  it("doesn't let an older reading overwrite the account's status", () => {
    const later = foldReading(emptyDoc(), { ...claude, status: "warning", binding: "7d" }, account, 200);
    const doc = foldReading(later, claude, account, 100);
    expect(doc.accounts[key]).toMatchObject({ status: "warning", binding: "7d", at: 200 });
    expect(doc.updated_at).toBe(200);
  });

  it("reads anything else as an empty document", () => {
    expect(asLimitsDoc(null)).toEqual(emptyDoc());
    expect(asLimitsDoc({ schema: 99, accounts: {} })).toEqual(emptyDoc());
    const doc = foldReading(emptyDoc(), claude, account, 1);
    expect(asLimitsDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
});

