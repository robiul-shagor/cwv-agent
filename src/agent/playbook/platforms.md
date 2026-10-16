# Platform playbook (no source code needed)

Every URL in `run_pagespeed` items / `mainThread` has an `owner`; `inspect_platform` lists owners from the server HTML.
Name the owner in every finding ("Elementor Pro frontend.js", "Hotjar", "Judge.me app") and give the fix where that
owner is configured: plugin/app setting, theme option, tag manager, vendor dashboard or code.
Owner kinds: `wp-plugin:<slug>`, `wp-theme:<slug>`, `wp-core`, `wp-optimizer-bundle:<plugin>`, `shopify-app:<handle>`,
`shopify-theme`, `shopify-core`, `drupal-module:<name>`, `magento-module:<Vendor_Module>`, `joomla-extension:<name>`,
`vendor:<name>`, `first-party`, `third-party:<host>`.

## WordPress
- **Page cache / TTFB**: no optimiser detected → recommend one (LiteSpeed Cache on LiteSpeed hosts, otherwise WP Rocket or
  the host's cache) + CDN HTML caching. Detected but `check_field_factors` shows misses → fix cache rules, ignore
  marketing query strings (WP Rocket: Advanced Rules / "Cache query strings"; LiteSpeed: Cache → Drop Query String).
- **TBT / INP**: enable "Delay JavaScript execution" for third-party and non-critical plugin scripts
  (WP Rocket: File Optimization → Delay JS; LiteSpeed: Page Optimization → JS Delayed; Perfmatters: Delay JS;
  FlyingPress: Delay JS). `optimization.delayedScripts = 0` with such a plugin active = feature off. Never delay scripts
  that render above-the-fold content (sliders in the hero, menu, consent banner).
- **Per-page asset unloading**: plugins loading everywhere (contact forms, sliders, WooCommerce on non-shop pages) →
  Perfmatters Script Manager / Asset CleanUp / Elementor "Improved asset loading".
- **Page builders**: Elementor → Experiments: Optimized DOM output, Improved asset loading, Improved CSS loading, disable
  unused widgets/Font Awesome/Google Fonts (Site Settings), "Optimized Image Loading". Divi → Theme Options → Performance
  (Dynamic CSS, Dynamic JS, Critical CSS, defer jQuery). WPBakery/Avada/Bricks have similar asset options.
- **Sliders** (Slider Revolution, LayerSlider, Smart Slider) as LCP → replace hero slider with a static image or set the
  first slide to load eagerly with fetchpriority; sliders are a top cause of LCP render delay and TBT.
- **Images**: the hero must not be lazy-loaded — exclude it in the optimiser ("Exclude from lazy load" / "Skip images
  count = 1"), add fetchpriority via the theme or optimiser ("Preload LCP image"), serve WebP/AVIF (ShortPixel, Imagify,
  EWWW, host CDN).
- **Fonts**: host Google Fonts locally or let the optimiser combine/preload them; `font-display: swap`.
- **`wp-optimizer-bundle`**: combined files hide the owner; ask to temporarily disable combining or look in the
  plugin's file list; prefer *not* combining JS on HTTP/2 (it delays execution and blocks delay-JS exclusions).
- **WooCommerce**: cart-fragments AJAX on every page (disable on non-shop pages), heavy product galleries, variation swatches.
- With `wp-content` linked as source: theme code in `themes/<slug>/` (`functions.php` enqueues), plugin code in
  `plugins/<slug>/`; prefer filters/settings over editing plugin files (updates overwrite them).

## Shopify
- `shopify-app:<handle>` / app vendors (reviews, upsell, chat, pop-ups, wishlists, currency) are the usual TBT/INP cause →
  disable unused app embeds (Theme editor → App embeds), uninstalled apps can leave snippets in `theme.liquid`.
- Hero: `image_url` + `image_tag` with `loading: 'eager'`, `fetchpriority: 'high'`, `preload: true`, proper `widths`/`sizes`.
- Theme: prefer Online Store 2.0 themes (Dawn-based) over legacy jQuery-heavy themes; limit sections above the fold.
- TTFB is Shopify-managed: focus on Liquid complexity (nested loops over collections) and redirects.

## Other CMS / builders
- **Drupal**: enable CSS/JS aggregation, BigPipe for personalised parts, Page Cache + Dynamic Page Cache, a CDN;
  check heavy contrib modules in owners.
- **Magento**: production mode, full-page cache (Varnish), avoid JS bundling (use Magepack/advanced bundling), defer
  RequireJS-heavy modules, optimise the hero in the theme.
- **Joomla**: page cache plugin, JCH Optimize, remove unused extensions.
- **Webflow / Wix / Squarespace**: limited control → reduce custom code embeds and third-party widgets, remove load
  animations/interactions on the hero, compress hero images, avoid lazy-loading the hero.

## Any site (custom / unknown platform)
- Group cost by owner: first-party bundles → code fixes (`auto`/`recommend`); `vendor:*` → tag manager / vendor settings
  (load after consent, on interaction, or remove); `third-party:<host>` you can't name → state the host and ask who owns it.
- Tag managers: the GTM container itself is small; the tags inside it are the cost → recommend auditing triggers
  (All Pages → specific pages, Window Loaded / custom idle trigger) and removing duplicate analytics/pixels.
