import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchedPage } from '../src/tools/fetchHtml.js';
import {
  analyzeFieldFactors,
  cacheState,
  checkFieldFactors,
  samePageLinks,
  withMarketingParams,
} from '../src/tools/fieldFactors.js';
import type * as UrlModule from '../src/lib/url.js';
import { ctx } from './helpers.js';

// No real network in tests: the fresh-connection timing request is stubbed.
vi.mock('../src/lib/timing.js', () => ({
  timeRequest: vi.fn().mockResolvedValue({
    status: 200,
    dnsMs: 20,
    connectMs: 150,
    tlsMs: 170,
    serverWaitMs: 90,
    ttfbMs: 430,
  }),
}));

// Skip DNS resolution in the SSRF guard (covered in fetchHtml tests).
vi.mock('../src/lib/url.js', async (orig) => ({
  ...(await orig<typeof UrlModule>()),
  assertPublicUrl: vi.fn(),
}));

const page = (over: Partial<FetchedPage> = {}): FetchedPage => ({
  finalUrl: 'https://example.com/',
  status: 200,
  redirects: [],
  headers: {},
  ttfbMs: 100,
  totalMs: 150,
  bytes: 10,
  truncated: false,
  html: '<html><body></body></html>',
  ...over,
});

describe('check_field_factors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds marketing params to the URL', () => {
    const u = new URL(withMarketingParams('https://example.com/a?x=1', 'n1'));
    expect(u.searchParams.get('x')).toBe('1');
    expect(u.searchParams.get('utm_source')).toBe('cwv-agent');
    expect(u.searchParams.get('gclid')).toBe('cwvagentn1');
  });

  it('reads CDN cache status headers', () => {
    expect(cacheState({ 'cf-cache-status': 'HIT' })).toBe('hit');
    expect(cacheState({ 'cf-cache-status': 'DYNAMIC' })).toBe('miss');
    expect(cacheState({ 'x-cache': 'Miss from cloudfront' })).toBe('miss');
    expect(cacheState({ age: '120' })).toBe('hit');
    expect(cacheState({})).toBe('unknown');
  });

  it('flags marketing params bypassing the cache', () => {
    const r = analyzeFieldFactors(
      page({ headers: { 'cf-cache-status': 'MISS' }, ttfbMs: 900 }),
      page({ headers: { 'cf-cache-status': 'HIT' }, ttfbMs: 80 }),
      page({ headers: { 'cf-cache-status': 'MISS' }, ttfbMs: 950 }),
    );
    expect(r.htmlCaching.verdict).toBe('marketing-params-bypass-cache');
    expect(r.signals[0]).toContain('80ms → 950ms');
  });

  it('flags bfcache blockers, uncached HTML and redirects', () => {
    const blocked = page({
      headers: { 'cache-control': 'no-store, private', 'cf-cache-status': 'DYNAMIC', vary: 'Cookie' },
      html: '<script>window.addEventListener("unload", () => {})</script>',
    });
    const r = analyzeFieldFactors(page({ redirects: ['301 http://example.com/'] }), blocked, blocked);
    expect(r.htmlCaching.verdict).toBe('not-edge-cached');
    expect(r.bfcache.blockersFound).toHaveLength(2);
    expect(r.speculationRules.present).toBe(false);
    expect(r.signals.join('\n')).toMatch(
      /Vary: Cookie[\s\S]*Redirect chain[\s\S]*Back\/forward cache blocked/,
    );
  });

  it('detects speculation rules and a healthy cache', () => {
    const ok = page({
      headers: { 'cf-cache-status': 'HIT', 'cache-control': 'public, max-age=60' },
      html: '<script type="speculationrules">{"prerender":[]}</script>',
    });
    const r = analyzeFieldFactors(ok, ok, ok);
    expect(r.htmlCaching.verdict).toBe('cached-including-marketing-params');
    expect(r.speculationRules.present).toBe(true);
    expect(r.signals).toEqual([]);
  });

  it('picks one same-site link per template, skipping assets and account pages', () => {
    const html = `<a href="/blog/a">a</a><a href="/blog/b">b</a><a href="https://example.com/product/x">x</a>
      <a href="/cart">cart</a><a href="/img/x.jpg">img</a><a href="https://other.org/y">y</a><a href="/">home</a>
      <a href="/category/shoes#top">c</a>`;
    expect(samePageLinks(html, 'https://example.com/')).toEqual([
      'https://example.com/blog/a',
      'https://example.com/product/x',
      'https://example.com/category/shoes',
    ]);
  });

  it('explains TTFB: network vs server, and cold long-tail pages', () => {
    const hit = page({ headers: { 'cf-cache-status': 'HIT' } });
    const r = analyzeFieldFactors(hit, hit, hit, {
      timing: { status: 200, dnsMs: 60, connectMs: 180, tlsMs: 200, serverWaitMs: 90, ttfbMs: 530 },
      pages: [
        { path: '/blog/a', first: { cache: 'miss', ttfbMs: 1400 }, repeat: { cache: 'hit', ttfbMs: 90 } },
        { path: '/product/x', first: { cache: 'hit', ttfbMs: 80 }, repeat: { cache: 'hit', ttfbMs: 70 } },
      ],
    });
    expect(r.signals.join('\n')).toMatch(/mostly network setup \(DNS 60 \+ TCP 180 \+ TLS 200ms\)/);
    expect(r.signals.join('\n')).toMatch(
      /1\/2 other pages missed the edge cache on first request.*\/blog\/a 1400→90ms/,
    );
    expect(r.otherPages).toMatchObject({ coldMissRate: '1/2', neverCached: '0/2' });

    const slowServer = analyzeFieldFactors(hit, hit, hit, {
      timing: {
        status: 200,
        dnsMs: 5,
        connectMs: 20,
        tlsMs: 30,
        serverWaitMs: 900,
        ttfbMs: 955,
        serverTiming: 'db;dur=700',
      },
      pages: [{ path: '/x', first: { cache: 'miss', ttfbMs: 900 }, repeat: { cache: 'miss', ttfbMs: 880 } }],
    });
    expect(slowServer.signals.join('\n')).toMatch(/Server wait 900ms.*Server-Timing: db;dur=700/);
    expect(slowServer.signals.join('\n')).toMatch(/1\/1 other pages are never served from the edge cache/);
  });

  it('runs three requests, the last with marketing params', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response('<html></html>', { status: 200, headers: { 'cf-cache-status': 'HIT' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const r = (await checkFieldFactors.execute(
      { url: 'https://example.com/', device: 'mobile' },
      ctx(),
    )) as ReturnType<typeof analyzeFieldFactors>;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![0])).toContain('utm_source=cwv-agent');
    expect(r.htmlCaching.verdict).toBe('cached-including-marketing-params');
  });
});
