import { describe, expect, it } from "vitest";
import { lastAssistant, subagentSection, toolDetail } from "./child.ts";

const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role: "assistant", content, ...extra },
});

describe("lastAssistant", () => {
  it("joins the text blocks of the last assistant message", () => {
    const entries = [
      assistant([{ type: "text", text: "old" }]),
      { type: "message", message: { role: "user", content: "next" } },
      assistant([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Found it." },
        { type: "toolCall", name: "read" },
        { type: "text", text: "src/x.ts:12" },
      ]),
      { type: "custom", customType: "x" },
    ];
    expect(lastAssistant(entries)).toEqual({ text: "Found it.\nsrc/x.ts:12", status: "done" });
  });

  it("reports errors and aborts", () => {
    expect(lastAssistant([assistant([], { stopReason: "error", errorMessage: "429" })])).toEqual({
      text: "",
      status: "error",
      error: "429",
    });
    expect(lastAssistant([assistant([{ type: "text", text: "half" }], { stopReason: "aborted" })])?.status).toBe("aborted");
  });

  it("is undefined before any reply", () => {
    expect(lastAssistant([])).toBeUndefined();
  });
});

describe("toolDetail", () => {
  it("picks the telling argument", () => {
    expect(toolDetail({ path: "src/a.ts", offset: 1 })).toBe("src/a.ts");
    expect(toolDetail({ command: "ls -la\necho x" })).toBe("ls -la");
    expect(toolDetail({ n: 1 })).toBeUndefined();
  });
});

describe("subagentSection", () => {
  it("names the parent and appends the type's instructions", () => {
    const s = subagentSection({
      v: 1,
      runId: "r",
      description: "Find auth",
      type: "Explore",
      typePrompt: "READ-ONLY",
      parent: "t12",
      parentPid: 1,
      depth: 1,
      cwd: "/",
      createdAt: 0,
    });
    expect(s).toContain('("Find auth", type Explore)');
    expect(s).toContain("terminal t12");
    expect(s.endsWith("READ-ONLY")).toBe(true);
  });
});
