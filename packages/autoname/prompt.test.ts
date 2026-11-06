import { describe, expect, it } from "vitest";
import { fallbackName, KEEP, normalizeName, parseAnswer, piDefaultTitle, renderTitle, systemPrompt, truncate, userPrompt } from "./prompt.ts";

describe("normalizeName", () => {
  it("takes the first non-empty line and strips decoration", () => {
    expect(normalizeName("\n  \"Fix login bug.\"\nextra", 40)).toBe("Fix login bug");
    expect(normalizeName("Title: **Herdr summary for pi**", 40)).toBe("Herdr summary for pi");
    expect(normalizeName("# Сводка для pi в Herdr", 40)).toBe("Сводка для pi в Herdr");
    expect(normalizeName("«Лимиты в сайдбаре»", 40)).toBe("Лимиты в сайдбаре");
  });

  it("drops terminal control sequences", () => {
    expect(normalizeName("\x1b]0;evil\x07Clean name\x1b[31m", 40)).toBe("Clean name");
  });

  it("recognises KEEP", () => {
    expect(normalizeName("KEEP", 40)).toBe(KEEP);
    expect(normalizeName(" keep.\n", 40)).toBe(KEEP);
  });

  it("returns undefined for empty output", () => {
    expect(normalizeName("  \n \"\" \n", 40)).toBeUndefined();
    expect(normalizeName("", 40)).toBeUndefined();
  });

  it("caps the length at a word boundary", () => {
    const name = normalizeName("Refactor the statusline cache timer block colors", 30)!;
    expect(name.length).toBeLessThanOrEqual(30);
    expect(name.endsWith("…")).toBe(true);
    expect(name).toBe("Refactor the statusline cache…");
  });
});

describe("truncate", () => {
  it("keeps short text", () => expect(truncate("short", 10)).toBe("short"));
  it("hard-cuts a long single word", () => expect(truncate("a".repeat(20), 10)).toBe(`${"a".repeat(9)}…`));
});

describe("fallbackName", () => {
  it("uses the first meaningful line without slash commands or markdown", () => {
    expect(fallbackName("/skill:web **Find** the bug in `auth.ts`\nmore", 40)).toBe("Find the bug in auth.ts");
    expect(fallbackName("\n\n", 40)).toBeUndefined();
  });
});

describe("prompts", () => {
  it("system prompt: noun-phrase rules, no 'session', KEEP only with a current name, JSON answer", () => {
    const p = systemPrompt(40);
    expect(p).toContain("at most 40 characters");
    expect(p).toContain('Never put the word "session"');
    expect(p).toContain('{"title": "..."}');
    expect(p).not.toContain('"keep"');
    expect(systemPrompt(40, "Old name")).toContain("current title is: Old name");
    expect(systemPrompt(40, "Old name")).toContain('{"keep": true}');
  });

  it("user prompt wraps the session as data", () => {
    const first = userPrompt({ first: "tell me a joke", recent: [], assistant: "" });
    expect(first.startsWith("<session>\ntell me a joke\n</session>")).toBe(true);
    const later = userPrompt({ first: "do X", recent: ["then Y"], assistant: "done" });
    expect(later).toContain("<session>\nUser: do X\n\nUser: then Y\n\nAssistant: done\n</session>");
  });
});

describe("parseAnswer", () => {
  it("reads JSON titles and keep", () => {
    expect(parseAnswer('{"title": "Joke request"}', 40)).toBe("Joke request");
    expect(parseAnswer('```json\n{"title":"auth.ts 401 after refresh."}\n```', 40)).toBe("auth.ts 401 after refresh");
    expect(parseAnswer('{"keep": true}', 40)).toBe(KEEP);
  });
  it("falls back to plain text when the model ignores the format", () => {
    expect(parseAnswer("Joke request", 40)).toBe("Joke request");
    expect(parseAnswer("KEEP", 40)).toBe(KEEP);
    expect(parseAnswer('{"title": ""}', 40)).toBeUndefined();
  });
  it("capitalizes the first letter, but not a leading code identifier", () => {
    expect(parseAnswer('{"title": "таймер в statusline"}', 40)).toBe("Таймер в statusline");
    expect(parseAnswer('{"title": "agent_end vs agent_settled"}', 40)).toBe("agent_end vs agent_settled");
    expect(parseAnswer('{"title": "fetch.ts ECONNRESET"}', 40)).toBe("fetch.ts ECONNRESET");
  });
});

describe("titles", () => {
  it("renders the template", () => {
    expect(renderTitle("{name}", { name: "N", cwd: "dev" })).toBe("N");
    expect(renderTitle("{name} · {cwd}", { name: "N", cwd: "dev" })).toBe("N · dev");
  });
  it("mirrors pi's own title", () => {
    expect(piDefaultTitle(undefined, "dev")).toBe("π - dev");
    expect(piDefaultTitle("N", "dev")).toBe("π - N - dev");
  });
});
