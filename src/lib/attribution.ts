/**
 * Attribute a resource URL to whoever owns it — a CMS plugin/theme/module, a platform app, a named third-party
 * vendor or the site itself — so findings say "Elementor Pro" or "Hotjar" instead of a bare URL.
 * Works on any site from the URL alone; no source code access needed.
 */

/** Path-based rules (work on any host, including CDN-proxied assets). First match wins. */
const PATH_RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // WordPress — optimiser bundles hide the original owners.
  [/\/wp-content\/cache\/(min|busting)\//i, () => 'wp-optimizer-bundle:WP Rocket'],
  [/\/wp-content\/cache\/autoptimize\//i, () => 'wp-optimizer-bundle:Autoptimize'],
  [/\/wp-content\/litespeed\//i, () => 'wp-optimizer-bundle:LiteSpeed Cache'],
  [
    /\/wp-content\/cache\/(minify|wpfc-minified)\//i,
    (m) => `wp-optimizer-bundle:${m[1] === 'minify' ? 'W3 Total Cache' : 'WP Fastest Cache'}`,
  ],
  [/\/wp-content\/(?:mu-)?plugins\/([^/?#]+)\//i, (m) => `wp-plugin:${m[1]}`],
  [/\/wp-content\/themes\/([^/?#]+)\//i, (m) => `wp-theme:${m[1]}`],
  [
    /\/wp-content\/uploads\/(elementor|oxygen|bb-plugin|et-cache|generateblocks|kadence)\//i,
    (m) => `wp-plugin:${m[1]} (generated)`,
  ],
  [/\/wp-(includes|admin)\//i, () => 'wp-core'],
  // Shopify
  [/cdn\.shopify\.com\/extensions\/[^/]+\/([a-z0-9-]+?)-\d[\w.-]*\//i, (m) => `shopify-app:${m[1]}`],
  [
    /\/(?:cdn\/shop|s\/files\/[^/]+\/[^/]+\/[^/]+)\/t\/\d+\/(?:assets|compiled_assets)\//i,
    () => 'shopify-theme',
  ],
  [/\/(?:cdn\/)?shopifycloud\//i, () => 'shopify-core'],
  // Drupal
  [/\/modules\/(?:contrib|custom)\/([^/?#]+)\//i, (m) => `drupal-module:${m[1]}`],
  [/\/themes\/(?:contrib|custom)\/([^/?#]+)\//i, (m) => `drupal-theme:${m[1]}`],
  [/\/sites\/[^/]+\/files\/(?:js|css)\//i, () => 'drupal-aggregated-bundle'],
  // Magento
  [
    /\/static\/(?:version\d+\/)?frontend\/[^/]+\/[^/]+\/[^/]+\/([A-Z][A-Za-z0-9]+_[A-Za-z0-9]+)\//,
    (m) => `magento-module:${m[1]}`,
  ],
  [/\/static\/(?:version\d+\/)?frontend\/([^/]+\/[^/]+)\//, (m) => `magento-theme:${m[1]}`],
  // Joomla
  [
    /\/(?:media|components|modules|plugins\/[^/]+)\/((?:com|mod|plg)_[^/?#]+)\//i,
    (m) => `joomla-extension:${m[1]}`,
  ],
];

/** Host suffix → vendor. Ordered: more specific first. */
const VENDORS: Array<[string, string]> = [
  ['googletagmanager.com', 'Google Tag Manager'],
  ['google-analytics.com', 'Google Analytics'],
  ['analytics.google.com', 'Google Analytics'],
  ['doubleclick.net', 'Google Ads/DoubleClick'],
  ['googlesyndication.com', 'Google AdSense'],
  ['googleadservices.com', 'Google Ads'],
  ['adtrafficquality.google', 'Google Ads'],
  ['fonts.googleapis.com', 'Google Fonts'],
  ['fonts.gstatic.com', 'Google Fonts'],
  ['maps.googleapis.com', 'Google Maps'],
  ['youtube.com', 'YouTube'],
  ['ytimg.com', 'YouTube'],
  ['youtube-nocookie.com', 'YouTube'],
  ['vimeo.com', 'Vimeo'],
  ['vimeocdn.com', 'Vimeo'],
  ['connect.facebook.net', 'Meta Pixel/SDK'],
  ['facebook.com', 'Meta'],
  ['analytics.tiktok.com', 'TikTok Pixel'],
  ['snap.licdn.com', 'LinkedIn Insight'],
  ['ads-twitter.com', 'X (Twitter) Ads'],
  ['platform.twitter.com', 'X (Twitter) embed'],
  ['pinimg.com', 'Pinterest'],
  ['sc-static.net', 'Snapchat Pixel'],
  ['bat.bing.com', 'Microsoft Ads'],
  ['clarity.ms', 'Microsoft Clarity'],
  ['hotjar.com', 'Hotjar'],
  ['hotjar.io', 'Hotjar'],
  ['fullstory.com', 'FullStory'],
  ['mouseflow.com', 'Mouseflow'],
  ['luckyorange.com', 'Lucky Orange'],
  ['crazyegg.com', 'Crazy Egg'],
  ['segment.com', 'Segment'],
  ['segment.io', 'Segment'],
  ['mixpanel.com', 'Mixpanel'],
  ['amplitude.com', 'Amplitude'],
  ['heap.io', 'Heap'],
  ['heapanalytics.com', 'Heap'],
  ['cookielaw.org', 'OneTrust consent'],
  ['onetrust.com', 'OneTrust consent'],
  ['cookiebot.com', 'Cookiebot consent'],
  ['usercentrics.eu', 'Usercentrics consent'],
  ['cookieyes.com', 'CookieYes consent'],
  ['termly.io', 'Termly consent'],
  ['iubenda.com', 'iubenda consent'],
  ['quantcast.com', 'Quantcast'],
  ['intercom.io', 'Intercom chat'],
  ['intercomcdn.com', 'Intercom chat'],
  ['zdassets.com', 'Zendesk chat'],
  ['zopim.com', 'Zendesk chat'],
  ['tawk.to', 'Tawk.to chat'],
  ['crisp.chat', 'Crisp chat'],
  ['drift.com', 'Drift chat'],
  ['livechatinc.com', 'LiveChat'],
  ['tidio.co', 'Tidio chat'],
  ['gorgias.chat', 'Gorgias chat'],
  ['hs-scripts.com', 'HubSpot'],
  ['hs-analytics.net', 'HubSpot'],
  ['hsforms.net', 'HubSpot forms'],
  ['hubspot.com', 'HubSpot'],
  ['klaviyo.com', 'Klaviyo'],
  ['mailchimp.com', 'Mailchimp'],
  ['list-manage.com', 'Mailchimp'],
  ['optimizely.com', 'Optimizely A/B'],
  ['visualwebsiteoptimizer.com', 'VWO A/B'],
  ['abtasty.com', 'AB Tasty'],
  ['convertexperiments.com', 'Convert A/B'],
  ['recaptcha.net', 'reCAPTCHA'],
  ['hcaptcha.com', 'hCaptcha'],
  ['challenges.cloudflare.com', 'Cloudflare Turnstile'],
  ['cloudflareinsights.com', 'Cloudflare Web Analytics'],
  ['cdnjs.cloudflare.com', 'cdnjs (public CDN)'],
  ['jsdelivr.net', 'jsDelivr (public CDN)'],
  ['unpkg.com', 'unpkg (public CDN)'],
  ['code.jquery.com', 'jQuery CDN'],
  ['js.stripe.com', 'Stripe'],
  ['paypal.com', 'PayPal'],
  ['paypalobjects.com', 'PayPal'],
  ['klarna.com', 'Klarna'],
  ['afterpay.com', 'Afterpay'],
  ['rubiconproject.com', 'Magnite/Rubicon ads'],
  ['amazon-adsystem.com', 'Amazon ads'],
  ['adnxs.com', 'Xandr ads'],
  ['criteo.com', 'Criteo'],
  ['criteo.net', 'Criteo'],
  ['taboola.com', 'Taboola'],
  ['outbrain.com', 'Outbrain'],
  ['pubmatic.com', 'PubMatic ads'],
  ['moatads.com', 'Moat ads'],
  ['newrelic.com', 'New Relic'],
  ['nr-data.net', 'New Relic'],
  ['sentry-cdn.com', 'Sentry'],
  ['sentry.io', 'Sentry'],
  ['datadoghq-browser-agent.com', 'Datadog RUM'],
  ['trustpilot.com', 'Trustpilot'],
  ['yotpo.com', 'Yotpo reviews'],
  ['judge.me', 'Judge.me reviews'],
  ['stamped.io', 'Stamped reviews'],
  ['okendo.io', 'Okendo reviews'],
  ['typekit.net', 'Adobe Fonts'],
  ['use.fontawesome.com', 'Font Awesome'],
  ['kit.fontawesome.com', 'Font Awesome'],
  ['addthis.com', 'AddThis'],
  ['sharethis.com', 'ShareThis'],
  ['userway.org', 'UserWay accessibility'],
  ['accessibe.com', 'accessiBe'],
  ['website-files.com', 'Webflow'],
  ['webflow.com', 'Webflow'],
  ['parastorage.com', 'Wix'],
  ['wixstatic.com', 'Wix'],
  ['squarespace.com', 'Squarespace'],
  ['squarespace-cdn.com', 'Squarespace'],
  ['shopify.com', 'Shopify'],
  ['shopifysvc.com', 'Shopify'],
];

/** URL path fragments that identify a vendor even on a generic host (e.g. reCAPTCHA on google.com / gstatic.com). */
const VENDOR_PATHS: Array<[RegExp, string]> = [
  [/\/recaptcha\//i, 'reCAPTCHA'],
  [/\/gtag\/js|\/gtm\.js/i, 'Google Tag Manager'],
];

/** Approximate registrable domain: last two labels, or three for ccSLDs like co.uk / com.au. */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const [sld, tld] = labels.slice(-2);
  const n = tld!.length === 2 && sld!.length <= 3 ? 3 : 2;
  return labels.slice(-n).join('.');
}

/**
 * Who owns this resource, e.g. "wp-plugin:elementor", "shopify-app:judgeme", "vendor:Hotjar",
 * "first-party", "third-party:cdn.example.net". Undefined when the URL can't be parsed.
 */
export function attributeUrl(rawUrl: string, pageUrl?: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl, pageUrl);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol)) return undefined;
  const full = url.hostname + url.pathname;
  for (const [re, label] of PATH_RULES) {
    const m = full.match(re);
    if (m) return label(m);
  }
  for (const [re, name] of VENDOR_PATHS) if (re.test(url.pathname)) return `vendor:${name}`;
  const host = url.hostname.toLowerCase();
  for (const [suffix, name] of VENDORS)
    if (host === suffix || host.endsWith('.' + suffix)) return `vendor:${name}`;
  if (pageUrl) {
    try {
      if (siteOf(new URL(pageUrl).hostname) === siteOf(host)) return 'first-party';
    } catch {
      // ignore bad page URL
    }
  }
  return `third-party:${host}`;
}
