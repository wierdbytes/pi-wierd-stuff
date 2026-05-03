/**
 * Internal types for the web_fetch tool.
 */

export type BatchPageStatus =
  | "pending"
  | "fetching"
  | "extracting"
  | "summarizing"
  | "done"
  | "error";

export interface BatchPageState {
  url: string;
  status: BatchPageStatus;
  error?: string;
}

export interface BatchDetails {
  pages: BatchPageState[];
}

export interface FetchPageResult {
  html: string;
  finalUrl: string;
}

export interface FetchRedirectResult {
  redirectedTo: string;
}

export interface WebFetchToolDetails {
  /** Per-URL status, populated during partial updates and on completion. */
  pages?: BatchPageState[];
}
