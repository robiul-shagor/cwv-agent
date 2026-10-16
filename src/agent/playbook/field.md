# Field vs lab playbook

PSI lab = one cold load, emulated mid-range phone, no user, no cookies/consent, no interactions, CLS only during load.
CrUX field = p75 of all real Chrome page loads (any network, device, cache state, navigation type) over 28 days.
When the lab passes but the assessment fails, the cause is almost always one of these.

## LCP / TTFB worse in the field
- **Marketing params bypass the cache**: `?utm_*`, `gclid`, `fbclid` create a new cache key → origin TTFB for ad/email
  visitors. Evidence: `check_field_factors` verdict. Fix (`recommend`/`platform`): ignore these params in the CDN cache key
  (Cloudflare Cache Rules / query-string sort+ignore, Fastly/Akamai/CloudFront cache policy, WP Rocket/LiteSpeed "ignored parameters").
- **HTML not edge-cached** (`no-store`/`private`, `cf-cache-status: DYNAMIC`, `Vary: Cookie`): every visit pays origin time.
  Fix: cache HTML at the edge with `stale-while-revalidate`; keep personalisation client-side.
- **Redirects** (http→https, www, trailing slash, geo/locale) on real entry URLs. Fix: link and serve the final URL.
- **Field LCP subparts** (CrUX `LCP.*`) show the real dominant phase; trust them over the lab split.
- **Different LCP element for real users**: consent/cookie banner, promo popup, or a different hero per viewport.
  Fix: make the banner small/non-LCP-sized or render it after the hero; preload the real hero.
- Slow real devices/networks: heavy hero images and JS-rendered heroes hurt far more at p75 than in the lab.

## INP (lab cannot measure it)
- Common field causes: consent banner "Accept" handler firing all tags synchronously, tag manager / analytics /
  chat / A-B testing on click, menu and filter handlers re-rendering large trees, add-to-cart doing sync work, hydration
  still running when users first tap.
- Fix: yield (`scheduler.yield()` / `setTimeout`) before non-visual work so the next paint happens first; load
  third parties after consent in idle chunks; reduce hydration; debounce input handlers.
- Precise location needs RUM attribution (interaction target + long-animation-frame scripts): list it in dataGaps.

## CLS worse in the field
- Shifts after load: ads/embeds without reserved space, infinite scroll/"load more", sticky headers appearing on scroll,
  late cookie/promo bars pushing content, chat widgets, font swap on slow networks, carousels.
- Fix: reserve space (`min-height`, `aspect-ratio`), use overlays/`transform` instead of pushing content.

## PageSpeed score hacks (lab gamed, field still fails)
Sold as "100/100 PageSpeed" by some freelancers and plugins; Search Console keeps failing because users get the real page.
- **UA cloaking**: server or plugin skips scripts/CSS/images when the User-Agent contains `Lighthouse`/`GTmetrix`/`PTST`.
  Evidence: `check_lab_integrity.missingForLighthouse`. Fix: remove the rule/plugin, then fix the real causes.
- **Client-side sniffing**: `if (navigator.userAgent.indexOf('Lighthouse') === -1) { load… }` or hiding content for bots.
  Evidence: `uaSniffing` snippets. Consent/analytics bot filters also match: only "gamed" if it changes what loads or renders.
- **Delay all JS until interaction** (WP Rocket/LiteSpeed/Perfmatters/FlyingPress/NitroPack): TBT drops to ~0 in the lab,
  but sliders, menus, consent and tags run on the first tap/scroll → poor field INP, and CLS when they render content.
  Keep delay for third-party tags only; load above-the-fold and interaction-critical scripts normally (deferred).
- Report what the hack hides: the real LCP element/phases, CLS sources and INP scripts from field and session evidence.

## Navigation-type quick wins (CrUX `navigationTypes`)
- **bfcache**: back/forward restores are near-0 LCP and 0 CLS. A low `back_forward` share (typically < 5–10% on content
  sites) or blockers in `check_field_factors` → remove `unload` handlers (use `pagehide`), avoid `Cache-Control: no-store`
  on HTML, close WebSocket/BroadcastChannel on `pagehide`.
- **Prerender**: speculation rules (`<script type="speculationrules">`, moderate eagerness for same-site links; WordPress
  6.8+ and Cloudflare offer it) make subsequent navigations near-instant. A `prerender` share near 0% is a missed win.

## Scope
- If the URL has no CrUX data, Google uses the **origin** assessment: one slow template (search, category, product) can
  fail the whole site. Recommend checking the main templates' URLs with `get_crux` when budget allows.
- CrUX is a 28-day window: fixes show gradually; verify with `get_crux_history` weekly.
