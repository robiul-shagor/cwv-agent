import { parse, type HTMLElement } from 'node-html-parser';
import { z } from 'zod';
import { attributeUrl } from '../lib/attribution.js';
import { truncate } from '../lib/cwv.js';
import { normalizeUrl } from '../lib/url.js';
import { detectStack, fetchFailure, fetchPage, type FetchedPage } from './fetchHtml.js';
import { memo, type Tool, type ToolContext, urlKey } from './types.js';

const Input = z.object({
  url: z.string().min(1).describe('Absolute URL of the page'),
  device: z.enum(['mobile', 'desktop']).default('mobile').describe('User-Agent to send'),
});

const MAX_OWNERS = 25;

/** Script `type`s / attributes used by "delay JS" features: the script only runs on first user interaction. */
export const DELAYED_TYPES =
  /rocketlazyloadscript|litespeed\/javascript|pmdelayedscript|lazyloadscript|nitropackscript/i;
export const DELAYED_SRC_ATTRS = [
  'data-rocket-src',
  'data-src',
  'data-pmdelayedscript',
  'data-lazy-src',
  'data-nitro-src',
];

const CMS_RULES: Array<
  [string, (html: string, generator: string, headers: Record<string, string>) => boolean]
> = [
  ['WordPress', (h, g) => /wordpress/i.test(g) || /\/wp-(content|includes)\//.test(h)],
  ['Shopify', (h, _g, hd) => !!hd['x-shopid'] || /cdn\.shopify\.com|Shopify\.theme/.test(h)],
  [
    'Drupal',
    (h, g, hd) =>
      /drupal/i.test(g + (hd['x-generator'] ?? '')) ||
      !!hd['x-drupal-cache'] ||
      /drupal-settings-json/.test(h),
  ],
  ['Magento', (h) => /Magento_[A-Z]|\/static\/(version\d+\/)?frontend\//.test(h)],
  ['Joomla', (h, g) => /joomla/i.test(g) || /\/media\/(jui|system)\/js\//.test(h)],
  ['Webflow', (h, g) => /webflow/i.test(g) || /data-wf-page/.test(h)],
  ['Wix', (h, g) => /wix\.com/i.test(g) || /static\.parastorage\.com/.test(h)],
  ['Squarespace', (h) => /static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/.test(h)],
  ['Ghost', (h, g) => /ghost/i.test(g)],
  ['PrestaShop', (h, g) => /prestashop/i.test(g) || /var prestashop\s*=/.test(h)],
  ['BigCommerce', (h) => /cdn\d*\.bigcommerce\.com/.test(h)],
  ['HubSpot CMS', (h, g) => /hubspot/i.test(g)],
];

/** WordPress page builders, keyed by plugin/theme slug. */
const PAGE_BUILDERS: Record<string, string> = {
  elementor: 'Elementor',
  'elementor-pro': 'Elementor Pro',
  divi: 'Divi',
  'divi-builder': 'Divi',
  js_composer: 'WPBakery',
  'bb-plugin': 'Beaver Builder',
  'beaver-builder-lite-version': 'Beaver Builder',
  oxygen: 'Oxygen',
  bricks: 'Bricks',
  brizy: 'Brizy',
  'thrive-visual-editor': 'Thrive Architect',
  'fusion-builder': 'Avada Fusion Builder',
  avada: 'Avada',
  'kadence-blocks': 'Kadence Blocks',
  generateblocks: 'GenerateBlocks',
  'ultimate-addons-for-gutenberg': 'Spectra',
  revslider: 'Slider Revolution',
  layerslider: 'LayerSlider',
  woocommerce: 'WooCommerce',
};

/** Caching / optimisation plugins and services, and the features we can see switched on. */
const OPTIMIZERS: Array<[string, RegExp]> = [
  [
    'WP Rocket',
    /WP Rocket|This website is like a Rocket|data-rocket-|\/wp-content\/cache\/min\/|wpr-usedcss/i,
  ],
  ['LiteSpeed Cache', /LiteSpeed Cache|\/wp-content\/litespeed\/|litespeed\/javascript/i],
  ['W3 Total Cache', /W3 Total Cache/i],
  ['WP Super Cache', /WP-Super-Cache/i],
  ['WP Fastest Cache', /WP Fastest Cache|wpfc-minified/i],
  ['Autoptimize', /\/cache\/autoptimize\//i],
  ['Perfmatters', /perfmatters-(lazy|delayed|used-css|fade)|pmdelayedscript|data-perfmatters/i],
  ['FlyingPress', /flying-press|data-loading-method="user-interaction"/i],
  ['NitroPack', /=\s*["']?(?:https?:)?\/\/[^"'\s>]*nitrocdn\.com|nitro-lazy|data-nitro-|window\.NPRL/i],
  ['SiteGround Optimizer', /sg-optimizer|siteground-optimizer/i],
  ['Jetpack Boost', /jetpack-boost/i],
  ['Hummingbird', /wphb-|hummingbird-performance/i],
  ['Breeze', /Cache served by breeze|breeze-minification/i],
  ['Cloudflare Rocket Loader', /rocket-loader\.min\.js|data-cf-settings/i],
  ['lazysizes', /lazysizes|class="[^"]*\blazyload\b/i],
];

interface OwnerStats {
  owner: string;
  scripts: number;
  styles: number;
  blockingInHead: number;
  delayed: number;
  examples: string[];
}

const attr = (el: HTMLElement, name: string) => el.getAttribute(name) ?? undefined;

export function analyzePlatform(page: FetchedPage, restNamespaces?: string[]) {
  const root = parse(page.html, { blockTextElements: { script: true, style: true, noscript: true } });
  const head = root.querySelector('head');
  const generator = root
    .querySelectorAll('meta[name="generator"]')
    .map((m) => m.getAttribute('content')?.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');

  const owners = new Map<string, OwnerStats>();
  const add = (url: string, kind: 'script' | 'style', flags: { blocking: boolean; delayed: boolean }) => {
    const owner = attributeUrl(url, page.finalUrl);
    if (!owner) return;
    const s = owners.get(owner) ?? {
      owner,
      scripts: 0,
      styles: 0,
      blockingInHead: 0,
      delayed: 0,
      examples: [],
    };
    if (kind === 'script') s.scripts++;
    else s.styles++;
    if (flags.blocking) s.blockingInHead++;
    if (flags.delayed) s.delayed++;
    if (s.examples.length < 2) s.examples.push(truncate(url, 150)!);
    owners.set(owner, s);
  };
  const inHead = (el: HTMLElement) => {
    for (let p = el.parentNode; p; p = p.parentNode) if (p === head) return true;
    return false;
  };

  let delayedScripts = 0;
  for (const el of root.querySelectorAll('script')) {
    const type = attr(el, 'type') ?? '';
    const delayed = DELAYED_TYPES.test(type) || el.hasAttribute('data-rocket-src');
    const src =
      attr(el, 'src') ?? (delayed ? DELAYED_SRC_ATTRS.map((a) => attr(el, a)).find(Boolean) : undefined);
    if (delayed) delayedScripts++;
    if (!src) continue;
    const blocking =
      !delayed && inHead(el) && !el.hasAttribute('async') && !el.hasAttribute('defer') && type !== 'module';
    add(src, 'script', { blocking, delayed });
  }
  for (const el of root.querySelectorAll('link')) {
    const rel = (attr(el, 'rel') ?? '').toLowerCase();
    const href = attr(el, 'href');
    if (!href || !/stylesheet/.test(rel)) continue;
    const media = attr(el, 'media');
    add(href, 'style', { blocking: inHead(el) && (!media || /^(all|screen)$/i.test(media)), delayed: false });
  }

  const list = [...owners.values()].sort(
    (a, b) => b.blockingInHead - a.blockingInHead || b.scripts + b.styles - (a.scripts + a.styles),
  );
  const cms = CMS_RULES.filter(([, test]) => test(page.html, generator, page.headers)).map(([name]) => name);
  const slugs = list.map((o) => o.owner.replace(/^wp-(plugin|theme):/, '').replace(/ \(generated\)$/, ''));
  const builders = [...new Set(slugs.map((s) => PAGE_BUILDERS[s.toLowerCase()]).filter(Boolean))];
  const optimizers = OPTIMIZERS.filter(([, re]) => re.test(page.html)).map(([name]) => name);
  if (page.headers['x-litespeed-cache'] && !optimizers.includes('LiteSpeed Cache'))
    optimizers.push('LiteSpeed Cache');
  const shopifyTheme = page.html.match(/Shopify\.theme\s*=\s*\{[^}]*?"name"\s*:\s*"([^"]{1,80})"/)?.[1];
  const wpTheme = list.find((o) => o.owner.startsWith('wp-theme:'))?.owner.slice(9);

  const notes: string[] = [];
  const thirdParties = list.filter(
    (o) => o.owner.startsWith('vendor:') || o.owner.startsWith('third-party:'),
  );
  if (
    optimizers.some((o) => /Rocket|LiteSpeed|Perfmatters|FlyingPress|NitroPack/.test(o)) &&
    delayedScripts === 0
  )
    notes.push(
      'An optimisation plugin with a "delay JavaScript" feature is active but no scripts are delayed: the feature is off ' +
        'or excludes everything on this page.',
    );
  if (optimizers.includes('Cloudflare Rocket Loader'))
    notes.push(
      'Cloudflare Rocket Loader rewrites script loading; it often delays LCP and hurts INP — test with it off.',
    );
  if (list.some((o) => o.owner.startsWith('wp-optimizer-bundle:')))
    notes.push(
      'Combined/minified optimiser bundles hide which plugin a script belongs to; PSI long tasks will show the bundle URL only.',
    );

  return {
    source: 'Server HTML (no JS executed): resources injected later by JS/tag managers are not included',
    finalUrl: page.finalUrl,
    platform: {
      cms: cms.length ? cms : ['custom / unknown'],
      generator: truncate(generator, 80) || undefined,
      theme: wpTheme ?? shopifyTheme,
      pageBuildersAndKeyPlugins: builders.length ? builders : undefined,
      stack: detectStack(page.html, page.headers),
      poweredBy: page.headers['x-powered-by'],
    },
    optimization: {
      detected: optimizers,
      delayedScripts,
    },
    resources: {
      scripts: list.reduce((n, o) => n + o.scripts, 0),
      stylesheets: list.reduce((n, o) => n + o.styles, 0),
      renderBlockingInHead: list.reduce((n, o) => n + o.blockingInHead, 0),
      thirdPartyOwners: thirdParties.length,
    },
    owners: list.slice(0, MAX_OWNERS),
    omittedOwners: Math.max(0, list.length - MAX_OWNERS) || undefined,
    restNamespaces,
    notes: notes.length ? notes : undefined,
  };
}

/** Core namespaces carry no plugin signal. */
const CORE_NAMESPACES = /^(oembed|wp|wp-site-health|wp-block-editor|wp-abilities)\//;

async function wpRestNamespaces(finalUrl: string, device: 'mobile' | 'desktop', ctx: ToolContext) {
  try {
    const res = await fetchPage(`${normalizeUrl(finalUrl).origin}/wp-json/?_fields=namespaces`, device, ctx);
    if (res.status !== 200) return undefined;
    const ns = (JSON.parse(res.html) as { namespaces?: unknown }).namespaces;
    if (!Array.isArray(ns)) return undefined;
    const plugins = ns
      .filter((n): n is string => typeof n === 'string' && !CORE_NAMESPACES.test(n))
      .map((n) => n.split('/').slice(0, 2).join('/'));
    return [...new Set(plugins)].slice(0, 40);
  } catch {
    return undefined; // REST API disabled/blocked: not an error for the diagnosis
  }
}

export const inspectPlatform: Tool<z.infer<typeof Input>> = {
  name: 'inspect_platform',
  description:
    'Identify the platform behind a page without source access and attribute every script/stylesheet to its owner: ' +
    'CMS (WordPress, Shopify, Drupal, Magento, Joomla, Webflow, Wix, Squarespace…), theme, page builder, WordPress ' +
    'plugins / Shopify apps / modules, named third-party vendors or first-party code — with render-blocking and ' +
    'delayed counts per owner. Also detects caching/optimisation plugins (WP Rocket, LiteSpeed, Perfmatters, NitroPack, ' +
    'Cloudflare Rocket Loader…) and, on WordPress, public REST API namespaces (more active plugins). Use it on every site ' +
    'to turn findings into platform-specific fixes ("which plugin/app/vendor and which setting").',
  inputSchema: Input,
  async execute(input, ctx) {
    return memo(ctx, `platform:${input.device}:${urlKey(input.url)}`, async () => {
      try {
        const page = await fetchPage(input.url, input.device, ctx);
        const result = analyzePlatform(page);
        if (result.platform.cms.includes('WordPress')) {
          result.restNamespaces = await wpRestNamespaces(page.finalUrl, input.device, ctx);
        }
        return result;
      } catch (err) {
        fetchFailure(err);
      }
    });
  },
};
