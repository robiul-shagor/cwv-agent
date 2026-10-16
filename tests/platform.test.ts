import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as UrlModule from '../src/lib/url.js';
import type { FetchedPage } from '../src/tools/fetchHtml.js';
import { analyzePlatform, inspectPlatform } from '../src/tools/platform.js';
import { ctx } from './helpers.js';

// Skip DNS resolution in the SSRF guard (covered in fetchHtml tests).
vi.mock('../src/lib/url.js', async (orig) => ({
  ...(await orig<typeof UrlModule>()),
  assertPublicUrl: vi.fn(),
}));

const page = (html: string, headers: Record<string, string> = {}): FetchedPage => ({
  finalUrl: 'https://www.example.com/',
  status: 200,
  redirects: [],
  headers,
  ttfbMs: 100,
  totalMs: 150,
  bytes: html.length,
  truncated: false,
  html,
});

const WP = `<!doctype html><html><head>
<meta name="generator" content="WordPress 6.8.1">
<link rel="stylesheet" href="/wp-content/plugins/elementor/assets/css/frontend.min.css?ver=3.30">
<link rel="stylesheet" href="/wp-content/themes/hello-elementor/style.css" media="print">
<script src="/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script>
<script src="/wp-content/plugins/revslider/public/js/rbtools.min.js" defer></script>
</head><body>
<script type="rocketlazyloadscript" data-rocket-src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
<script src="https://static.hotjar.com/c/hotjar-1.js" async></script>
<script src="/wp-content/plugins/elementor/assets/js/frontend.min.js"></script>
</body></html>
<!-- This website is like a Rocket, isn't it? -->`;

describe('inspect_platform', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('detects WordPress, builders, optimiser features and owners', () => {
    const r = analyzePlatform(page(WP));
    expect(r.platform).toMatchObject({
      cms: ['WordPress'],
      generator: 'WordPress 6.8.1',
      theme: 'hello-elementor',
      pageBuildersAndKeyPlugins: ['Elementor', 'Slider Revolution'],
    });
    expect(r.optimization).toEqual({ detected: ['WP Rocket'], delayedScripts: 1 });
    expect(r.resources).toEqual({ scripts: 5, stylesheets: 2, renderBlockingInHead: 2, thirdPartyOwners: 2 });
    const byOwner = Object.fromEntries(r.owners.map((o) => [o.owner, o]));
    expect(byOwner['wp-plugin:elementor']).toMatchObject({ scripts: 1, styles: 1, blockingInHead: 1 });
    expect(byOwner['wp-core']).toMatchObject({ scripts: 1, blockingInHead: 1 });
    expect(byOwner['wp-theme:hello-elementor']).toMatchObject({ styles: 1, blockingInHead: 0 });
    expect(byOwner['vendor:Google Tag Manager']).toMatchObject({ delayed: 1 });
    expect(r.owners[0]!.blockingInHead).toBe(1); // render-blocking owners first
    expect(r.notes).toBeUndefined();
  });

  it('flags an optimiser whose delay-JS feature is off', () => {
    const r = analyzePlatform(page(WP.replace('type="rocketlazyloadscript" data-rocket-src', 'src')));
    expect(r.optimization.delayedScripts).toBe(0);
    expect(r.notes?.[0]).toMatch(/delay JavaScript/);
  });

  it('detects Shopify theme and apps, and works on unknown sites', () => {
    const shop = analyzePlatform(
      page(
        `<script>Shopify.theme = {"name":"Dawn","id":1};</script>
         <script src="https://cdn.shopify.com/extensions/01-ab/judgeme-reviews-142/assets/w.js" defer></script>
         <link rel="stylesheet" href="/cdn/shop/t/4/assets/base.css">`,
        { 'x-shopid': '123' },
      ),
    );
    expect(shop.platform).toMatchObject({ cms: ['Shopify'], theme: 'Dawn' });
    expect(shop.owners.map((o) => o.owner).sort()).toEqual(['shopify-app:judgeme-reviews', 'shopify-theme']);

    const custom = analyzePlatform(
      page(
        '<html><head><script src="/assets/app.js"></script></head><body><script src="https://cdn.x-vendor.io/a.js"></script></body></html>',
      ),
    );
    expect(custom.platform.cms).toEqual(['custom / unknown']);
    expect(custom.owners.map((o) => o.owner)).toEqual(['first-party', 'third-party:cdn.x-vendor.io']);
  });

  it('adds WordPress REST namespaces (plugins) when available', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: URL) =>
        String(url).includes('/wp-json/')
          ? new Response(
              JSON.stringify({ namespaces: ['oembed/1.0', 'wp/v2', 'wc/v3', 'elementor/v1', 'yoast/v1'] }),
            )
          : new Response(WP, { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const r = (await inspectPlatform.execute(
      { url: 'https://www.example.com/', device: 'mobile' },
      ctx(),
    )) as ReturnType<typeof analyzePlatform>;
    expect(r.restNamespaces).toEqual(['wc/v3', 'elementor/v1', 'yoast/v1']);
    expect(String(fetchMock.mock.calls[1]![0])).toBe('https://www.example.com/wp-json/?_fields=namespaces');
  });
});
