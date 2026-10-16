import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchedPage } from '../src/tools/fetchHtml.js';
import {
  analyzeLabIntegrity,
  checkLabIntegrity,
  findUaSniffing,
  snapshot,
} from '../src/tools/labIntegrity.js';
import type * as UrlModule from '../src/lib/url.js';
import { ctx } from './helpers.js';

// Skip DNS resolution in the SSRF guard (covered in fetchHtml tests).
vi.mock('../src/lib/url.js', async (orig) => ({
  ...(await orig<typeof UrlModule>()),
  assertPublicUrl: vi.fn(),
}));

const page = (html: string): FetchedPage => ({
  finalUrl: 'https://example.com/',
  status: 200,
  redirects: [],
  headers: {},
  ttfbMs: 100,
  totalMs: 150,
  bytes: html.length,
  truncated: false,
  html,
});

const FULL = `<html><head>
<link rel="stylesheet" href="/wp-content/themes/t/style.css?ver=1">
<script src="/wp-content/plugins/slider/slider.js?ver=2"></script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
<script src="https://cdn.chat.example/widget.js"></script>
<script src="/wp-content/plugins/forms/forms.js"></script>
</head><body><img src="/hero.jpg"><iframe src="https://www.youtube.com/embed/x"></iframe></body></html>`;

const STRIPPED = `<html><head>
<link rel="stylesheet" href="/wp-content/themes/t/style.css?ver=9">
</head><body><img src="/hero.jpg"></body></html>`;

describe('check_lab_integrity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ignores ?ver= differences and JSON scripts', () => {
    const a = snapshot(page(FULL.replace('ver=2', 'ver=3') + '<script type="application/ld+json">{}</script>'));
    expect(a.scripts).toContain('example.com/wp-content/plugins/slider/slider.js');
    expect(a.executableScripts).toBe(4);
    expect(analyzeLabIntegrity(snapshot(page(FULL)), a, []).verdict).toBe('no-gaming-detected');
  });

  it('flags a lighter page for Lighthouse as cloaking', () => {
    const r = analyzeLabIntegrity(snapshot(page(FULL)), snapshot(page(STRIPPED)), []);
    expect(r.verdict).toBe('lab-cloaking');
    expect(r.missingForLighthouse?.scripts).toHaveLength(4);
    expect(r.missingForLighthouse?.hosts).toContain('www.googletagmanager.com');
    expect(r.signals[0]).toMatch(/lighter page/);
  });

  it('finds User-Agent checks for lab tools', () => {
    const code = `if (navigator.userAgent.indexOf("Chrome-Lighthouse") == -1) { loadAll(); }`;
    expect(findUaSniffing(code, 'inline script #1')[0]?.snippet).toMatch(/Chrome-Lighthouse/);
    expect(findUaSniffing('const tool = "Lighthouse";', 'x')).toEqual([]);
    expect(findUaSniffing('navigator.userAgent.includes("Firefox")', 'x')).toEqual([]);
  });

  it('flags most scripts delayed until interaction', () => {
    const delayed = Array.from(
      { length: 6 },
      (_, i) => `<script type="rocketlazyloadscript" data-rocket-src="/p${i}.js"></script>`,
    ).join('');
    const s = snapshot(page(`<html><head>${delayed}<script src="/a.js"></script></head></html>`));
    const r = analyzeLabIntegrity(s, s, []);
    expect(r.verdict).toBe('js-deferred-to-interaction');
    expect(r.delayedJs).toMatchObject({ delayed: 6, executable: 7, share: '86%' });
  });

  it('sends a real Chrome UA and the Lighthouse UA, and scans first-party scripts', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const ua = (init.headers as Record<string, string>)['User-Agent']!;
        seen.push(`${url.pathname} ${/Lighthouse/.test(ua) ? 'lab' : /CWV-Agent/.test(ua) ? 'agent' : 'chrome'}`);
        if (url.pathname.endsWith('.js'))
          return new Response('if(/Lighthouse/.test(navigator.userAgent)){return}', { status: 200 });
        return new Response(/Lighthouse/.test(ua) ? STRIPPED : FULL, { status: 200 });
      }),
    );
    const r = (await checkLabIntegrity.execute(
      { url: 'https://example.com/', device: 'mobile' },
      ctx(),
    )) as ReturnType<typeof analyzeLabIntegrity>;
    expect(seen.slice(0, 2)).toEqual(['/ chrome', '/ lab']);
    expect(seen.every((s) => !s.endsWith('agent'))).toBe(true);
    expect(r.verdict).toBe('lab-cloaking');
    expect(r.uaSniffing?.[0]?.where).toBe('example.com/wp-content/plugins/slider/slider.js');
  });
});
