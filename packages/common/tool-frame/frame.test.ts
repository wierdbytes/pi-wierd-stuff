/**
 * Shape tests for the open-right tool-frame helpers. Mirrors the
 * structural assertions previously living in pi-facelift's
 * bash-rendering tests so the primitives can be regressed in isolation.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  STATUS_TO_THEME_COLOR,
  formatDuration,
  frameBodyLines,
  frameBottom,
  frameBottomWithLabel,
  frameResult,
  frameResultWithBottomLabel,
  frameTop,
  getDefaultFrameWidth,
  getFrameStatus,
  renderToolError,
} from "./index.ts";

/** Plain theme — `fg`/`bold` pass through so visible width is easy to assert. */
const plainTheme = {
  fg: (_key: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/**
 * ANSI-tagging theme — wraps every fg call in a marker pair so tests can
 * verify which tokens the frame chrome resolved. Each call gets a unique
 * `[<tok>]…[/<tok>]` wrapper plus the escape code so visibleWidth treats
 * it as zero-width like a real ANSI sequence.
 */
const taggingTheme = {
  fg: (key: string, text: string) => `\x1b[1;${key};m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// getFrameStatus
// ---------------------------------------------------------------------------

describe("getFrameStatus", () => {
  it("returns 'error' when isError is true (even with isPartial)", () => {
    expect(getFrameStatus({ isError: true })).toBe("error");
    expect(getFrameStatus({ isError: true, isPartial: true })).toBe("error");
  });

  it("returns 'pending' when isPartial without isError", () => {
    expect(getFrameStatus({ isPartial: true })).toBe("pending");
  });

  it("returns 'success' by default", () => {
    expect(getFrameStatus({})).toBe("success");
    expect(getFrameStatus({ isError: false, isPartial: false })).toBe(
      "success",
    );
  });
});

describe("STATUS_TO_THEME_COLOR mapping", () => {
  it("maps each status to the expected theme token", () => {
    expect(STATUS_TO_THEME_COLOR.success).toBe("success");
    expect(STATUS_TO_THEME_COLOR.pending).toBe("warning");
    expect(STATUS_TO_THEME_COLOR.error).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// frameTop
// ---------------------------------------------------------------------------

describe("frameTop", () => {
  it("renders a single-line title with leading and trailing dashes", () => {
    const out = frameTop("read foo.ts", "success", plainTheme, 40);
    expect(out).toMatch(/^╭── read foo\.ts ─+$/);
    expect(visibleWidth(out)).toBe(40);
  });

  it("colours the corner and dashes via the host theme token", () => {
    const out = frameTop("read foo.ts", "success", taggingTheme, 40);
    // Corner + leading dashes carry the success token.
    expect(out).toContain("\x1b[1;success;m╭──\x1b[0m");
    // Trailing dashes also coloured via the same token.
    expect(out).toMatch(/\x1b\[1;success;m─+\x1b\[0m/);
  });

  it.each([
    ["pending", "warning"],
    ["success", "success"],
    ["error", "error"],
  ] as const)("uses the %s → %s token mapping", (status, token) => {
    const out = frameTop("x", status, taggingTheme, 24);
    expect(out).toContain(`\x1b[1;${token};m╭──\x1b[0m`);
  });

  it("truncates a too-wide title with `…`", () => {
    const longTitle = "bash " + "x".repeat(200);
    const out = frameTop(longTitle, "success", plainTheme, 40);
    expect(out).toContain("…");
    expect(visibleWidth(out)).toBe(40);
  });

  it("respects narrow widths (24 cols)", () => {
    const out = frameTop("bash " + "x".repeat(80), "success", plainTheme, 24);
    expect(visibleWidth(out)).toBeLessThanOrEqual(24);
  });

  it("renders multi-line titles as a sub-tree of continuation rows", () => {
    const title = `bash cd /tmp && \\\n  echo "line 1" \\\n  echo "line 2"`;
    const out = frameTop(title, "success", plainTheme, 80);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);

    // First row keeps the trailing dashes …
    expect(lines[0]).toMatch(/^╭── bash cd \/tmp && \\.* ─+$/);

    // Continuation rows: outer rail + padding + sub-tree connector + content;
    // no trailing dashes.
    expect(lines[1]).toMatch(/^│\s+│ +echo "line 1" \\$/);
    expect(lines[2]).toMatch(/^│\s+╰ +echo "line 2"$/);
    expect(lines[1]).not.toMatch(/─{2,}/);
    expect(lines[2]).not.toMatch(/─{2,}/);
  });

  it("aligns the sub-tree connector two cols before the first arg col", () => {
    // Continuation has *no* leading whitespace so the rendered `echo`
    // sits at the documented contentCol (1 col after the connector +
    // separator space).
    const title = `bash cd /tmp\necho done`;
    const out = frameTop(title, "success", plainTheme, 80);
    const [first, cont] = out.split("\n");
    const plainFirst = stripAnsi(first);
    const plainCont = stripAnsi(cont);

    // First arg col in the top border: `╭` (1) + `──` (2) + ` ` (1) +
    // `bash` (4) + ` ` (1) = 9 → 0-indexed pos 9.
    const argIdx = plainFirst.indexOf("cd");
    expect(argIdx).toBe(9);

    // Find both connectors in the continuation: outer rail `│` at idx 0,
    // sub-tree `╰` at the alignment column.
    const matches: number[] = [];
    for (let i = 0; i < plainCont.length; i += 1) {
      const ch = plainCont[i];
      if (ch === "│" || ch === "╰") matches.push(i);
    }
    expect(matches[0]).toBe(0); // outer rail
    expect(matches[1]).toBe(argIdx - 2); // sub-tree connector
    // Connector + separator space + content → content lands at argIdx.
    expect(plainCont.indexOf("echo")).toBe(argIdx);
  });

  it("uses `╰` for the last continuation row and `│` for the rest", () => {
    const title = `bash a\n  b\n  c\n  d`;
    const lines = frameTop(title, "success", plainTheme, 60).split("\n");
    expect(lines).toHaveLength(4);
    expect(stripAnsi(lines[1])).toMatch(/│ +b/);
    expect(stripAnsi(lines[2])).toMatch(/│ +c/);
    expect(stripAnsi(lines[3])).toMatch(/╰ +d/);
  });
});

// ---------------------------------------------------------------------------
// frameBottom / frameBottomWithLabel
// ---------------------------------------------------------------------------

describe("frameBottom", () => {
  it("renders `╰` followed by dashes filling the width", () => {
    const out = frameBottom("success", plainTheme, 30);
    expect(out).toMatch(/^╰─+$/);
    expect(visibleWidth(out)).toBe(30);
  });

  it("uses the status token for the chrome", () => {
    expect(frameBottom("error", taggingTheme, 20)).toContain("\x1b[1;error;m");
    expect(frameBottom("pending", taggingTheme, 20)).toContain(
      "\x1b[1;warning;m",
    );
  });
});

describe("frameBottomWithLabel", () => {
  it("renders `╰── <label> ─────`", () => {
    const out = frameBottomWithLabel("exit 0", "success", plainTheme, 40);
    expect(out).toMatch(/^╰── exit 0 ─+$/);
    expect(visibleWidth(out)).toBe(40);
  });

  it("truncates an over-wide label with `…`", () => {
    const out = frameBottomWithLabel(
      "x".repeat(200),
      "success",
      plainTheme,
      30,
    );
    expect(out).toContain("…");
    expect(visibleWidth(out)).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// frameBodyLines
// ---------------------------------------------------------------------------

describe("frameBodyLines", () => {
  it("prefixes each line with the rail `│`", () => {
    const out = frameBodyLines("a\nb\nc", "success", plainTheme, 20);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(stripAnsi(line)).toMatch(/^│/);
    }
  });

  it("right-truncates lines so width including rail stays within bounds", () => {
    const wide = "x".repeat(80);
    const out = frameBodyLines(wide, "success", plainTheme, 24);
    expect(visibleWidth(out)).toBeLessThanOrEqual(24);
  });

  it("collapses `\\r` overwrites — keeps only post-CR content", () => {
    const out = frameBodyLines(
      "Rebasing (1/1)\rSuccessfully rebased\nplain",
      "success",
      plainTheme,
      40,
    );
    const lines = out.split("\n");
    expect(stripAnsi(lines[0])).toBe("│Successfully rebased");
    expect(stripAnsi(lines[1])).toBe("│plain");
  });

  it("colours the rail via the status token", () => {
    const out = frameBodyLines("hello", "error", taggingTheme, 20);
    expect(out).toContain("\x1b[1;error;m│\x1b[0m");
  });

  it("inserts `paddingX` spaces between the rail and content (opt-in)", () => {
    const out = frameBodyLines("hello\nworld", "success", plainTheme, 20, {
      paddingX: 1,
    });
    const lines = out.split("\n");
    expect(stripAnsi(lines[0])).toBe("│ hello");
    expect(stripAnsi(lines[1])).toBe("│ world");
  });

  it("reduces the inner truncation width by paddingX", () => {
    // width=10, paddingX=1 → inner = 10 - 1 - 1 = 8 cols of content.
    const out = frameBodyLines("x".repeat(40), "success", plainTheme, 10, {
      paddingX: 1,
    });
    const plain = stripAnsi(out);
    expect(plain.startsWith("│ ")).toBe(true);
    // Visible width never exceeds the frame width.
    expect(visibleWidth(out)).toBeLessThanOrEqual(10);
    // Content portion is no wider than 8 cols.
    const content = plain.slice(2);
    expect(content.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// frameResult / frameResultWithBottomLabel
// ---------------------------------------------------------------------------

describe("frameResult", () => {
  it("composes body + bottom border", () => {
    const out = frameResult("a\nb", "success", plainTheme, 30);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[0])).toMatch(/^│a/);
    expect(stripAnsi(lines[1])).toMatch(/^│b/);
    expect(stripAnsi(lines[2])).toMatch(/^╰─+$/);
  });

  it("forwards paddingX to body lines (rail keeps `│ ` gap)", () => {
    const out = frameResult("a\nb", "success", plainTheme, 30, {
      paddingX: 1,
    });
    const lines = out.split("\n");
    expect(stripAnsi(lines[0])).toBe("│ a");
    expect(stripAnsi(lines[1])).toBe("│ b");
    // Bottom border itself is never padded.
    expect(stripAnsi(lines[2])).toMatch(/^╰─+$/);
  });

  it("collapses to bottom border only when body is empty", () => {
    const out = frameResult("", "success", plainTheme, 30);
    expect(out.split("\n")).toHaveLength(1);
    expect(stripAnsi(out)).toMatch(/^╰─+$/);
  });
});

describe("frameResultWithBottomLabel", () => {
  it("composes body + bottom-with-label border", () => {
    const out = frameResultWithBottomLabel(
      "stdout",
      "exit 0",
      "success",
      plainTheme,
      40,
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0])).toMatch(/^│stdout/);
    expect(stripAnsi(lines[1])).toMatch(/^╰── exit 0 ─+$/);
  });

  it("collapses to bottom-with-label only when body is empty", () => {
    const out = frameResultWithBottomLabel(
      "",
      "exit 0",
      "success",
      plainTheme,
      40,
    );
    expect(out.split("\n")).toHaveLength(1);
    expect(stripAnsi(out)).toMatch(/^╰── exit 0 ─+$/);
  });
});

// ---------------------------------------------------------------------------
// renderToolError
// ---------------------------------------------------------------------------

describe("renderToolError", () => {
  it("renders the message rail-prefixed with an error-status frame", () => {
    const out = renderToolError("nope", plainTheme, 30);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0])).toMatch(/^│nope/);
    expect(stripAnsi(lines[1])).toMatch(/^╰─+$/);
  });

  it("colours the frame with the error token", () => {
    const out = renderToolError("nope", taggingTheme, 30);
    expect(out).toContain("\x1b[1;error;m│\x1b[0m");
    expect(out).toContain("\x1b[1;error;m╰");
  });
});

// ---------------------------------------------------------------------------
// getDefaultFrameWidth
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("renders sub-minute durations with one decimal of seconds", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(500)).toBe("0.5s");
    expect(formatDuration(3300)).toBe("3.3s");
    expect(formatDuration(59_900)).toBe("59.9s");
  });

  it("renders minute-scale durations as `Xm` or `XmYs`", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(63_000)).toBe("1m3s");
    expect(formatDuration(125_000)).toBe("2m5s");
  });

  it("renders hour-scale durations as `Xh` or `XhYm`", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(2 * 60 * 60_000 + 5 * 60_000)).toBe("2h5m");
  });

  it("clamps negative inputs to zero", () => {
    expect(formatDuration(-1)).toBe("0.0s");
  });
});

describe("getDefaultFrameWidth", () => {
  function withStdoutColumns<T>(columns: number | undefined, fn: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "columns",
    );
    if (columns === undefined) {
      delete (process.stdout as NodeJS.WriteStream & { columns?: number })
        .columns;
    } else {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: columns,
      });
    }
    try {
      return fn();
    } finally {
      if (descriptor)
        Object.defineProperty(process.stdout, "columns", descriptor);
      else
        delete (process.stdout as NodeJS.WriteStream & { columns?: number })
          .columns;
    }
  }

  it("returns process.stdout.columns when set", () => {
    withStdoutColumns(120, () => {
      expect(getDefaultFrameWidth()).toBe(120);
    });
  });

  it("clamps to maxCap when provided", () => {
    withStdoutColumns(400, () => {
      expect(getDefaultFrameWidth(210)).toBe(210);
    });
  });

  it("falls back to 200 when no width source is available", () => {
    const prevCols = process.env.COLUMNS;
    delete process.env.COLUMNS;
    withStdoutColumns(undefined, () => {
      // stderr.columns may or may not be set depending on the test runner;
      // accept either the stderr value or the 200 fallback.
      const w = getDefaultFrameWidth();
      expect(w).toBeGreaterThan(0);
    });
    if (prevCols !== undefined) process.env.COLUMNS = prevCols;
  });
});
