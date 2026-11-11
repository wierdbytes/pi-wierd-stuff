import { describe, expect, it } from "vitest";
import { duration, forModel, notificationText } from "./format.ts";
import type { AgentSnapshot } from "./manager.ts";

const snap = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  id: "find-auth",
  address: "t8c",
  runId: "r",
  description: "Find auth",
  type: "Explore",
  cwd: "/",
  status: "completed",
  background: true,
  startedAt: 0,
  endedAt: 72_000,
  result: "src/auth.ts:12",
  activity: { tools: 14, turns: 3, at: 1 },
  live: true,
  ...over,
});

describe("duration", () => {
  it("is short", () => {
    expect(duration(4_000)).toBe("4s");
    expect(duration(72_000)).toBe("1m12s");
    expect(duration(3_600_000)).toBe("1h");
  });
});

describe("forModel", () => {
  it("gives the report and what to do next", () => {
    const t = forModel(snap());
    expect(t).toContain('Agent "Find auth" [find-auth · t8c] completed in 1m12s (14 tool calls).');
    expect(t).toContain("\n\nsrc/auth.ts:12\n\n");
    expect(t).toContain("steer_subagent");
  });

  it("describes a running and a blocked agent", () => {
    expect(forModel(snap({ status: "running", endedAt: undefined, activity: { tools: 2, turns: 1, tool: "read", detail: "a.ts", at: 1 } }), 5_000)).toBe(
      'Agent "Find auth" [find-auth · t8c] is still working (5s, 2 tool calls, last: read a.ts).',
    );
    expect(forModel(snap({ status: "blocked", hcMessage: "Allow bash?" }))).toMatch(/blocked waiting for a person \(Allow bash\?\)/);
  });

  it("doesn't offer follow-ups for a closed agent", () => {
    expect(forModel(snap({ live: false }))).not.toContain("steer_subagent");
  });
});

describe("notificationText", () => {
  it("wraps each agent", () => {
    expect(notificationText([snap()])).toMatch(/^<subagent id="find-auth" terminal="t8c" status="completed">\n/);
  });
});
