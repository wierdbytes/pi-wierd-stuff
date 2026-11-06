import { describe, expect, it } from "vitest";
import { fallbackName, KEEP, normalizeName, piDefaultTitle, renderTitle, systemPrompt, truncate, userPrompt } from "./prompt.ts";

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
  it("system prompt carries the length and KEEP instructions only with a current name", () => {
    expect(systemPrompt(40)).toContain("at most 40 characters");
    expect(systemPrompt(40)).not.toContain(KEEP);
    expect(systemPrompt(40, "Old name")).toContain("The current name is: Old name");
    expect(systemPrompt(40, "Old name")).toContain(`exactly ${KEEP}`);
  });

  it("user prompt frames each part", () => {
    const p = userPrompt({ first: "do X", recent: ["then Y"], assistant: "done" });
    expect(p).toContain("<first_request>\ndo X\n</first_request>");
    expect(p).toContain("<recent_requests>\n- then Y\n</recent_requests>");
    expect(p).toContain("<assistant_reply>\ndone\n</assistant_reply>");
    expect(userPrompt({ first: "a", recent: [], assistant: "" })).not.toContain("recent_requests");
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
