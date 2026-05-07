const BILLING_HEADER_LINE =
  "x-anthropic-billing-header: cc_version=2.1.126.d1a; cc_entrypoint=cli; cch=7e48f;";
const BILLING_HEADER_MARKER = "x-anthropic-billing-header";

const PI_REMOVAL_ANCHORS = [
  // "pi-coding-agent",
  // "@mariozechner/pi-coding-agent",
  // "badlogic/pi-mono",
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI)",
] as const;

type SystemBlock = { type: string; text?: string; [key: string]: unknown };

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

/**
 * Rewrite system prompt text for Claude-Code mimicry and ensure the billing
 * header is the first system block.
 *
 * pi-ai's built-in OAuth path already prepends the
 *   "You are Claude Code, Anthropic's official CLI for Claude."
 * identity block, so we only:
 *   1. Strip / rewrite Pi-branded paragraphs in remaining system blocks.
 *   2. Prepend the x-anthropic-billing-header line if it isn't already there.
 */
export function sanitizeSystemBlocksForClaudeCode(
  blocks: SystemBlock[],
): SystemBlock[] {
  const rewritten = blocks.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    return { ...block, text: sanitizeSystemText(block.text) };
  });

  const alreadyHasBilling = rewritten.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.includes(BILLING_HEADER_MARKER),
  );

  if (!alreadyHasBilling) {
    // Intentionally no `cache_control` here. Anthropic caps a request at 4
    // cache_control blocks total, and pi-ai already adds 4 (two system
    // blocks + last user message + last tool). The billing header is one
    // short line, so omitting its breakpoint costs nothing — the next
    // breakpoint on the identity block still covers it.
    rewritten.unshift({
      type: "text",
      text: BILLING_HEADER_LINE,
    });
  }

  return rewritten;
}

function sanitizeSystemText(text: string): string {
  const sanitized = sanitizeSurrogates(text);
  const paragraphs = sanitized.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    const lower = paragraph.toLowerCase();
    if (lower.includes("you are pi")) return false;
    return !PI_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor));
  });

  return filtered
    .join("\n\n")
    .trim();
}
