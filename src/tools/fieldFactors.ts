import { z } from 'zod';
import { normalizeUrl } from '../lib/url.js';
import { timeRequest, type RequestTiming } from '../lib/timing.js';
import { fetchFailure, fetchPage, USER_AGENTS, type FetchedPage } from './fetchHtml.js';
import { memo, type Tool, urlKey } from './types.js';

const Input = z.object({
  url: z.string().min(1).describe('Absolute URL of the page'),
  device: z.enum(['mobile', 'desktop']).default('mobile').describe('User-Agent to send'),
});

/** Typical ad/email click parameters. Unique values defeat any cache entry keyed on them. */
export function withMarketingParams(rawUrl: string, nonce: string): string {
  const url = normalizeUrl(rawUrl);
  url.searchParams.set('utm_source', 'cwv-agent');
  url.searchParams.set('utm_medium', 'cpc');
  url.searchParams.set('gclid', `cwvagent${nonce}`);
  return url.toString();
}

type CacheState = 'hit' | 'miss' | 'unknown';

export function cacheState(headers: Record<string, string>): CacheState {
  const v =
    headers['cf-cache-status'] ??
    headers['x-vercel-cache'] ??
    headers['x-nextjs-cache'] ??
    headers['x-cache'];
  if (v) {
    if (/hit|stale|revalidated|updating|prerender/i.test(v)) return 'hit';
    if (/miss|expired|dynamic|bypass|pass|error/i.test(v)) return 'miss';
  }
  if (Number(headers.age) > 0) return 'hit';
  return 'unknown';
}

const UNLOAD_RE =
  /addEventListener\(\s*['"`]unload['"`]|\bonunload\s*=|\$\(\s*window\s*\)\.(?:on|bind)\(\s*['"`]unload/;

/** Pure analysis of three requests: first, repeat (warm cache) and repeat with marketing params. */
export interface PageSample {
  path: string;
  first: { cache: CacheState; ttfbMs: number };
  repeat: { cache: CacheState; ttfbMs: number };
}

/** Same-site page links worth sampling (other templates), excluding assets, accounts and carts. */
export function samePageLinks(html: string, pageUrl: string, max = 4): string[] {
  const base = new URL(pageUrl);
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(m[1]!, base);
    } catch {
      continue;
    }
    if (u.origin !== base.origin || u.pathname === base.pathname) continue;
    if (/\.(jpe?g|png|gif|webp|avif|svg|pdf|zip|xml|json|css|js)$/i.test(u.pathname)) continue;
    if (/login|logout|account|cart|checkout|wp-admin|wp-login|feed|tag\/|author\//i.test(u.pathname))
      continue;
    // One URL per first path segment ≈ one per template (blog/, product/, category/…).
    const key = u.pathname.split('/')[1] ?? '';
    if (!out.has(key)) out.set(key, u.origin + u.pathname);
    if (out.size >= max) break;
  }
  return [...out.values()];
}

export function analyzeFieldFactors(
  first: FetchedPage,
  repeat: FetchedPage,
  tagged: FetchedPage,
  extra: { timing?: RequestTiming; pages?: PageSample[] } = {},
) {
  const signals: string[] = [];
  const cacheControl = repeat.headers['cache-control'];
  const states = {
    first: cacheState(first.headers),
    repeat: cacheState(repeat.headers),
    tagged: cacheState(tagged.headers),
  };
  const ttfb = { first: first.ttfbMs, repeat: repeat.ttfbMs, withMarketingParams: tagged.ttfbMs };

  let htmlCacheVerdict: string;
  if (states.repeat === 'hit' && states.tagged === 'miss') {
    htmlCacheVerdict = 'marketing-params-bypass-cache';
    signals.push(
      `HTML is edge-cached, but URLs with utm_/gclid parameters MISS the cache (TTFB ${ttfb.repeat}ms → ${ttfb.withMarketingParams}ms). ` +
        'Ad and email visitors get slow TTFB/LCP; strip these params from the CDN cache key.',
    );
  } else if (states.repeat === 'miss') {
    htmlCacheVerdict = 'not-edge-cached';
    signals.push(
      'HTML is not served from the CDN cache even on a repeat request: every real visit pays full origin TTFB.',
    );
  } else if (states.repeat === 'hit' && states.tagged === 'hit') {
    htmlCacheVerdict = 'cached-including-marketing-params';
  } else if (ttfb.withMarketingParams > ttfb.repeat * 1.5 && ttfb.withMarketingParams - ttfb.repeat > 300) {
    htmlCacheVerdict = 'likely-marketing-params-bypass-cache';
    signals.push(
      `No cache-status header, but TTFB with utm_/gclid params is much slower (${ttfb.repeat}ms → ${ttfb.withMarketingParams}ms): ` +
        'the cache key likely includes query params.',
    );
  } else {
    htmlCacheVerdict = 'unknown';
  }
  if (
    /no-store|private/i.test(cacheControl ?? '') &&
    htmlCacheVerdict !== 'cached-including-marketing-params'
  ) {
    signals.push(
      `Document Cache-Control is "${cacheControl}", which prevents shared/edge caching of the HTML.`,
    );
  }
  if (/user-agent|cookie/i.test(repeat.headers.vary ?? '')) {
    signals.push(`Vary: ${repeat.headers.vary} fragments the HTML cache (lower hit rate for real users).`);
  }
  if (first.redirects.length) {
    signals.push(
      `Redirect chain before the document (${first.redirects.join(' → ')}): adds a full round trip to TTFB.`,
    );
  }

  const bfcacheBlockers: string[] = [];
  if (/no-store/i.test(cacheControl ?? ''))
    bfcacheBlockers.push(
      'Cache-Control: no-store on the HTML document (blocks bfcache in most Chrome versions)',
    );
  if (UNLOAD_RE.test(repeat.html))
    bfcacheBlockers.push('unload event handler in the page HTML (always blocks bfcache)');
  if (bfcacheBlockers.length) {
    signals.push(
      `Back/forward cache blocked: ${bfcacheBlockers.join('; ')}. Back/forward visits then reload fully instead of ` +
        'restoring instantly (near-0 LCP, 0 CLS in CrUX).',
    );
  }

  // Network vs server: where a cold visitor's TTFB goes.
  const t = extra.timing;
  if (t) {
    const network = t.dnsMs + t.connectMs + t.tlsMs;
    if (network > t.serverWaitMs && network > 300)
      signals.push(
        `Cold-connection TTFB ${t.ttfbMs}ms is mostly network setup (DNS ${t.dnsMs} + TCP ${t.connectMs} + TLS ${t.tlsMs}ms) from the agent's location — if CrUX RTT is also high, ` +
          'enable HTTP/3 + TLS 1.3 / 0-RTT, a CDN edge close to users, and avoid extra origins (redirect domains).',
      );
    else if (t.serverWaitMs > 600)
      signals.push(
        `Server wait ${t.serverWaitMs}ms after the connection is up (${t.serverTiming ? `Server-Timing: ${t.serverTiming}` : 'no Server-Timing header'}): ` +
          'the edge/origin is slow to start responding — cache HTML at the edge or speed up the backend.',
      );
  }

  // Other templates: CrUX TTFB is site-wide, and long-tail pages are often not in the edge cache.
  const pages = extra.pages ?? [];
  const coldMiss = pages.filter((p) => p.first.cache === 'miss');
  const neverCached = pages.filter((p) => p.repeat.cache === 'miss');
  const coldOnly = coldMiss.filter((p) => p.repeat.cache === 'hit');
  if (neverCached.length)
    signals.push(
      `${neverCached.length}/${pages.length} other pages are never served from the edge cache (${neverCached.map((p) => p.path).join(', ')}): ` +
        'their visitors always pay origin TTFB.',
    );
  if (coldOnly.length)
    signals.push(
      `${coldOnly.length}/${pages.length} other pages missed the edge cache on first request and hit only on repeat ` +
        `(${coldOnly.map((p) => `${p.path} ${p.first.ttfbMs}→${p.repeat.ttfbMs}ms`).join(', ')}): less-visited pages are cold ` +
        'for real users. Raise HTML TTL with stale-while-revalidate, enable tiered caching / Cache Reserve, or prewarm.',
    );

  const speculationRules =
    /<script[^>]+type\s*=\s*["']?speculationrules/i.test(repeat.html) ||
    !!repeat.headers['speculation-rules'];

  return {
    source:
      'Direct HTTP requests from the agent host (first, repeat, with utm_/gclid params, a fresh-connection timing, other templates); timings indicative',
    finalUrl: repeat.finalUrl,
    status: repeat.status,
    htmlCaching: {
      cacheControl,
      cdnCacheStatus: states,
      ttfbMs: ttfb,
      verdict: htmlCacheVerdict,
    },
    bfcache: {
      blockersFound: bfcacheBlockers,
      note:
        'Only the document headers and HTML are checked; unload handlers in external scripts, open connections ' +
        '(WebSocket/BroadcastChannel) or Cache-Control on other responses are not. Confirm with CrUX navigationTypes.back_forward ' +
        'and Chrome DevTools > Application > Back/forward cache.',
    },
    speculationRules: {
      present: speculationRules,
      note: speculationRules
        ? 'Speculation rules found: prerendered navigations count as near-instant LCP in CrUX.'
        : 'No speculation rules: prerendering likely next pages (moderate eagerness) can cut field LCP for multi-page visits.',
    },
    network: t
      ? {
          coldConnection: t,
          note: "One fresh connection from the agent host (its location, not your users'): split shows network vs server share.",
        }
      : undefined,
    otherPages: pages.length
      ? {
          sampled: pages,
          coldMissRate: `${coldMiss.length}/${pages.length}`,
          neverCached: `${neverCached.length}/${pages.length}`,
        }
      : undefined,
    signals,
  };
}

export const checkFieldFactors: Tool<z.infer<typeof Input>> = {
  name: 'check_field_factors',
  description:
    'Check real-user conditions that PageSpeed lab tests miss but move CrUX: whether the HTML is edge-cached, whether URLs ' +
    'with ad/email params (utm_*, gclid) bypass the cache (slow TTFB/LCP for paid traffic), Vary/redirect issues, ' +
    'back/forward-cache blockers (no-store, unload handlers), speculation rules (prerender), a cold-connection TTFB split ' +
    '(DNS / TCP / TLS / server wait) and edge-cache status of up to 4 other templates (CrUX TTFB is site-wide). Use it whenever the CrUX ' +
    'assessment fails but the lab looks fine, when field TTFB/LCP is poor, or when navigationTypes.back_forward is low.',
  inputSchema: Input,
  async execute(input, ctx) {
    return memo(ctx, `field:${input.device}:${urlKey(input.url)}`, async () => {
      try {
        const first = await fetchPage(input.url, input.device, ctx);
        const repeat = await fetchPage(input.url, input.device, ctx);
        const tagged = await fetchPage(
          withMarketingParams(repeat.finalUrl, Date.now().toString(36)),
          input.device,
          ctx,
        );
        const timing = await timeRequest(
          repeat.finalUrl,
          USER_AGENTS[input.device],
          Math.min(ctx.timeoutMs, 20_000),
        ).catch(() => undefined);
        const pages: PageSample[] = [];
        for (const link of samePageLinks(first.html, repeat.finalUrl)) {
          try {
            const a = await fetchPage(link, input.device, ctx);
            const b = await fetchPage(link, input.device, ctx);
            pages.push({
              path: new URL(link).pathname,
              first: { cache: cacheState(a.headers), ttfbMs: a.ttfbMs },
              repeat: { cache: cacheState(b.headers), ttfbMs: b.ttfbMs },
            });
          } catch {
            // skip pages that fail; the main page result still stands
          }
        }
        return analyzeFieldFactors(first, repeat, tagged, { timing, pages });
      } catch (err) {
        fetchFailure(err);
      }
    });
  },
};
