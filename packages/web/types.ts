/**
 * Shared types for @wierdbytes/pi-web.
 *
 * Defines the parsed shapes returned by search.ts plus a tiny subset of
 * Anthropic's raw content-block schema that we actually demux.
 */

export interface AnthropicAuth {
  apiKey: string;
  isOAuth: boolean;
  baseUrl: string;
}

export interface SearchSource {
  title: string;
  url: string;
  pageAge?: string;
  ageSeconds?: number;
}

export interface Citation {
  url: string;
  title?: string;
  citedText?: string;
  startCharIndex?: number;
  endCharIndex?: number;
}

export interface SearchResponse {
  answer?: string;
  sources: SearchSource[];
  citations?: Citation[];
  searchQueries?: string[];
  model: string;
  requestId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    searchRequests?: number;
  };
}

export class AnthropicWebError extends Error {
  status: number;
  phase: "search";

  constructor(status: number, phase: "search", message: string) {
    super(message);
    this.name = "AnthropicWebError";
    this.status = status;
    this.phase = phase;
  }
}

// ---------------------------------------------------------------------------
// Raw API shapes (only what we read)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  citations?: Array<{
    type?: string;
    url: string;
    title?: string;
    cited_text?: string;
    start_char_index?: number;
    end_char_index?: number;
  }>;
}

export interface AnthropicServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

export interface AnthropicWebSearchResultEntry {
  type: "web_search_result";
  url: string;
  title: string;
  page_age?: string | null;
}

export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  content?: AnthropicWebSearchResultEntry[] | { type: "web_search_tool_result_error"; error_code: string };
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock
  | { type: string;[key: string]: unknown };

export interface AnthropicMessageResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    server_tool_use?: {
      web_search_requests?: number | null;
    } | null;
  };
}
