/**
 * Claude Code release we impersonate for Pro/Max OAuth traffic.
 *
 * Anthropic gates newer models on this version — the API reads it from the
 * `x-anthropic-billing-header` system block (see prompt.ts) and rejects
 * requests with `claude_code_version_too_old`. When that happens, bump this
 * to the latest published `@anthropic-ai/claude-code` version:
 *
 *   npm view @anthropic-ai/claude-code version
 */
export const CLAUDE_CODE_VERSION = "2.1.281";

/**
 * Billing header line as emitted by the real CLI (verified against 2.1.278):
 *   cc_version=<version>.<3 hex chars>; cc_entrypoint=cli; cch=00000;
 * The 3-char suffix is a salted hash of the first user message; the API
 * doesn't validate it, so a fixed value is fine.
 */
export const BILLING_HEADER_LINE =
  `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.d1a; cc_entrypoint=cli; cch=00000;`;
