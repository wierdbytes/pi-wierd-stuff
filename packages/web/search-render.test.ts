/**
 * Renderer-shape tests for `web_search`. Asserts that `renderSearchCall`
 * and `renderSearchResult` produce the open-right rounded chrome from
 * `@wierdbytes/pi-common/tool-frame`.
 *
 * Visual contract under test:
 *
 *   ╭── web_search "query" ───────────────────────────
 *   │   2 sources · 3 cites
 *   ╰── ctrl+o to expand ─────────────────────────────
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentToolResult,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { renderSearchCall, renderSearchResult } from "./render.ts";
import type { WebSearchToolDetails, WebSearchParams } from "./search.ts";
import type { SearchResponse } from "./types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const mockTheme = {
  fg: (_key: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function withStdoutColumns<T>(columns: number, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdout, "columns", descriptor);
    } else {
      delete (process.stdout as NodeJS.WriteStream & { columns?: number })
        .columns;
    }
  }
}

function getTextLines(comp: { getText?: () => string } | { text?: string } | any): string[] {
  const text =
    typeof comp.getText === "function"
      ? comp.getText()
      : (comp.text ?? String(comp));
  return String(text).split("\n");
}

const baseResponse: SearchResponse = {
  answer: "The earth is round.",
  sources: [
    {
      title: "Wikipedia: Earth",
      url: "https://en.wikipedia.org/wiki/Earth",
      pageAge: "1 year ago",
      ageSeconds: 31_536_000,
    },
    {
      title: "NASA: Earth Facts",
      url: "https://nasa.gov/earth",
      pageAge: "2 days ago",
      ageSeconds: 172_800,
    },
  ],
  citations: [
    { url: "https://en.wikipedia.org/wiki/Earth", title: "Wikipedia: Earth" },
    { url: "https://nasa.gov/earth", title: "NASA: Earth Facts" },
    { url: "https://nasa.gov/earth", title: "NASA: Earth Facts" },
  ],
  searchQueries: ["earth shape"],
  model: "claude-haiku-4-5",
  requestId: "req_test",
  usage: { inputTokens: 0, outputTokens: 0, searchRequests: 1 },
};

function makeResult(
  overrides: Partial<WebSearchToolDetails> = {},
): AgentToolResult<WebSearchToolDetails> {
  const details: WebSearchToolDetails = { response: baseResponse, ...overrides };
  return {
    content: [{ type: "text", text: "stub" }],
    details,
  } as AgentToolResult<WebSearchToolDetails>;
}

const baseCtx = {
  isError: false,
  isPartial: false,
} as const;

/**
 * Build a render context with the optional `state` + `invalidate`
 * fields the renderer expects for its elapsed-time state machine. The
 * default `baseCtx` omits these so we can also assert the renderer
 * tolerates a context that lacks them.
 */
function ctxWithState(
  overrides: { isError?: boolean; isPartial?: boolean } = {},
) {
  return {
    ...baseCtx,
    ...overrides,
    state: {} as Record<string, unknown>,
    invalidate: () => {},
  };
}

const partialOptions: ToolRenderResultOptions = {
  isPartial: true,
  expanded: false,
} as ToolRenderResultOptions;

const collapsedOptions: ToolRenderResultOptions = {
  isPartial: false,
  expanded: false,
} as ToolRenderResultOptions;

const expandedOptions: ToolRenderResultOptions = {
  isPartial: false,
  expanded: true,
} as ToolRenderResultOptions;

// ---------------------------------------------------------------------------

describe("renderSearchCall", () => {
  afterEach(() => {});

  it("renders the open-right top border with the search query", () => {
    withStdoutColumns(80, () => {
      const args: WebSearchParams = { query: "earth shape" };
      const out = renderSearchCall(args, mockTheme, baseCtx);
      const lines = getTextLines(out);
      expect(lines).toHaveLength(1);
      const plain = stripAnsi(lines[0]);
      expect(plain).toMatch(/^╭── web_search "earth shape" ─+$/);
      expect(visibleWidth(lines[0])).toBe(80);
    });
  });

  it("includes flag annotations in the title (max_uses, country)", () => {
    withStdoutColumns(120, () => {
      const args: WebSearchParams = {
        query: "vaccine policy",
        max_uses: 3,
        user_location: { type: "approximate", country: "US" },
      };
      const out = renderSearchCall(args, mockTheme, baseCtx);
      const plain = stripAnsi(getTextLines(out)[0]);
      expect(plain).toContain('"vaccine policy"');
      expect(plain).toContain("max=3");
      expect(plain).toContain("US");
    });
  });

  it("respects narrow widths (24 cols)", () => {
    withStdoutColumns(24, () => {
      const args: WebSearchParams = {
        query: "x".repeat(80),
      };
      const out = renderSearchCall(args, mockTheme, baseCtx);
      for (const line of getTextLines(out)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(24);
      }
    });
  });
});

// ---------------------------------------------------------------------------

describe("renderSearchResult — pending", () => {
  it("renders a `│ `-prefixed pending body + live elapsed-time bottom-label", () => {
    withStdoutColumns(80, () => {
      const out = renderSearchResult(
        makeResult(),
        partialOptions,
        mockTheme,
        ctxWithState(),
      );
      const lines = getTextLines(out);
      expect(lines).toHaveLength(2);
      expect(stripAnsi(lines[0])).toMatch(/^│ Searching…/);
      // Bottom-label carries the live `0.0s`-style elapsed timer.
      expect(stripAnsi(lines[1])).toMatch(/^╰── \d+\.\d+s ─+$/);
      expect(visibleWidth(lines[1])).toBe(80);
    });
  });
});

// ---------------------------------------------------------------------------

describe("renderSearchResult — error", () => {
  it("renders the error message `│ `-prefixed + elapsed-time + `✗ ` tag", () => {
    withStdoutColumns(80, () => {
      const out = renderSearchResult(
        makeResult({ response: undefined, error: "rate limited", status: 429 }),
        collapsedOptions,
        mockTheme,
        ctxWithState(),
      );
      const lines = getTextLines(out);
      expect(stripAnsi(lines[0])).toMatch(
        /^│ web_search error \[429\]: rate limited/,
      );
      // Bottom-label: `<duration> · ✗ rate limited`.
      expect(stripAnsi(lines[lines.length - 1])).toMatch(
        /^╰── \d+\.\d+s · ✗ rate limited ─+$/,
      );
    });
  });

  it("handles the no-response branch with an error frame + `✗ no data` tag", () => {
    withStdoutColumns(80, () => {
      const out = renderSearchResult(
        makeResult({ response: undefined }),
        collapsedOptions,
        mockTheme,
        ctxWithState(),
      );
      const lines = getTextLines(out);
      expect(stripAnsi(lines[0])).toMatch(/^│ web_search returned no data/);
      expect(stripAnsi(lines[lines.length - 1])).toMatch(
        /^╰── \d+\.\d+s · ✗ no data ─+$/,
      );
    });
  });
});

// ---------------------------------------------------------------------------

describe("renderSearchResult — collapsed success", () => {
  it("renders an answer preview body + elapsed-time/counts/expand bottom-label", () => {
    withStdoutColumns(120, () => {
      const out = renderSearchResult(
        makeResult(),
        collapsedOptions,
        mockTheme,
        ctxWithState(),
      );
      const lines = getTextLines(out);
      // Body: a single answer-preview line (`The earth is round.`).
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const firstBody = stripAnsi(lines[0]);
      expect(firstBody).toMatch(/^│ /);
      expect(firstBody).toContain("The earth is round.");
      // Bottom-label leads with the frozen elapsed time, then counts.
      const bottom = stripAnsi(lines[lines.length - 1]);
      expect(bottom).toMatch(
        /^╰── \d+\.\d+s · 2 sources · 3 cites · 1 query · srv=1 · ctrl\+o to expand ─+$/,
      );
      expect(visibleWidth(lines[lines.length - 1])).toBe(120);
    });
  });

  it("adds a `... N more lines` overflow indicator past the preview cap", () => {
    withStdoutColumns(120, () => {
      const longAnswer = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
        "\n",
      );
      const out = renderSearchResult(
        makeResult({
          response: {
            ...baseResponse,
            answer: longAnswer,
          },
        }),
        collapsedOptions,
        mockTheme,
        ctxWithState(),
      );
      const plain = getTextLines(out).map(stripAnsi);
      // 5 preview rows + the `... 7 more lines` indicator + bottom border.
      const overflowRow = plain.find((l) => /^│ \.\.\. 7 more lines/.test(l));
      expect(overflowRow).toBeTruthy();
    });
  });

  it("shows `(no answer)` when the response has no synthesized text", () => {
    withStdoutColumns(100, () => {
      const out = renderSearchResult(
        makeResult({ response: { ...baseResponse, answer: undefined } }),
        collapsedOptions,
        mockTheme,
        ctxWithState(),
      );
      const plain = getTextLines(out).map(stripAnsi);
      expect(plain[0]).toBe("│ (no answer)");
    });
  });
});

// ---------------------------------------------------------------------------

describe("renderSearchResult — expanded success", () => {
  it("renders answer + sources rail-prefixed and elapsed/counts in the bottom label", () => {
    withStdoutColumns(120, () => {
      const out = renderSearchResult(
        makeResult(),
        expandedOptions,
        mockTheme,
        ctxWithState(),
      );
      const lines = getTextLines(out);
      const plain = lines.map(stripAnsi);

      // Body content rows all carry the `│ ` rail.
      for (const line of plain.slice(0, -1)) {
        expect(line.startsWith("│")).toBe(true);
      }

      // First body line: the answer text.
      expect(plain[0]).toContain("The earth is round.");

      // Body must contain a Sources header and per-source rows.
      const middle = plain.slice(0, -1).join("\n");
      expect(middle).toContain("Sources");
      expect(middle).toContain("Wikipedia: Earth");
      expect(middle).toContain("https://nasa.gov/earth");

      // Bottom-label: elapsed-time + counts, no expand hint when expanded.
      const bottom = plain[plain.length - 1];
      expect(bottom).toMatch(
        /^╰── \d+\.\d+s · 2 sources · 3 cites · 1 query · srv=1 ─+$/,
      );
      expect(bottom).not.toContain("ctrl+o");

      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(120);
      }
    });
  });

  it("renders a no-sources expanded result without a Sources block", () => {
    withStdoutColumns(100, () => {
      const out = renderSearchResult(
        makeResult({
          response: { ...baseResponse, sources: [], citations: [] },
        }),
        expandedOptions,
        mockTheme,
        ctxWithState(),
      );
      const plain = getTextLines(out).map(stripAnsi);
      const middle = plain.slice(0, -1).join("\n");
      expect(middle).not.toContain("Sources");
      expect(middle).toContain("The earth is round.");
      // Bottom label leads with elapsed-time, then graceful 0-source counts.
      expect(plain[plain.length - 1]).toMatch(
        /^╰── \d+\.\d+s · 0 sources/,
      );
    });
  });
});
