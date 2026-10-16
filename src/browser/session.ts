import { chromium, type Browser, type Page } from 'playwright-core';
import type { Logger } from '../lib/logger.js';
import { assertPublicUrl } from '../lib/url.js';
import { INSTRUMENT_SCRIPT, PAGE_JS, type RawSession } from './instrument.js';

export interface SessionOptions {
  url: string;
  device: 'mobile' | 'desktop';
  /** Chrome/Chromium executable; default: the installed Google Chrome (`channel: 'chrome'`). */
  chromePath?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  logger: Logger;
  /** Overridable in tests. */
  checkUrl?: (url: URL) => Promise<void>;
}

export interface StepLog {
  step: string;
  status: 'done' | 'not-found' | 'skipped' | 'failed';
  detail?: string;
}

export interface BfcacheResult {
  tested: boolean;
  restored?: boolean;
  notRestoredReasons?: string[];
  detail?: string;
}

export interface SessionResult {
  finalUrl: string;
  raw: RawSession;
  steps: StepLog[];
  bfcache: BfcacheResult;
}

/** Lighthouse-like mobile profile: mid-range phone, 4× CPU slowdown, slow 4G. */
const PROFILES = {
  mobile: {
    context: {
      viewport: { width: 412, height: 823 },
      deviceScaleFactor: 1.75,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 CWV-Agent',
    },
    cpu: 4,
    network: {
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    },
  },
  desktop: {
    context: {
      viewport: { width: 1350, height: 940 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 CWV-Agent',
    },
    cpu: 1,
    network: {
      latency: 40,
      downloadThroughput: (10 * 1024 * 1024) / 8,
      uploadThroughput: (5 * 1024 * 1024) / 8,
    },
  },
} as const;

/** Consent-banner "accept" buttons of common CMPs, then generic text matches. */
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '.cky-btn-accept',
  '.cmplz-accept',
  '#cn-accept-cookie',
  '#cookie_action_close_header',
  '.iubenda-cs-accept-btn',
  '[data-testid="uc-accept-all-button"]',
  '.fc-cta-consent',
  '#didomi-notice-agree-button',
  '.termly-styles-button[data-tid="banner-accept"]',
];
const CONSENT_TEXT =
  /^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|alle akzeptieren|accepter|aceptar)\s*$/i;

const MENU_SELECTORS = [
  'button[aria-label*="menu" i]',
  'button[aria-controls*="menu" i]',
  'button[aria-controls*="nav" i]',
  '.menu-toggle',
  '.navbar-toggler',
  'button.hamburger',
  '[class*="hamburger"] button',
  'button[class*="burger"]',
];

/** Safe in-page widgets: expand/collapse and tabs, never links, submit buttons or form controls. */
const WIDGET_SELECTORS = [
  'details > summary',
  '[role="tab"][aria-selected="false"]',
  'button[aria-expanded="false"]:not([type="submit"])',
];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason)), { once: true });
  });

async function mark(page: Page, name: string) {
  await page.evaluate(PAGE_JS.mark(name));
}

async function firstVisible(page: Page, selectors: string[]) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(() => false)) return { loc, selector: s };
  }
  return undefined;
}

async function launchChrome(chromePath?: string): Promise<Browser> {
  try {
    return await chromium.launch(
      // Playwright disables bfcache by default; we need it on to test back/forward restores.
      {
        ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
        headless: true,
        ignoreDefaultArgs: ['--disable-back-forward-cache'],
      },
    );
  } catch (err) {
    throw new Error(
      `Could not start Chrome (${(err as Error).message.split('\n')[0]}). Install Google Chrome or set CHROME_PATH.`,
      { cause: err },
    );
  }
}

/**
 * Plays a short, realistic visit and returns everything the in-page instrumentation recorded:
 * load → idle → accept consent → scroll to bottom → open menu → toggle widgets → (bfcache test).
 */
/** One Chrome session at a time per process: parallel sessions would skew each other's CPU-bound timings. */
let sessionQueue: Promise<unknown> = Promise.resolve();

export function runSession(opts: SessionOptions): Promise<SessionResult> {
  const run = sessionQueue.then(() => runSessionNow(opts));
  sessionQueue = run.catch(() => {});
  return run;
}

async function runSessionNow(opts: SessionOptions): Promise<SessionResult> {
  const checkUrl = opts.checkUrl ?? assertPublicUrl;
  const target = new URL(opts.url);
  await checkUrl(target);

  const profile = PROFILES[opts.device];
  const browser = await launchChrome(opts.chromePath);
  const onAbort = () => void browser.close().catch(() => {});
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = Date.now() + opts.timeoutMs - 5_000;
  const steps: StepLog[] = [];
  const timeLeft = () => deadline - Date.now();

  try {
    const context = await browser.newContext({
      ...profile.context,
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    // Every request (subresources too) must go to a public host: the page must not reach internal services.
    const hostOk = new Map<string, Promise<boolean>>();
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (!/^https?:$/.test(u.protocol)) return route.continue();
      let ok = hostOk.get(u.hostname);
      if (!ok) {
        ok = checkUrl(u).then(
          () => true,
          () => false,
        );
        hostOk.set(u.hostname, ok);
      }
      return (await ok) ? route.continue() : route.abort('blockedbyclient');
    });
    await context.addInitScript(INSTRUMENT_SCRIPT);
    const page = await context.newPage();
    context.on('page', (p) => void p.close().catch(() => {})); // popups / new tabs
    page.on('dialog', (d) => void d.dismiss().catch(() => {}));
    page.setDefaultTimeout(5_000);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });

    // 1. Load
    // Real users don't wait for the load event (ad-heavy pages may never reach it on slow 4G).
    await page.goto(target.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(45_000, timeLeft()),
    });
    await mark(page, 'load');
    const loaded = await page
      .waitForLoadState('load', { timeout: Math.min(15_000, Math.max(1_000, timeLeft() - 30_000)) })
      .then(
        () => true,
        () => false,
      );
    steps.push({
      step: 'load',
      status: 'done',
      detail: loaded ? undefined : 'load event not reached within 15 s after DOMContentLoaded',
    });

    // 2. Idle after load: late ads, widgets, fonts, lazy content near the fold.
    await mark(page, 'post-load-idle');
    await sleep(Math.min(4_000, Math.max(0, timeLeft())), opts.signal);
    steps.push({ step: 'post-load-idle', status: 'done', detail: '4 s without input' });

    const origin = new URL(page.url()).origin;
    const stillHere = () => new URL(page.url()).origin === origin;

    // 3. Consent banner
    await mark(page, 'consent');
    let consent = await firstVisible(page, CONSENT_SELECTORS);
    if (!consent) {
      const byText = page.getByRole('button', { name: CONSENT_TEXT }).first();
      if (await byText.isVisible().catch(() => false))
        consent = { loc: byText, selector: 'button (accept text)' };
    }
    if (consent) {
      await (profile.context.hasTouch ? consent.loc.tap() : consent.loc.click()).catch(() => {});
      await sleep(2_000, opts.signal);
      steps.push({ step: 'consent', status: 'done', detail: `clicked ${consent.selector}` });
    } else steps.push({ step: 'consent', status: 'not-found', detail: 'no visible consent banner' });

    // 4. Scroll to the bottom and back (late ads, sticky headers, infinite scroll, lazy embeds).
    if (timeLeft() > 10_000 && stillHere()) {
      await mark(page, 'scroll');
      const vh = profile.context.viewport.height;
      let n = 0;
      while (n < 15 && timeLeft() > 8_000) {
        await page.mouse.wheel(0, Math.round(vh * 0.8));
        n++;
        await sleep(500, opts.signal);
        if (await page.evaluate<boolean>(PAGE_JS.atBottom)) break;
      }
      await page.evaluate(PAGE_JS.scrollTop);
      await sleep(800, opts.signal);
      steps.push({ step: 'scroll', status: 'done', detail: `${n} scroll steps` });
    } else steps.push({ step: 'scroll', status: 'skipped', detail: 'time budget' });

    // 5. Open and close the menu.
    if (timeLeft() > 6_000 && stillHere()) {
      await mark(page, 'menu');
      const menu = await firstVisible(page, MENU_SELECTORS);
      if (menu) {
        await (profile.context.hasTouch ? menu.loc.tap() : menu.loc.click()).catch(() => {});
        await sleep(1_200, opts.signal);
        await page.keyboard.press('Escape').catch(() => {});
        if (await menu.loc.isVisible().catch(() => false))
          await (profile.context.hasTouch ? menu.loc.tap() : menu.loc.click()).catch(() => {});
        await sleep(800, opts.signal);
        steps.push({
          step: 'menu',
          status: stillHere() ? 'done' : 'failed',
          detail: `toggled ${menu.selector}`,
        });
      } else steps.push({ step: 'menu', status: 'not-found' });
    }

    // 6. Toggle up to two in-page widgets (accordions / tabs).
    if (timeLeft() > 6_000 && stillHere()) {
      await mark(page, 'widgets');
      let clicked = 0;
      for (const s of WIDGET_SELECTORS) {
        if (clicked >= 2) break;
        const loc = page.locator(s).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await (profile.context.hasTouch ? loc.tap() : loc.click()).catch(() => {});
        await sleep(700, opts.signal);
        clicked++;
      }
      steps.push({
        step: 'widgets',
        status: clicked ? 'done' : 'not-found',
        detail: clicked ? `${clicked} toggled` : undefined,
      });
    }

    await sleep(1_000, opts.signal); // let observers flush the last entries
    const raw = await page.evaluate<RawSession>(PAGE_JS.read);
    const finalUrl = page.url();

    // 7. Back/forward cache: leave to a same-site page and come back.
    let bfcache: BfcacheResult = { tested: false };
    if (timeLeft() > 8_000 && stillHere()) {
      const next = await page.evaluate<string | null>(PAGE_JS.sameSiteLink(origin));
      if (next) {
        try {
          await page.goto(next, { waitUntil: 'load', timeout: Math.min(20_000, timeLeft()) });
          await sleep(500, opts.signal);
          // A bfcache restore fires no load event: wait for the commit, then give a reload time to settle.
          await page.goBack({ waitUntil: 'commit', timeout: Math.min(15_000, timeLeft()) });
          await sleep(1_500, opts.signal);
          const after = await page.evaluate<{ doc?: string; reasons: string[] }>(PAGE_JS.bfcacheCheck);
          const restored = after.doc === raw.doc;
          bfcache = {
            tested: true,
            restored,
            notRestoredReasons: restored
              ? undefined
              : after.reasons.length
                ? after.reasons
                    .slice(0, 8)
                    .map((r) =>
                      r === 'masked'
                        ? 'masked (Chrome hides the reason, e.g. an unload handler or a cross-origin iframe; see check_field_factors bfcache blockers)'
                        : r,
                    )
                : ['none reported by Chrome'],
            detail: `navigated to ${next.slice(0, 120)} and back`,
          };
        } catch (err) {
          bfcache = {
            tested: false,
            detail: `bfcache test failed: ${(err as Error).message.split('\n')[0]}`,
          };
        }
      } else bfcache = { tested: false, detail: 'no same-site link to navigate to' };
    }

    return { finalUrl, raw, steps, bfcache };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}
