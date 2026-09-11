import { describe, it, expect } from "vitest";
import {
  formatBatchResults,
  MAX_BATCH_SIZE,
  resolveFetchPages,
  runProcess,
} from "./fetch.ts";

// --- helpers ---

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

function fulfilled(value: any): PromiseSettledResult<any> {
  return { status: "fulfilled", value };
}

function rejected(reason: any): PromiseSettledResult<any> {
  return { status: "rejected", reason };
}

function okResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

// --- MAX_BATCH_SIZE ---

describe("MAX_BATCH_SIZE", () => {
  it("is 10", () => {
    expect(MAX_BATCH_SIZE).toBe(10);
  });
});

// --- resolveFetchPages ---

describe("resolveFetchPages", () => {
  it("wraps a single url into one page request", () => {
    const r = resolveFetchPages({ url: "https://a.com", prompt: "title" });
    expect(r).toEqual({
      ok: true,
      pages: [{ url: "https://a.com", prompt: "title", summarize: undefined }],
    });
  });

  it("carries summarize=false through for a single url", () => {
    const r = resolveFetchPages({ url: "https://a.com", summarize: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pages[0].summarize).toBe(false);
  });

  it("passes the pages array through untouched", () => {
    const pages = [
      { url: "https://a.com" },
      { url: "https://b.com", prompt: "x" },
      { url: "https://c.com", summarize: false },
    ];
    const r = resolveFetchPages({ pages });
    expect(r).toEqual({ ok: true, pages });
  });

  it("rejects url + pages together", () => {
    const r = resolveFetchPages({ url: "https://a.com", pages: [{ url: "https://b.com" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("mutually exclusive");
  });

  it("rejects neither url nor pages", () => {
    const r = resolveFetchPages({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Either 'url' or 'pages'");
  });

  it("rejects an empty pages array", () => {
    const r = resolveFetchPages({ pages: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("at least one entry");
  });

  it("rejects more than MAX_BATCH_SIZE pages", () => {
    const pages = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
      url: `https://p${i}.com`,
    }));
    const r = resolveFetchPages({ pages });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("maximum batch size");
  });

  it("rejects summarize=false combined with prompt (single url)", () => {
    const r = resolveFetchPages({ url: "https://a.com", prompt: "x", summarize: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("'summarize: false' cannot be combined with 'prompt'");
      // single-url form doesn't need to name the offending URL
      expect(r.error).not.toContain("https://a.com");
    }
  });

  it("rejects summarize=false combined with prompt in batch and names the URLs", () => {
    const r = resolveFetchPages({
      pages: [
        { url: "https://ok.com", summarize: false },
        { url: "https://bad.com", prompt: "x", summarize: false },
        { url: "https://also-bad.com", prompt: "y", summarize: false },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("https://bad.com");
      expect(r.error).toContain("https://also-bad.com");
      expect(r.error).not.toContain("https://ok.com");
    }
  });

  it("allows summarize=true together with prompt", () => {
    const r = resolveFetchPages({ url: "https://a.com", prompt: "x", summarize: true });
    expect(r.ok).toBe(true);
  });
});

// --- runProcess (paths that never reach the sub-agent) ---

describe("runProcess", () => {
  const small = "# Hello\n\nshort page";
  // > CONTENT_SIZE_THRESHOLD (50_000 chars) and > DEFAULT_MAX_BYTES (50KB)
  const large = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");

  it("returns small content raw regardless of summarize flag", async () => {
    const a = await runProcess(small, {}, "provider/model", "off");
    const b = await runProcess(small, { summarize: false }, "provider/model", "off");
    expect(getText(a as any)).toBe(small);
    expect(getText(b as any)).toBe(small);
  });

  it("returns truncated raw for large content when summarize=false, without calling the LLM", async () => {
    const updates: string[] = [];
    const r = await runProcess(large, { summarize: false }, "provider/model", "off", undefined, (p) => {
      const c = p.content?.[0];
      if (c?.type === "text") updates.push(c.text);
    });
    const text = getText(r as any);
    expect(r.isError).toBeUndefined();
    expect(text.startsWith("line 0 ")).toBe(true);
    expect(text).toContain("[Output truncated:");
    expect(text).not.toContain("Could not generate summary");
    // no "generating summary" progress update was emitted
    expect(updates.some((u) => u.includes("summary"))).toBe(false);
  });

  it("returns truncated raw for large content when no model is available", async () => {
    const r = await runProcess(large, {}, undefined, "off");
    const text = getText(r as any);
    expect(text.startsWith("line 0 ")).toBe(true);
    expect(text).toContain("[Output truncated:");
  });
});

// --- formatBatchResults ---

describe("formatBatchResults", () => {
  describe("all pages succeed", () => {
    it("returns inner result directly for single page", () => {
      const pages = [{ url: "https://example.com" }];
      const results = [fulfilled(okResult("Hello world"))];

      const result = formatBatchResults(pages, results);
      const text = getText(result);

      expect(text).toBe("Hello world");
    });

    it("formats multiple page results with correct indexing", () => {
      const pages = [
        { url: "https://a.com" },
        { url: "https://b.com" },
        { url: "https://c.com" },
      ];
      const results = [
        fulfilled(okResult("Content A")),
        fulfilled(okResult("Content B")),
        fulfilled(okResult("Content C")),
      ];

      const result = formatBatchResults(pages, results);
      const text = getText(result);

      expect(text).toContain("--- [1/3] https://a.com ---");
      expect(text).toContain("Content A");
      expect(text).toContain("--- [2/3] https://b.com ---");
      expect(text).toContain("Content B");
      expect(text).toContain("--- [3/3] https://c.com ---");
      expect(text).toContain("Content C");
    });

    it("preserves request order regardless of result content", () => {
      const pages = [
        { url: "https://first.com" },
        { url: "https://second.com" },
      ];
      const results = [
        fulfilled(okResult("First content")),
        fulfilled(okResult("Second content")),
      ];

      const result = formatBatchResults(pages, results);
      const text = getText(result);

      const firstIdx = text.indexOf("--- [1/2] https://first.com ---");
      const secondIdx = text.indexOf("--- [2/2] https://second.com ---");
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    it("returns a single content block", () => {
      const pages = [{ url: "https://a.com" }, { url: "https://b.com" }];
      const results = [fulfilled(okResult("A")), fulfilled(okResult("B"))];

      const result = formatBatchResults(pages, results);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
    });
  });

  describe("mixed success and failure", () => {
    it("includes error messages inline for failed pages", () => {
      const pages = [
        { url: "https://good.com" },
        { url: "https://bad.com" },
        { url: "https://also-good.com" },
      ];
      const results = [
        fulfilled(okResult("Good content")),
        fulfilled(errorResult("Page load timed out")),
        fulfilled(okResult("Also good content")),
      ];

      const result = formatBatchResults(pages, results);
      const text = getText(result);

      expect(text).toContain("--- [1/3] https://good.com ---");
      expect(text).toContain("Good content");
      expect(text).toContain("--- [2/3] https://bad.com ---");
      expect(text).toContain("Error: Page load timed out");
      expect(text).toContain("--- [3/3] https://also-good.com ---");
      expect(text).toContain("Also good content");
    });

    it("handles rejected promises (unexpected errors)", () => {
      const pages = [
        { url: "https://good.com" },
        { url: "https://crash.com" },
      ];
      const results = [
        fulfilled(okResult("Works fine")),
        rejected(new Error("Unexpected crash")),
      ];

      const result = formatBatchResults(pages, results);
      const text = getText(result);

      expect(text).toContain("Works fine");
      expect(text).toContain("Error: Unexpected crash");
    });

    it("returns error result directly for single rejected page", () => {
      const pages = [{ url: "https://crash.com" }];
      const results = [rejected("some string error")];

      const result = formatBatchResults(pages, results);
      const text = getText(result);

      expect(text).toContain("Error: some string error");
      expect(result.isError).toBe(true);
    });
  });

  describe("result ordering", () => {
    it("always returns results in original request order", () => {
      const pages = [
        { url: "https://slow.com" },
        { url: "https://fast.com" },
        { url: "https://medium.com" },
      ];
      const results = [
        fulfilled(okResult("Slow content")),
        fulfilled(okResult("Fast content")),
        fulfilled(okResult("Medium content")),
      ];

      const result = formatBatchResults(pages, results);
      const text = getText(result);

      const lines = text.split("\n");
      const headers = lines.filter((l) => l.startsWith("--- ["));

      expect(headers[0]).toBe("--- [1/3] https://slow.com ---");
      expect(headers[1]).toBe("--- [2/3] https://fast.com ---");
      expect(headers[2]).toBe("--- [3/3] https://medium.com ---");
    });
  });

  describe("edge cases", () => {
    it("handles empty content in single-page result", () => {
      const pages = [{ url: "https://empty.com" }];
      const results = [fulfilled({ content: [{ type: "text", text: "" }] })];

      const result = formatBatchResults(pages, results);
      expect(result.content[0].text).toBe("");
    });

    it("handles missing content array in single-page result", () => {
      const pages = [{ url: "https://broken.com" }];
      const results = [fulfilled({ content: [] })];

      const result = formatBatchResults(pages, results);
      expect(result.content).toHaveLength(0);
    });

    it("returns content directly for single page with prompt", () => {
      const pages = [{ url: "https://example.com", prompt: "Get the title" }];
      const results = [fulfilled(okResult("Title: Example"))];

      const result = formatBatchResults(pages, results);
      const text = getText(result);

      expect(text).toBe("Title: Example");
    });
  });
});
