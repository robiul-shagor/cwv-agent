import type { z } from 'zod';
import type { Logger } from '../lib/logger.js';
import type { CodeSource } from '../source/types.js';
import { normalizeUrl } from '../lib/url.js';

export interface ToolContext {
  googleApiKey?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  logger: Logger;
  /** Per-run memo so repeated identical calls (e.g. PSI) don't hit the API twice. */
  cache: Map<string, unknown>;
  /** Read-only project source code, when the user linked a folder or repository. */
  source?: CodeSource;
  /** Chrome executable for browser tools (default: installed Google Chrome). */
  chromePath?: string;
  /** Directory holding collected RUM beacons (`get_rum`). */
  rumDataDir?: string;
}

export interface Tool<I = unknown> {
  name: string;
  /** Written for the LLM: when to use it and what it returns. */
  description: string;
  inputSchema: z.ZodType<I>;
  /** Must return a compact, LLM-friendly summary — never a raw API response. */
  execute(input: I, ctx: ToolContext): Promise<unknown>;
}

/** Thrown for expected failures the LLM should see and can react to (bad input, no data, quota). */
export class ToolError extends Error {
  override name = 'ToolError';
}

/**
 * Per-run memo keyed by the call's identity. Stores the in-flight promise, so a prefetched call and the agent's
 * identical call share one request. Failures are forgotten (a later call retries) unless `cacheErrors` is set.
 */
export function memo<T>(
  ctx: ToolContext,
  key: string,
  fn: () => Promise<T>,
  opts: { cacheErrors?: boolean } = {},
): Promise<T> {
  const hit = ctx.cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = fn();
  ctx.cache.set(key, p);
  if (!opts.cacheErrors) p.catch(() => ctx.cache.delete(key));
  return p;
}

/** Canonical URL for memo keys (`https://a.com` and `https://a.com/` are the same call). */
export function urlKey(url: string): string {
  try {
    return normalizeUrl(url).toString();
  } catch {
    return url;
  }
}
