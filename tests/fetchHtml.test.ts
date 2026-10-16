import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHtml, summarizeHtml, type FetchedPage } from '../src/tools/fetchHtml.js';
import { ToolError } from '../src/tools/types.js';
import { ctx } from './helpers.js';

const html = `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="preconnect" href="https://cdn.example.com">
<link rel="stylesheet" href="/app.css">
<script src="/vendor.js"></script>
<script src="/app.js" defer></script>
<script type="application/ld+json">{"@type":"Thing"}</script>
<style>@font-face{font-family:X;src:url(x.woff2);font-display:swap}</style>
<script>window.__NEXT_DATA__={}</script>
</head><body>
<div class="banner" style="background-image:url(/bg.jpg)"></div>
<img class="hero" src="/hero.jpg" loading="lazy" alt="Hero">
<img src="/logo.png" width="100" height="40" srcset="/logo@2x.png 2x" fetchpriority="high">
<iframe src="https://www.youtube.com/embed/x"></iframe>
<script src="https://www.googletagmanager.com/gtm.js?id=GTM-1"></script>
</body></html>`;

const page = (over: Partial<FetchedPage> = {}): FetchedPage => ({
  finalUrl: 'https://example.com/',
  status: 200,
  redirects: [],
  headers: { 'cache-control': 'private, no-store' },
  ttfbMs: 450,
  totalMs: 600,
  bytes: html.length,
  truncated: false,
  html,
  ...over,
});

describe('summarizeHtml', () => {
  it('summarises head order, blocking scripts, images, iframes and stack', () => {
    const s = summarizeHtml(page());
    expect(s.head.entries.map((e) => e.rel ?? e.tag)).toEqual([
      'meta',
      'meta',
      'preconnect',
      'stylesheet',
      'script',
      'script',
      'style',
      'script',
    ]);
    expect(s.head.blockingScripts).toBe(1);
    expect(s.head.entries.find((e) => e.tag === 'style')).toMatchObject({
      fontFaces: 1,
      fontDisplay: 'font-display:swap',
    });
    expect(s.body.firstImages[0]).toMatchObject({ src: '/hero.jpg', loading: 'lazy', class: 'hero' });
    expect(s.body.firstImages[0]).not.toHaveProperty('width');
    expect(s.body.firstImages[1]).toMatchObject({
      width: '100',
      height: '40',
      srcset: true,
      fetchpriority: 'high',
    });
    expect(s.body.iframes?.[0]).toMatchObject({ hasDimensions: false });
    expect(s.body.inlineBackgroundImages?.[0]).toMatchObject({ class: 'banner' });
    expect(s.detectedStack).toEqual(expect.arrayContaining(['Next.js', 'Google Tag Manager']));
  });
});

describe('fetch_html tool', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses private/internal URLs (SSRF guard)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchHtml.execute({ url: 'http://127.0.0.1:8080/admin', device: 'mobile' }, ctx()),
    ).rejects.toThrow(ToolError);
    await expect(fetchHtml.execute({ url: 'http://localhost/', device: 'mobile' }, ctx())).rejects.toThrow(
      ToolError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-checks redirect targets', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })),
    );
    await expect(
      fetchHtml.execute({ url: 'http://93.184.216.34/', device: 'mobile' }, ctx()),
    ).rejects.toThrow(/private/);
  });
});
