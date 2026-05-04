const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING_HEADER_LINE =
  "x-anthropic-billing-header: cc_version=2.1.126.d1a; cc_entrypoint=cli; cch=7e48f;";
const BILLING_HEADER_MARKER = "x-anthropic-billing-header";
const PI_REMOVAL_ANCHORS = [
  "pi-coding-agent",
  "@mariozechner/pi-coding-agent",
  "badlogic/pi-mono",
] as const;

type MessageContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

export function buildAnthropicSystemPrompt(
  systemPrompt: string | undefined,
  isOAuth: boolean,
): MessageContentBlock[] | undefined {
  const blocks: MessageContentBlock[] = [];

  const sanitized = systemPrompt ? sanitizeSystemText(systemPrompt) : "";
  const alreadyHasBilling = sanitized.includes(BILLING_HEADER_MARKER);

  // Billing header must be the first line of the system prompt.
  if (!alreadyHasBilling) {
    blocks.push({
      type: "text",
      text: BILLING_HEADER_LINE,
      cache_control: { type: "ephemeral" },
    });
  }

  if (isOAuth) {
    blocks.push({
      type: "text",
      text: CLAUDE_CODE_IDENTITY,
      cache_control: { type: "ephemeral" },
    });
  }

  if (sanitized) {
    blocks.push({
      type: "text",
      text: sanitized,
      cache_control: { type: "ephemeral" },
    });
  }

  return blocks.length > 0 ? blocks : undefined;
}

function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    const lower = paragraph.toLowerCase();
    if (lower.includes("you are pi")) return false;
    return !PI_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor));
  });

  return filtered
    .join("\n\n")
    .replace(/\bpi\b/g, "Claude Code")
    .replace(/\bPi\b/g, "Claude Code")
    .trim();
}
