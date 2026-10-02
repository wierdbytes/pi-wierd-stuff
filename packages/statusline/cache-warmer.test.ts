import { describe, expect, it } from "vitest";

import { forcedWarmingDecision } from "./cache-warmer.ts";

describe("forcedWarmingDecision", () => {
  it("leaves pi's decision alone while forcing is off", () => {
    expect(forcedWarmingDecision(false, { missCost: 1, warmCost: 0.01 })).toBeUndefined();
  });

  it("warms when the avoided miss beats the refresh cost by at least $0.01", () => {
    expect(forcedWarmingDecision(true, { missCost: 0.04, warmCost: 0.01 })).toEqual({ action: "warm" });
    expect(forcedWarmingDecision(true, { missCost: 0.02, warmCost: 0.005 })).toEqual({ action: "warm" });
  });

  it("stops when the net savings are below $0.01 or unknown", () => {
    expect(forcedWarmingDecision(true, { missCost: 0.015, warmCost: 0.01 })).toEqual({ action: "stop" });
    expect(forcedWarmingDecision(true, { missCost: 0, warmCost: 0 })).toEqual({ action: "stop" });
  });
});
