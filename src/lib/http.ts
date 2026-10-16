import { redact } from './logger.js';

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export interface RetryOptions {
  /** Total attempts, including the first one. */
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Overrides the default retry decision. */
  shouldRetry?: (err: unknown) => boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    // A daily quota will not recover within a retry window.
    if (err.status === 429 && /per day/i.test(err.body)) return false;
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error) {
    // Network failures / per-attempt timeouts.
    return err.name === 'TimeoutError' || err.name === 'TypeError' || 'code' in err;
  }
  return false;
}

/** Runs `fn` with exponential backoff + jitter on transient failures. */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const shouldRetry = opts.shouldRetry ?? isRetryable;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const signals = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter(
      (s): s is AbortSignal => !!s,
    );
    try {
      return await fn(AbortSignal.any(signals));
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted || i === attempts - 1 || !shouldRetry(err)) break;
      await sleep(base * 2 ** i + Math.random() * base, opts.signal);
    }
  }
  throw lastErr;
}

/** GET/POST JSON with timeout + retry. Error messages are redacted (API keys live in query strings). */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<T> {
  return withRetry(async (signal) => {
    const res = await fetch(url, { ...init, signal });
    const text = await res.text();
    if (!res.ok) {
      const safeUrl = redact(url.split('?')[0] ?? url);
      throw new HttpError(
        `HTTP ${res.status} from ${safeUrl}: ${extractMessage(text)}`,
        res.status,
        redact(text),
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(
        `Invalid JSON from ${redact(url.split('?')[0] ?? url)}`,
        res.status,
        text.slice(0, 500),
      );
    }
  }, opts);
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (msg) return redact(msg).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return redact(body).slice(0, 300);
}
