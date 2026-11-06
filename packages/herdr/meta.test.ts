import { describe, expect, it } from "vitest";
import { clearLabels, collectLabels, diffLabels, effortLabel, LABEL_KEYS } from "./meta.ts";

const opus = {
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  provider: "anthropic",
  reasoning: true,
  contextWindow: 1_000_000,
};

describe("effortLabel", () => {
  it("shows the level of a reasoning model", () => {
    expect(effortLabel(opus, "medium")).toBe("medium");
  });

  it("hides off and non-reasoning models", () => {
    expect(effortLabel(opus, "off")).toBeUndefined();
    expect(effortLabel({ ...opus, reasoning: false }, "high")).toBeUndefined();
    expect(effortLabel(undefined, "high")).toBeUndefined();
  });

  it("uses the model's own word, not a rename between pi levels", () => {
    expect(effortLabel({ ...opus, thinkingLevelMap: { xhigh: "max" } }, "xhigh")).toBe("max");
    expect(effortLabel({ ...opus, thinkingLevelMap: { minimal: "low" } }, "minimal")).toBe("minimal");
    expect(effortLabel({ ...opus, thinkingLevelMap: { high: "32k" } }, "high")).toBe("32k");
  });
});

describe("collectLabels", () => {
  it("describes model, effort and context", () => {
    expect(
      collectLabels({
        pid: 42,
        model: opus,
        thinkingLevel: "high",
        context: { tokens: 228_431.6, contextWindow: 1_000_000 },
        subagents: 2,
        session: "019f8940-4b3b-7d72-8112-3a9ebd007d5c",
        cache: { until: 1_793_534_700_000.4, ttlMs: 300_000 },
      }),
    ).toEqual({
      "agent.app": "pi",
      "agent.pid": "42",
      "agent.model": "Claude Opus 5.5",
      "agent.model_id": "claude-opus-5-5",
      "agent.provider": "anthropic",
      "agent.effort": "high",
      "agent.ctx": "228432",
      "agent.ctx_max": "1000000",
      "agent.subagents": "2",
      "agent.session": "019f8940-4b3b-7d72-8112-3a9ebd007d5c",
      "agent.cache_until": "1793534700000",
      "agent.cache_ttl": "300000",
    });
  });

  it("leaves out what isn't known", () => {
    const labels = collectLabels({
      pid: 7,
      model: { id: "local-model", provider: "ollama" },
      thinkingLevel: "off",
      context: { tokens: null, contextWindow: 0 },
      subagents: 0,
    });
    expect(labels).toEqual({
      "agent.app": "pi",
      "agent.pid": "7",
      "agent.model": "local-model",
      "agent.model_id": "local-model",
      "agent.provider": "ollama",
    });
  });

  it("falls back to the model's window when usage has none", () => {
    const labels = collectLabels({ pid: 1, model: opus, thinkingLevel: "low", context: undefined, subagents: 0 });
    expect(labels["agent.ctx"]).toBeUndefined();
    expect(labels["agent.ctx_max"]).toBe("1000000");
  });
});

describe("diffLabels", () => {
  it("sends only changes and removes vanished keys", () => {
    expect(
      diffLabels(
        { "agent.model": "A", "agent.effort": "high", "agent.ctx": "10" },
        { "agent.model": "A", "agent.ctx": "20" },
      ),
    ).toEqual({ "agent.effort": "", "agent.ctx": "20" });
  });

  it("is empty when nothing changed", () => {
    expect(diffLabels({ "agent.app": "pi" }, { "agent.app": "pi" })).toEqual({});
  });
});

it("clearLabels removes every owned key", () => {
  const cleared = clearLabels();
  expect(Object.keys(cleared).sort()).toEqual([...LABEL_KEYS].sort());
  expect(Object.values(cleared).every((v) => v === "")).toBe(true);
});
