/**
 * Renderer-shape tests for `web_fetch`. Asserts that `renderFetchCall`
 * and `renderFetchResult` produce the open-right rounded chrome from
 * `@wierdbytes/pi-common/tool-frame`, both for single-page and batch
 * call shapes, and across pending / error / collapsed-success /
 * expanded-success result branches.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";

import type {
  AgentToolResult,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";

// `renderFetchResult`'s expanded-success branch calls
// `getMarkdownTheme()`, which proxies into pi-coding-agent's global
// theme singleton. Tests must initialise it once before any expanded
// render runs — otherwise `theme.underline(...)` etc. throw
// "Theme not initialised".
beforeAll(() => {
  initTheme("dark");
});
import { renderFetchCall, renderFetchResult } from "./fetch-render.ts";
import type { BatchPageState, WebFetchToolDetails } from "./fetch-types.ts";
import type { WebFetchParams } from "./fetch.ts";

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

function getTextLines(comp: any): string[] {
  if (typeof comp.getText === "function") return comp.getText().split("\n");
  if (typeof comp.text === "string") return comp.text.split("\n");
  return String(comp).split("\n");
}

/**
 * Walk a `Container` (or single component) and collect every Text-shaped
 * child's body. Markdown widgets don't expose their rendered text so we
 * just record their constructor name as a placeholder.
 */
function collectChildTexts(comp: any): string[] {
  if (!comp) return [];
  if (Array.isArray(comp.children)) {
    return comp.children.flatMap(collectChildTexts);
  }
  if (typeof comp.getText === "function") return [comp.getText()];
  if (typeof comp.text === "string") return [comp.text];
  return [`<${comp.constructor?.name ?? "Component"}>`];
}

function makeResult(
  text: string,
  overrides: Partial<AgentToolResult<WebFetchToolDetails>> = {},
): AgentToolResult<WebFetchToolDetails> {
  return {
    content: [{ type: "text", text }],
    details: {},
    ...overrides,
  } as AgentToolResult<WebFetchToolDetails>;
}

function makeBatchResult(
  pages: BatchPageState[],
): AgentToolResult<WebFetchToolDetails> {
  return {
    content: [{ type: "text", text: "" }],
    details: { pages },
  } as AgentToolResult<WebFetchToolDetails>;
}

const baseCtx = { isError: false, isPartial: false } as const;

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

const collapsedOptions: ToolRenderResultOptions = {
  isPartial: false,
  expanded: false,
} as ToolRenderResultOptions;

const expandedOptions: ToolRenderResultOptions = {
  isPartial: false,
  expanded: true,
} as ToolRenderResultOptions;

const pendingOptions: ToolRenderResultOptions = {
  isPartial: true,
  expanded: false,
} as ToolRenderResultOptions;

// ---------------------------------------------------------------------------
// renderFetchCall
// ---------------------------------------------------------------------------

describe("renderFetchCall — single page", () => {
  it("renders a single-line top border with the URL", () => {
    withStdoutColumns(80, () => {
      const args: WebFetchParams = { url: "https://example.com/foo" };
      const out = renderFetchCall(args, mockTheme, baseCtx);
      const lines = getTextLines(out);
      expect(lines).toHaveLength(1);
      const plain = stripAnsi(lines[0]);
      expect(plain).toMatch(/^╭── web_fetch /);
      expect(plain).toContain("example.com/foo");
      expect(plain).toMatch(/─+$/);
      expect(visibleWidth(lines[0])).toBe(80);
    });
  });

  it("appends the optional prompt suffix", () => {
    withStdoutColumns(120, () => {
      const args: WebFetchParams = {
        url: "https://example.com",
        prompt: "extract all headings",
      };
      const out = renderFetchCall(args, mockTheme, baseCtx);
      const plain = stripAnsi(getTextLines(out)[0]);
      expect(plain).toContain("· extract all headings");
    });
  });
});

describe("renderFetchCall — batch", () => {
  it("renders a multi-line top border as a sub-tree of URLs", () => {
    withStdoutColumns(120, () => {
      const args: WebFetchParams = {
        pages: [
          { url: "https://a.example.com/one" },
          { url: "https://b.example.com/two" },
          { url: "https://c.example.com/three" },
        ],
      };
      const out = renderFetchCall(args, mockTheme, baseCtx);
      const lines = getTextLines(out);
      expect(lines.length).toBe(4); // head + 3 URLs

      // Head row: top border with `╭── web_fetch 3 pages ───…`.
      const head = stripAnsi(lines[0]);
      expect(head).toMatch(/^╭── web_fetch 3 pages ─+$/);

      // Continuation rows: rail + sub-tree connector + URL; last row uses ╰.
      const c1 = stripAnsi(lines[1]);
      const c2 = stripAnsi(lines[2]);
      const c3 = stripAnsi(lines[3]);
      expect(c1).toMatch(/^│\s+│ /);
      expect(c2).toMatch(/^│\s+│ /);
      expect(c3).toMatch(/^│\s+╰ /);
      expect(c1).toContain("a.example.com");
      expect(c2).toContain("b.example.com");
      expect(c3).toContain("c.example.com");
    });
  });

  it("collapses overflow continuations into '+M more'", () => {
    withStdoutColumns(120, () => {
      const args: WebFetchParams = {
        pages: Array.from({ length: 8 }, (_, i) => ({
          url: `https://x${i}.example.com/`,
        })),
      };
      const out = renderFetchCall(args, mockTheme, baseCtx);
      const lines = getTextLines(out);
      // Head + 5 visible + 1 "+3 more" = 7 rows.
      expect(lines.length).toBe(7);
      const last = stripAnsi(lines[lines.length - 1]);
      expect(last).toContain("+3 more");
    });
  });
});

// ---------------------------------------------------------------------------
// renderFetchResult — pending
// ---------------------------------------------------------------------------

describe("renderFetchResult — pending batch", () => {
  it("`│ `-prefixes per-URL status lines + bottom-label with timer + done count", () => {
    withStdoutColumns(100, () => {
      const result = makeBatchResult([
        { url: "https://a.example.com", status: "fetching" },
        { url: "https://b.example.com", status: "done" },
        { url: "https://c.example.com", status: "error", error: "404" },
      ]);
      const out = renderFetchResult(
        result,
        pendingOptions,
        mockTheme,
        ctxWithState({ isPartial: true }),
      );
      const lines = getTextLines(out);
      expect(lines.length).toBe(4); // 3 status rows + bottom border

      for (let i = 0; i < 3; i += 1) {
        expect(stripAnsi(lines[i])).toMatch(/^│ /);
      }
      expect(stripAnsi(lines[0])).toContain("a.example.com");
      expect(stripAnsi(lines[1])).toContain("b.example.com");
      expect(stripAnsi(lines[2])).toContain("c.example.com");
      // Bottom-label: elapsed-time · done-count · failure-count.
      expect(stripAnsi(lines[3])).toMatch(
        /^╰── \d+\.\d+s · 1\/3 done · 1 failed ─+$/,
      );

      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(100);
      }
    });
  });

  it("draws a `Fetching…` body for single-URL pending state", () => {
    withStdoutColumns(80, () => {
      // No `pages` payload yet (heartbeat tick before any onUpdate).
      const result = {
        content: [{ type: "text", text: "" }],
        details: {},
      } as AgentToolResult<WebFetchToolDetails>;
      const out = renderFetchResult(
        result,
        pendingOptions,
        mockTheme,
        ctxWithState({ isPartial: true }),
      );
      const lines = getTextLines(out);
      expect(stripAnsi(lines[0])).toMatch(/^│ Fetching…/);
      expect(stripAnsi(lines[lines.length - 1])).toMatch(
        /^╰── \d+\.\d+s ─+$/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// renderFetchResult — error
// ---------------------------------------------------------------------------

describe("renderFetchResult — error", () => {
  it("renders the error message `│ `-prefixed + elapsed-time + `✗ error` tag", () => {
    withStdoutColumns(80, () => {
      const result = makeResult("Failed to fetch: timeout", { isError: true } as any);
      const out = renderFetchResult(
        result,
        collapsedOptions,
        mockTheme,
        ctxWithState(),
      );
      const lines = getTextLines(out);
      expect(stripAnsi(lines[0])).toMatch(/^│ Failed to fetch: timeout/);
      expect(stripAnsi(lines[lines.length - 1])).toMatch(
        /^╰── \d+\.\d+s · ✗ error ─+$/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// renderFetchResult — collapsed success
// ---------------------------------------------------------------------------

describe("renderFetchResult — collapsed success", () => {
  it("renders `│ `-prefixed preview + elapsed/lines/expand bottom-label border", () => {
    withStdoutColumns(100, () => {
      const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
        "\n",
      );
      const result = makeResult(body);
      const out = renderFetchResult(
        result,
        collapsedOptions,
        mockTheme,
        ctxWithState(),
      );
      const lines = getTextLines(out);

      // Body: first 5 preview lines, each `│ `-prefixed.
      for (let i = 0; i < 5; i += 1) {
        const body = stripAnsi(lines[i]);
        expect(body).toMatch(/^│ /);
        expect(body).toContain(`line ${i + 1}`);
      }

      // Last line: bottom-label with elapsed-time, line-count, expand hint.
      const bottom = stripAnsi(lines[lines.length - 1]);
      expect(bottom).toMatch(
        /^╰── \d+\.\d+s · 12 lines · ctrl\+o to expand ─+$/,
      );
      expect(visibleWidth(lines[lines.length - 1])).toBe(100);
    });
  });
});

// ---------------------------------------------------------------------------
// renderFetchResult — expanded success
// ---------------------------------------------------------------------------

describe("renderFetchResult — expanded success", () => {
  it("rail-prefixes the markdown body + bottom-label with elapsed/line count", () => {
    withStdoutColumns(100, () => {
      const result = makeResult("# heading\n\nbody body body\n\n- item one\n- item two");
      const out: any = renderFetchResult(
        result,
        expandedOptions,
        mockTheme,
        ctxWithState(),
      );
      const lines = getTextLines(out);

      const plain = lines.map(stripAnsi);
      expect(plain.length).toBeGreaterThan(1);
      for (let i = 0; i < plain.length - 1; i += 1) {
        expect(plain[i].startsWith("│ ")).toBe(true);
      }
      const body = plain.slice(0, -1).join("\n");
      expect(body).toContain("heading");
      expect(body).toContain("body body body");
      expect(body).toContain("item one");
      expect(body).toContain("item two");
      // Bottom-label: elapsed-time · line-count.
      expect(plain[plain.length - 1]).toMatch(
        /^╰── \d+\.\d+s · \d+ lines? ─+$/,
      );
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(100);
      }
    });
  });
});
