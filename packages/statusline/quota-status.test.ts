import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { QuotaStatus } from "./quota-status.ts";

function host() {
  const statuses = new Map<string, string>();
  let footer: { dispose?(): void; render(width: number): string[] } | undefined;
  const source = {
    getExtensionStatuses: () => statuses,
    getGitBranch: () => null,
    getAvailableProviderCount: () => 0,
    onBranchChange: () => () => {},
  };
  const ctx = {
    ui: {
      setFooter(factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) {
        footer?.dispose?.();
        footer = factory?.({} as never, {} as never, source);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses, render: () => footer?.render(80) };
}

describe("quota footer bridge", () => {
  it("reads an already published status and hides all standard footer rows", () => {
    const h = host();
    h.statuses.set("pi-quotas-usage", "5h:91% left 7d:82% left");
    h.statuses.set("pi-quotas-tokens", "unrelated tokens");
    const quotas = new QuotaStatus();
    expect(quotas.getText()).toBe("");
    quotas.hideFooter(h.ctx);
    expect(h.render()).toEqual([]);
    expect(quotas.getText()).toBe("5h:91% left 7d:82% left");
  });

  it("reads late publications, updates, errors, and removals without caching", () => {
    const h = host();
    const quotas = new QuotaStatus();
    quotas.hideFooter(h.ctx);
    expect(quotas.getText()).toBe("");
    h.statuses.set("pi-quotas-usage", "7d:82% left");
    expect(quotas.getText()).toBe("7d:82% left");
    h.statuses.set("pi-quotas-usage", "7d:81% left");
    expect(quotas.getText()).toBe("7d:81% left");
    h.statuses.set("pi-quotas-usage", "usage unavailable");
    expect(quotas.getText()).toBe("usage unavailable");
    h.statuses.delete("pi-quotas-usage");
    expect(quotas.getText()).toBe("");
  });

  it("clears when the footer is restored and reconnects when hidden again", () => {
    const h = host();
    const quotas = new QuotaStatus();
    h.statuses.set("pi-quotas-usage", "7d:82% left");
    quotas.hideFooter(h.ctx);
    h.ctx.ui.setFooter(undefined);
    expect(quotas.getText()).toBe("");
    h.statuses.set("pi-quotas-usage", "7d:80% left");
    quotas.hideFooter(h.ctx);
    expect(quotas.getText()).toBe("7d:80% left");
    quotas.hideFooter(h.ctx);
    expect(quotas.getText()).toBe("7d:80% left");
  });

  it("does not carry data from a closed session into a new session", () => {
    const first = host();
    const next = host();
    const quotas = new QuotaStatus();
    first.statuses.set("pi-quotas-usage", "7d:82% left");
    quotas.hideFooter(first.ctx);
    quotas.clear();
    expect(quotas.getText()).toBe("");
    quotas.hideFooter(next.ctx);
    expect(quotas.getText()).toBe("");
    next.statuses.set("pi-quotas-usage", "5h:90% left");
    expect(quotas.getText()).toBe("5h:90% left");
  });
});
