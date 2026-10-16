# Framework & platform notes

- **Next.js**: `next/image` with `priority` (or `fetchPriority="high"` + no lazy) for the LCP image; `next/font` removes font CLS;
  prefer Server Components to cut hydration; `next/script` `strategy="lazyOnload"` for third parties; check ISR/edge caching for TTFB.
- **React SPA**: empty HTML shell = render delay; recommend SSR/SSG or prerendering; code-split routes; avoid hydration-heavy above-the-fold.
- **Nuxt / Vue**: `<NuxtImg preload>`, `nuxt/fonts`, lazy hydration; check `data-server-rendered`.
- **WordPress** (`platform`): disable lazy-load on the first image (WP ≥ 5.9 skips it only if theme is correct),
  caching plugin (WP Rocket, LiteSpeed Cache, W3TC) for page cache + delay JS, remove unused plugins, Elementor
  "Improved asset loading", image optimisation plugin (WebP/AVIF), host-level CDN.
- **Shopify** (`platform`): theme `image_url` + `image_tag` with `loading: 'eager'` and `fetchpriority: 'high'` on hero,
  `preload: true`; audit installed apps injecting scripts; avoid app embeds above the fold.
- **Webflow / Wix / Squarespace** (`platform`): limited control — disable lazy-load on hero, reduce custom code embeds,
  compress images, remove heavy interactions/animations on load.
