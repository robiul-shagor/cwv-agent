# TBT & Speed Index playbook (lab metrics)

TBT and SI are **lab-only**: they drive the PageSpeed score (TBT 30%, SI 10%) but not the Core Web Vitals assessment.
Fix them because TBT predicts **INP** (busy main thread → input delay) and slow SI usually means slow **FCP/LCP**.
Mobile thresholds: TBT good ≤ 200 ms / poor > 600 ms; SI good ≤ 3.4 s / poor > 5.8 s (desktop 150/350 ms, 1.3/2.3 s).

## TBT — Total Blocking Time
TBT = sum of (task length − 50 ms) for every main-thread task between FCP and Time to Interactive.
- Evidence: `mainThread` in `run_pagespeed` — `longestTasks` (url = script that ran), `heaviestScripts`
  (scripting vs parse/compile), `workByType`, `thirdPartyBlocking`, `domElements`; plus `unused-javascript`,
  `legacy-javascript`, `duplicated-javascript` opportunities.
- Read `workByType` first:
  - **Script Evaluation dominant** → too much JS executed at load. Find the top script/entity:
    - Third party (tag manager, analytics, chat, A/B testing, ads, heatmaps, social embeds) → defer until idle/interaction or
      after consent, remove unused tags, use facades for chat/video, move to server-side tagging / Partytown where safe.
    - First-party bundle → name the module first: `inspect_script` (URL + `hotspot.charPosition` from the session) maps
      a hashed chunk to file:line:function and shows which packages fill the bundle. Then code-split by route,
      lazy-load below-the-fold components, remove unused/duplicated libs, ship modern JS (drop legacy polyfills),
      reduce hydration (islands, server components, partial hydration).
      If `likelyLibrary` is a wrapper (Sentry, zone.js, jQuery event dispatch), the cost belongs to the wrapped handler:
      name the control from the LoAF `invoker` (e.g. `DIV#__next.onclick`) and the interaction target instead.
    - One long task from a single function → break it up with `scheduler.yield()` / `setTimeout` chunks.
  - **Script Parsing & Compilation high** → JS bytes are the problem: shrink and split bundles, defer non-critical scripts.
  - **Style & Layout / Rendering high** → large DOM (> ~1,500 nodes), heavy CSS selectors, layout thrashing, animated layout
    properties → reduce DOM, `content-visibility: auto` for off-screen sections, batch DOM reads/writes.
  - **Parse HTML & CSS high** → huge HTML or inline CSS/JSON (e.g. big `__NEXT_DATA__`) → trim payload, paginate.
- WordPress/Shopify: page builders, slider/carousel plugins, multiple analytics/pixel plugins and theme jQuery
  bundles are the usual culprits → `platform` fixes (delay JS execution, remove plugins, disable unused modules).
- Report as metric `TBT`; if field INP is not good, link the finding to INP (same cause) and say so in the rootCause.

## SI — Speed Index
SI = how quickly the visible viewport fills in during load (average of visual progress over time).
- Compare `labMetrics`: **SI ≈ FCP** → nothing paints until late: fix FCP (TTFB, render-blocking CSS/JS, `@import`,
  web fonts without `font-display`, anti-flicker/A-B snippets hiding the page).
- **SI ≫ FCP** → the first paint is early but the viewport fills in late:
  - above-the-fold content rendered by client-side JS (empty shell, skeletons replaced after hydration) → SSR/SSG it;
  - hero/above-the-fold images lazy-loaded or low priority → eager + `fetchpriority="high"` for the hero;
  - late web fonts/icon fonts, carousels/sliders initialising, fade-in/entrance animations on load, cookie/promo overlays
    covering the viewport → remove load animations, render overlays after main content, preload key fonts.
- SI usually improves with the LCP fixes; prefer one finding that fixes both (state the SI effect in expectedImpact).
- Report as metric `SI` only when the cause is distinct from the LCP/FCP findings.
