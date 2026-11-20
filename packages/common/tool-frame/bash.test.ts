/**
 * The shared bash renderer: what pi-facelift and pi-herdr draw for a bash
 * call. pi-facelift's bash-rendering tests cover the call header in depth;
 * these cover the result side, the running label and `frameTop`'s right
 * label.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type BashRenderContext, bashResultDetails, createBashRenderers } from "./bash.ts";
import { frameTop } from "./index.ts";

class MockText {
  text = "";
  setText(value: string) {
    this.text = value;
  }
}

const theme = {
  fg: (_key: string, text: string) => text,
  bold: (text: string) => text,
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function context(over: Partial<BashRenderContext> = {}): BashRenderContext {
  return { state: {}, expanded: false, isError: false, isPartial: false, executionStarted: true, invalidate: () => {}, ...over };
}

const renderers = (options: Parameters<typeof createBashRenderers<MockText>>[0] = {}) =>
  createBashRenderers<MockText>({ TextComponent: MockText, width: () => 60, ...options });

afterEach(() => {
  vi.useRealTimers();
});

describe("frameTop rightLabel", () => {
  const plain = theme as unknown as Theme;

  it("puts the label near the right end and keeps the width", () => {
    const out = frameTop("bash npm test", "pending", plain, 40, { rightLabel: "t14s" });
    expect(out).toMatch(/^╭── bash npm test ─+ t14s ─$/);
    expect(visibleWidth(out)).toBe(40);
  });

  it("truncates the title to make room for the label", () => {
    const out = frameTop(`bash ${"x".repeat(80)}`, "pending", plain, 40, { rightLabel: "t14s" });
    expect(out.endsWith(" t14s ─")).toBe(true);
    expect(out).toContain("…");
    expect(visibleWidth(out)).toBe(40);
  });

  it("leaves the label out when the frame is too narrow", () => {
    const out = frameTop("bash npm test", "pending", plain, 20, { rightLabel: "t14s" });
    expect(out).not.toContain("t14s");
    expect(visibleWidth(out)).toBe(20);
  });

  it("keeps the label on the first row of a multi-line title", () => {
    const out = frameTop("bash cd /x && \\\necho hi", "pending", plain, 40, { rightLabel: "t14s" }).split("\n");
    expect(out[0]).toMatch(/ t14s ─$/);
    expect(out[1]).not.toContain("t14s");
  });
});

describe("renderResult", () => {
  it("lifts pi's `Command exited with code N` into the bottom border", () => {
    const { renderResult } = renderers();
    const out = strip(
      renderResult(
        { content: [{ type: "text", text: "a\nb\n\nCommand exited with code 2" }] },
        { isPartial: false },
        theme,
        context({ isError: true }),
      ).text,
    );
    expect(out).not.toContain("Command exited");
    expect(out).toMatch(/╰── .*✗ exit 2 \(2 lines\)/);
    expect(out.split("\n").slice(0, 2)).toEqual(["│a", "│b"]);
  });

  it("reads exit 0 from a plain successful result", () => {
    const { renderResult } = renderers();
    const out = strip(renderResult({ content: [{ type: "text", text: "ok" }] }, { isPartial: false }, theme, context()).text);
    expect(out).toMatch(/✓ exit 0/);
  });

  it("shows timeouts and aborts", () => {
    const { renderResult } = renderers();
    const draw = (text: string) =>
      strip(renderResult({ content: [{ type: "text", text }] }, { isPartial: false }, theme, context({ isError: true })).text);
    expect(draw("x\n\nCommand timed out after 5 seconds")).toContain("⚡ timed out");
    expect(draw("x\n\nCommand aborted")).toContain("⚡ aborted");
    expect(draw("x\n\nCommand terminated without an exit code")).toContain("⚡ terminated");
  });

  it("lifts a timeout whose shell had already exited", () => {
    const { renderResult } = renderers();
    const out = strip(
      renderResult(
        {
          content: [
            {
              type: "text",
              text:
                "x\n\nCommand timed out after 10 seconds. The shell exited with code 0 after 1.2 seconds, but background processes it started kept writing output until the timeout.",
            },
          ],
        },
        { isPartial: false },
        theme,
        context({ isError: true }),
      ).text,
    );
    expect(out).toContain("⚡ timed out (shell exit 0)");
    expect(out).not.toContain("background processes");
    expect(out.split("\n")[0]).toBe("│x");
  });

  it("takes facelift's details when present", () => {
    const { renderResult } = renderers();
    const out = strip(
      renderResult({ content: [], details: bashResultDetails("one\ntwo", "ls") }, { isPartial: false }, theme, context()).text,
    );
    expect(out).toContain("│one");
    expect(out).toMatch(/✓ exit 0 \(2 lines\)/);
  });

  it("cuts a collapsed body to maxPreviewLines", () => {
    const { renderResult } = renderers({ maxPreviewLines: 3 });
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const out = strip(renderResult({ content: [{ type: "text", text }] }, { isPartial: false }, theme, context()).text);
    expect(out).toContain("line 2");
    expect(out).not.toContain("line 3");
    expect(out).toContain("… 7 more lines");
  });
});

describe("bashResultDetails", () => {
  it("reads the exit code from pi's text", () => {
    expect(bashResultDetails("x\n\nCommand exited with code 3", "c").exitCode).toBe(3);
    expect(bashResultDetails("fine", "c").exitCode).toBe(0);
    expect(bashResultDetails("bash: nope: command not found", "c").exitCode).toBe(1);
  });
});

describe("runningLabel", () => {
  const label = (details: unknown) => (details as { where?: string } | undefined)?.where;

  it("draws the label in the top border while the command runs, and drops it after", async () => {
    const { renderCall, renderResult } = renderers({ runningLabel: label });
    const invalidate = vi.fn();
    const ctx = context({ isPartial: true, invalidate });
    const args = { command: "sleep 5" };

    // The call row is drawn first: no label known yet.
    expect(renderCall(args, theme, ctx).text).not.toContain("t14s");
    renderResult({ content: [], details: { where: "t14s" } }, { isPartial: true }, theme, ctx);
    // The row is drawn again once the label is known.
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    const top = renderCall(args, theme, ctx).text;
    expect(top).toMatch(/ t14s ─$/);
    expect(visibleWidth(top)).toBe(60);

    // Finished: no label, even before the result render clears it.
    const done = context({ state: ctx.state, isPartial: false });
    expect(renderCall(args, theme, done).text).not.toContain("t14s");
    renderResult({ content: [{ type: "text", text: "" }] }, { isPartial: false }, theme, done);
    expect(ctx.state.runningLabel).toBeUndefined();
    if (ctx.state.interval) clearInterval(ctx.state.interval);
  });

  it("leaves the top border alone without the option", () => {
    const { renderCall, renderResult } = renderers();
    const ctx = context({ isPartial: true });
    renderResult({ content: [], details: { where: "t14s" } }, { isPartial: true }, theme, ctx);
    expect(renderCall({ command: "x" }, theme, ctx).text).not.toContain("t14s");
    if (ctx.state.interval) clearInterval(ctx.state.interval);
  });
});
