import { describe, expect, it } from "vitest";
import { BUILTIN_TYPES, findType, parseAgentFile, parseFrontmatter } from "./agent-types.ts";

describe("parseFrontmatter", () => {
  it("reads key: value lines and the body", () => {
    const { fm, body } = parseFrontmatter('---\nname: reviewer\ndescription: "Reviews diffs" # comment\n---\n\nBe strict.\n');
    expect(fm).toEqual({ name: "reviewer", description: "Reviews diffs" });
    expect(body).toBe("Be strict.");
  });

  it("treats a file without frontmatter as all body", () => {
    expect(parseFrontmatter("Just text")).toEqual({ fm: {}, body: "Just text" });
  });
});

describe("parseAgentFile", () => {
  it("maps pi-subagents fields", () => {
    const t = parseAgentFile(
      "reviewer.md",
      "---\ndescription: Reviews\nmodel: inherit\nthinking: medium\ntools: [read, grep, bash]\ndisallowed_tools: write,edit\n---\nCheck it.",
      "user",
    );
    expect(t).toMatchObject({
      name: "reviewer",
      description: "Reviews",
      model: undefined,
      thinking: "medium",
      tools: ["read", "grep", "bash"],
      excludeTools: ["write", "edit"],
      prompt: "Check it.",
      source: "user",
    });
  });
});

describe("findType", () => {
  const types = new Map(BUILTIN_TYPES.map((t) => [t.name, t]));

  it("defaults to general-purpose and ignores case", () => {
    expect(findType(types, undefined)?.name).toBe("general-purpose");
    expect(findType(types, "explore")?.name).toBe("Explore");
    expect(findType(types, "nope")).toBeUndefined();
  });
});
