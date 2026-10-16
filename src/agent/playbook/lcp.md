# LCP playbook

Break LCP into phases; a healthy split is roughly TTFB ~40%, load delay <10%, load duration ~40%, render delay <10%.

## High TTFB (server)
- Evidence: PSI `server-response-time`/document latency, CrUX TTFB p75, LCP.ttfb subpart, redirects in `fetch_html`.
- Causes: no CDN/HTML caching (`cache-control: no-store/private`, `cf-cache-status: DYNAMIC/BYPASS`), slow backend/DB,
  redirect chains, cold serverless starts, heavy server-side personalisation.
- Fix (usually `recommend`): cache HTML at the edge (stale-while-revalidate), remove redirects, static/ISR generation, upgrade hosting.

## High resource load delay (late discovery)
- Evidence: LCP.resourceLoadDelay subpart, PSI LCP discovery insight / `lcp-lazy-loaded`, `fetch_html` first images.
- Causes: LCP image has `loading="lazy"` or JS lazy-load (`data-src`); image is a CSS `background-image`; image injected by
  client-side JS / slider; no `fetchpriority="high"`; preload missing; LCP resource on another origin without preconnect.
- Fix (`auto`): remove lazy-loading from the hero, add `fetchpriority="high"`, render `<img>` in server HTML,
  `<link rel="preload" as="image" imagesrcset=… fetchpriority="high">` for background/JS images, preconnect to image CDN.

## High resource load duration (heavy resource)
- Evidence: LCP.resourceLoadDuration, PSI image delivery / `uses-optimized-images` / `modern-image-formats` / `uses-responsive-images`.
- Causes: oversized dimensions, JPEG/PNG instead of AVIF/WebP, no `srcset`/`sizes`, no image CDN, bandwidth contention from
  many early requests.
- Fix: responsive `srcset`+`sizes`, AVIF/WebP, compress, image CDN, lower priority of competing resources.

## High element render delay
- Evidence: LCP.elementRenderDelay, render-blocking resources, long FCP→LCP gap, sync scripts in `<head>`.
- Causes: render-blocking CSS/JS, `@import` chains, web fonts blocking text LCP (no `font-display`), client-side rendering
  (empty HTML shell), A/B testing / anti-flicker snippets hiding the page, hydration before paint, long main-thread tasks.
- Fix: inline critical CSS + defer the rest, `defer`/`async` scripts, `font-display: swap|optional` + preload key fonts,
  SSR/SSG, remove anti-flicker snippets.
