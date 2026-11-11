import { describe, expect, it } from "vitest";
import { resolveModel } from "./models.ts";

const available = [
  { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
  { provider: "openrouter", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
];

const id = (q: string, opts?: Parameters<typeof resolveModel>[2]) => {
  const r = resolveModel(q, available, opts);
  return r.ok ? `${r.model.provider}/${r.model.id}` : r.error;
};

describe("resolveModel", () => {
  it("takes an exact provider/id", () => {
    expect(id("openrouter/claude-sonnet-5-5")).toBe("openrouter/claude-sonnet-5-5");
  });

  it("prefers the parent's provider for a bare id", () => {
    expect(id("claude-sonnet-5-5", { provider: "anthropic" })).toBe("anthropic/claude-sonnet-5-5");
  });

  it("picks the newest fuzzy match", () => {
    expect(id("sonnet", { provider: "anthropic" })).toBe("anthropic/claude-sonnet-5-5");
    expect(id("gpt-6.1")).toBe("openai-codex/gpt-6.1-sol");
  });

  it("prefers scoped models", () => {
    expect(id("sonnet", { scoped: [{ provider: "anthropic", id: "claude-sonnet-5" }] })).toBe("anthropic/claude-sonnet-5");
  });

  it("matches display names", () => {
    expect(id("Opus 5.5")).toBe("anthropic/claude-opus-5-5");
  });

  it("lists what exists when nothing matches", () => {
    expect(id("gemini")).toMatch(/Unknown model "gemini"\. Available: anthropic\/claude-opus-5-5/);
  });
});
