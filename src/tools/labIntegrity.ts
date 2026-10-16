import { parse } from 'node-html-parser';
import { z } from 'zod';
import { truncate } from '../lib/cwv.js';
import { fetchFailure, fetchPage, USER_AGENTS, type FetchedPage } from './fetchHtml.js';
import { DELAYED_SRC_ATTRS, DELAYED_TYPES } from './platform.js';
import { memo, type Tool, type ToolContext, urlKey } from './types.js';

const Input = z.object({
  url: z.string().min(1).describe('Absolute URL of the page'),
  device: z.enum(['mobile', 'desktop']).default('mobile').describe('Device whose User-Agents to compare'),
});

/** What a real Chrome visitor sends (no agent marker: cloaking scripts may treat unknown UAs as bots). */
const CHROME_UA = {
  mobile: USER_AGENTS.mobile.replace(/ CWV-Agent$/, ''),
  desktop: USER_AGENTS.desktop.replace(/ CWV-Agent$/, ''),
};

/** What PageSpeed Insights' Lighthouse sends. */
export const LIGHTHOUSE_UA = {
  mobile:
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
  desktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Chrome-Lighthouse',
};

/** Names of lab testing tools a "speed hack" script checks for. */
const LAB_TOOL_RE = /Chrome-Lighthouse|Lighthouse|GTmetrix|PTST|Pingdom|Speed ?Insights|PageSpeed/gi;
const UA_RE = /userAgent|HTTP_USER_AGENT/;
const NON_EXEC_TYPES = /json|template|speculationrules|importmap|text\/html|x-tmpl/i;
const MAX_SCRIPT_SCANS = 8;
const MAX_LISTED = 15;

interface Snapshot {
  status: number;
  bytes: number;
  scripts: string[];
  inlineScripts: string[];
  stylesheets: string[];
  images: number;
  iframes: number;
  hosts: string[];
  delayedScripts: number;
  executableScripts: number;
}

/** Path without query (cache-busting `?ver=` differs between requests). */
function resourceKey(raw: string, base: string): string | undefined {
  try {
    const u = new URL(raw, base);
    return u.protocol.startsWith('http') ? `${u.host}${u.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

export function snapshot(page: FetchedPage): Snapshot {
  const root = parse(page.html, { blockTextElements: { script: true, style: true, noscript: true } });
  const scripts = new Set<string>();
  const inlineScripts: string[] = [];
  let delayedScripts = 0;
  let executableScripts = 0;
  for (const el of root.querySelectorAll('script')) {
    const type = el.getAttribute('type') ?? '';
    if (NON_EXEC_TYPES.test(type)) continue;
    executableScripts++;
    const delayed = DELAYED_TYPES.test(type) || el.hasAttribute('data-rocket-src');
    if (delayed) delayedScripts++;
    const src =
      el.getAttribute('src') ??
      (delayed ? DELAYED_SRC_ATTRS.map((a) => el.getAttribute(a)).find(Boolean) : undefined);
    const key = src ? resourceKey(src, page.finalUrl) : undefined;
    if (key) scripts.add(key);
    else if (!src && el.text.trim()) inlineScripts.push(el.text);
  }
  const stylesheets = new Set(
    root
      .querySelectorAll('link')
      .filter((el) => /stylesheet/i.test(el.getAttribute('rel') ?? ''))
      .map((el) => resourceKey(el.getAttribute('href') ?? '', page.finalUrl))
      .filter((k): k is string => !!k),
  );
  const hosts = new Set([...scripts, ...stylesheets].map((k) => k.split('/')[0]!));
  return {
    status: page.status,
    bytes: page.bytes,
    scripts: [...scripts],
    inlineScripts,
    stylesheets: [...stylesheets],
    images: root.querySelectorAll('img').length,
    iframes: root.querySelectorAll('iframe').length,
    hosts: [...hosts],
    delayedScripts,
    executableScripts,
  };
}

/** Snippets where code reads the User-Agent and names a lab testing tool. */
export function findUaSniffing(code: string, where: string): Array<{ where: string; snippet: string }> {
  if (!UA_RE.test(code)) return [];
  const hits: Array<{ where: string; snippet: string }> = [];
  for (const m of code.matchAll(LAB_TOOL_RE)) {
    const start = Math.max(0, m.index - 100);
    const window = code.slice(start, m.index + 100);
    if (!UA_RE.test(code.slice(Math.max(0, m.index - 600), m.index + 600))) continue;
    hits.push({ where, snippet: truncate(window.replace(/\s+/g, ' ').trim(), 200)! });
    if (hits.length >= 3) break;
  }
  return hits;
}

const diff = (a: string[], b: string[]) => a.filter((x) => !new Set(b).has(x));
const counts = (s: Snapshot) => ({
  status: s.status,
  htmlKB: Math.round(s.bytes / 1024),
  scripts: s.scripts.length,
  inlineScripts: s.inlineScripts.length,
  stylesheets: s.stylesheets.length,
  images: s.images,
  iframes: s.iframes,
  hosts: s.hosts.length,
});

export function analyzeLabIntegrity(
  user: Snapshot,
  lab: Snapshot,
  sniffing: Array<{ where: string; snippet: string }>,
) {
  const missingScripts = diff(user.scripts, lab.scripts);
  const missingStyles = diff(user.stylesheets, lab.stylesheets);
  const missingHosts = diff(user.hosts, lab.hosts);
  const extraScripts = diff(lab.scripts, user.scripts);
  const smaller = user.bytes > 0 ? 1 - lab.bytes / user.bytes : 0;
  const signals: string[] = [];

  const cloaked =
    missingScripts.length >= 3 ||
    missingHosts.length >= 1 ||
    (smaller >= 0.3 && user.bytes - lab.bytes > 20_000) ||
    user.iframes - lab.iframes >= 1;
  if (cloaked)
    signals.push(
      `The server sends Lighthouse a lighter page than real Chrome users get (${missingScripts.length} scripts, ` +
        `${missingStyles.length} stylesheets, ${missingHosts.length} hosts missing; HTML ${Math.round(smaller * 100)}% smaller). ` +
        'PageSpeed scores this page, not what users load: the lab score is not trustworthy.',
    );
  if (sniffing.length)
    signals.push(
      `${sniffing.length} script snippet(s) read the User-Agent and name a lab testing tool: check whether they skip ` +
        'loading or rendering for Lighthouse (cheat) or are only bot filters in analytics/consent tools (harmless).',
    );
  const ratio = user.executableScripts ? user.delayedScripts / user.executableScripts : 0;
  if (user.delayedScripts >= 5 && ratio >= 0.5)
    signals.push(
      `${user.delayedScripts}/${user.executableScripts} scripts only run after the first user interaction. Lighthouse never ` +
        'interacts, so TBT looks perfect, but the work lands on the first tap/scroll of real users (INP, and CLS when the ' +
        'scripts render content). Measure the first interaction with simulate_session.',
    );

  return {
    source: 'Server HTML fetched twice from the agent host: as real Chrome and as PageSpeed Lighthouse (no JS executed)',
    verdict: cloaked
      ? 'lab-cloaking'
      : sniffing.length
        ? 'ua-sniffing-found'
        : signals.length
          ? 'js-deferred-to-interaction'
          : 'no-gaming-detected',
    realChrome: counts(user),
    lighthouse: counts(lab),
    missingForLighthouse:
      missingScripts.length || missingStyles.length || missingHosts.length
        ? {
            scripts: missingScripts.slice(0, MAX_LISTED),
            stylesheets: missingStyles.slice(0, MAX_LISTED),
            hosts: missingHosts.slice(0, MAX_LISTED),
          }
        : undefined,
    extraForLighthouse: extraScripts.length ? extraScripts.slice(0, MAX_LISTED) : undefined,
    uaSniffing: sniffing.length ? sniffing : undefined,
    delayedJs: user.delayedScripts
      ? {
          delayed: user.delayedScripts,
          executable: user.executableScripts,
          share: `${Math.round(ratio * 100)}%`,
        }
      : undefined,
    signals,
    limits:
      'Cannot see cloaking by Google IP (PSI runs from Google servers) or by JS that checks the UA after load in ' +
      'external scripts not scanned here. A failing CrUX assessment with a lab score ≥ 90 is itself strong evidence.',
  };
}

async function scanScripts(user: Snapshot, finalUrl: string, device: 'mobile' | 'desktop', ctx: ToolContext) {
  const hits = user.inlineScripts.flatMap((code, i) => findUaSniffing(code, `inline script #${i + 1}`));
  const origin = new URL(finalUrl).host;
  const firstParty = user.scripts.filter((k) => k.startsWith(`${origin}/`)).slice(0, MAX_SCRIPT_SCANS);
  for (const key of firstParty) {
    try {
      const res = await fetchPage(`https://${key}`, device, ctx, 1024 * 1024, CHROME_UA[device]);
      if (res.status === 200) hits.push(...findUaSniffing(res.html, key));
    } catch {
      // unreadable script: the HTML comparison still stands
    }
  }
  return hits.slice(0, 6);
}

export const checkLabIntegrity: Tool<z.infer<typeof Input>> = {
  name: 'check_lab_integrity',
  description:
    'Detect "PageSpeed score hacks" that make the lab look good without helping real users: the server sending ' +
    'Lighthouse a lighter page (UA cloaking), scripts that check the User-Agent for Lighthouse/GTmetrix/PTST, and ' +
    '"delay all JS until interaction" setups that hide TBT but move the work onto real users\' first tap. Use it on ' +
    'every site, and always when the lab score is high but the CrUX assessment fails.',
  inputSchema: Input,
  async execute(input, ctx) {
    return memo(ctx, `integrity:${input.device}:${urlKey(input.url)}`, async () => {
      try {
        const userPage = await fetchPage(input.url, input.device, ctx, undefined, CHROME_UA[input.device]);
        const labPage = await fetchPage(input.url, input.device, ctx, undefined, LIGHTHOUSE_UA[input.device]);
        const user = snapshot(userPage);
        const lab = snapshot(labPage);
        const sniffing = await scanScripts(user, userPage.finalUrl, input.device, ctx);
        return analyzeLabIntegrity(user, lab, sniffing);
      } catch (err) {
        fetchFailure(err);
      }
    });
  },
};
