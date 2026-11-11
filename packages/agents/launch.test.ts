import { describe, expect, it } from "vitest";
import { buildArgv, inheritedEnv, nameCandidate, slugName } from "./launch.ts";

describe("slugName", () => {
  it("makes hc-safe names", () => {
    expect(slugName("Find auth code!")).toBe("find-auth-code");
    expect(slugName("  --Weird__ name..  ")).toBe("weird-name");
  });

  it("transliterates Cyrillic", () => {
    expect(slugName("Проверка кириллицы")).toBe("proverka-kirillitsy");
  });

  it("falls back to agent and keeps room for a suffix", () => {
    expect(slugName("!!!")).toBe("agent");
    expect(slugName("a".repeat(50)).length).toBe(28);
  });
});

describe("nameCandidate", () => {
  it("adds -N within 32 characters", () => {
    expect(nameCandidate("review", 1)).toBe("review");
    expect(nameCandidate("review", 3)).toBe("review-3");
    expect(nameCandidate("x".repeat(32), 12)).toHaveLength(32);
  });
});

describe("buildArgv", () => {
  const settings = { command: ["pi"], extraArgs: ["--no-voice"] };

  it("puts options first and the task after --", () => {
    expect(
      buildArgv(settings, {
        model: "anthropic/claude-sonnet-5-5",
        thinking: "low",
        tools: ["read", "grep"],
        excludeTools: ["write"],
        sessionName: "Review diff",
        prompt: "Review it",
      }),
    ).toEqual([
      "pi",
      "--model",
      "anthropic/claude-sonnet-5-5",
      "--thinking",
      "low",
      "--tools",
      "read,grep",
      "--exclude-tools",
      "write",
      "--name",
      "Review diff",
      "--no-voice",
      "--",
      "Review it",
    ]);
  });

  it("keeps a task starting with @ from being read as a file", () => {
    const argv = buildArgv(settings, { sessionName: "x", prompt: "@foo do it" });
    expect(argv.at(-1)).toBe("Task:\n@foo do it");
  });
});

describe("inheritedEnv", () => {
  it("drops terminal identity and the parent's session", () => {
    const env = inheritedEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "k",
      HC_TERMINAL_ID: "t1",
      HC_TERMINAL_SOCKET: "/s",
      HC_SCOPE: "x",
      HERDR_PANE_ID: "p",
      TERM: "xterm",
      TERM_PROGRAM: "ghostty",
      PI_SESSION_ID: "s",
      PI_AGENTS_RUN: "r",
      "  --color": "bad",
    });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k" });
  });
});
