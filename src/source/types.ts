export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  /** Treat the query as a regular expression (default: literal text). */
  regex?: boolean;
  caseSensitive?: boolean;
  /** Only search under this directory (relative to the source root). */
  path?: string;
  /** Glob filter, e.g. "*.tsx" or "**\/components/**". */
  glob?: string;
  maxResults?: number;
}

export interface FileSlice {
  file: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}

/** Read-only access to a project's source code. */
export interface CodeSource {
  /** Human-readable description (path or repo@ref). */
  readonly label: string;
  listFiles(dir?: string, glob?: string, limit?: number): Promise<{ files: string[]; truncated: boolean }>;
  search(query: string, opts?: SearchOptions): Promise<{ matches: SearchMatch[]; truncated: boolean }>;
  readFile(file: string, startLine?: number, endLine?: number): Promise<FileSlice>;
  /** True if the (relative) file exists and is readable. */
  exists(file: string): Promise<boolean>;
  /** Whole file as text (for build artifacts like source maps); null if missing, sensitive or larger than maxBytes. */
  readText(file: string, maxBytes: number): Promise<string | null>;
}

export interface SourceInfo {
  kind: 'local' | 'github';
  label: string;
  /** Local folder the agent reads from (a temp clone for GitHub). */
  root: string;
  repo?: string;
  ref?: string;
  commit?: string;
  branch?: string;
  /** Uncommitted changes in a local git checkout. */
  dirtyFiles?: number;
}

export class SourceError extends Error {
  override name = 'SourceError';
}
