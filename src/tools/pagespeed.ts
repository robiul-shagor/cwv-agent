import { z } from 'zod';
import { fetchJson, HttpError } from '../lib/http.js';
import { attributeUrl } from '../lib/attribution.js';
import { rate, round, truncate, type MetricName } from '../lib/cwv.js';
import { normalizeUrl } from '../lib/url.js';
import { memo, ToolError, type Tool } from './types.js';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

const Input = z.object({
  url: z.string().min(1).describe('Absolute URL of the page to test'),
  strategy: z.enum(['mobile', 'desktop']).default('mobile').describe('Device emulation'),
});

// ── Raw PSI shapes (only the fields we read) ─────────────────────────────────

interface LhAudit {
  id: string;
  title: string;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  numericValue?: number;
  metricSavings?: Record<string, number>;
  details?: Record<string, unknown> & {
    type?: string;
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
  };
}

interface FieldMetric {
  percentile: number;
  category?: string;
  distributions?: Array<{ min: number; max?: number; proportion: number }>;
}

interface FieldExperience {
  id?: string;
  overall_category?: string;
  origin_fallback?: boolean;
  metrics?: Record<string, FieldMetric>;
}

export interface PsiResponse {
  id?: string;
  loadingExperience?: FieldExperience;
  originLoadingExperience?: FieldExperience;
  lighthouseResult?: {
    lighthouseVersion?: string;
    requestedUrl?: string;
    finalUrl?: string;
    finalDisplayedUrl?: string;
    fetchTime?: string;
    runWarnings?: string[];
    runtimeError?: { code?: string; message?: string };
    configSettings?: { formFactor?: string };
    categories?: { performance?: { score: number | null; auditRefs: Array<{ id: string; group?: string }> } };
    audits: Record<string, LhAudit>;
    stackPacks?: Array<{ id: string; title: string }>;
  };
}

// ── Summarisation ────────────────────────────────────────────────────────────

const LAB_METRICS: Array<[string, string]> = [
  ['FCP', 'first-contentful-paint'],
  ['LCP', 'largest-contentful-paint'],
  ['TBT', 'total-blocking-time'],
  ['CLS', 'cumulative-layout-shift'],
  ['SI', 'speed-index'],
  ['TTFB', 'server-response-time'],
];

/** Lighthouse scoring thresholds for lab-only metrics: good ≤ first (p10), poor > second (median). */
const LAB_THRESHOLDS: Record<string, Record<string, [number, number]>> = {
  TBT: { mobile: [200, 600], desktop: [150, 350] },
  SI: { mobile: [3400, 5800], desktop: [1300, 2300] },
};

function rateLab(name: string, value: number, strategy: string) {
  const t = LAB_THRESHOLDS[name]?.[strategy === 'desktop' ? 'desktop' : 'mobile'];
  if (!t) return rate(name as MetricName, value);
  return value <= t[0] ? 'good' : value <= t[1] ? 'needs-improvement' : 'poor';
}

const FIELD_METRICS: Record<string, MetricName> = {
  LARGEST_CONTENTFUL_PAINT_MS: 'LCP',
  INTERACTION_TO_NEXT_PAINT: 'INP',
  CUMULATIVE_LAYOUT_SHIFT_SCORE: 'CLS',
  FIRST_CONTENTFUL_PAINT_MS: 'FCP',
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: 'TTFB',
};

const CATEGORY: Record<string, string> = { FAST: 'good', AVERAGE: 'needs-improvement', SLOW: 'poor' };

/** Audits summarised separately or that never carry actionable signal. */
const SKIP_AUDITS = new Set([
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'speed-index',
  'interactive',
  'max-potential-fid',
  'metrics',
  'screenshot-thumbnails',
  'final-screenshot',
  'main-thread-tasks',
  'long-tasks',
  'bootup-time',
  'mainthread-work-breakdown',
  'diagnostics',
  'network-requests',
  'network-rtt',
  'network-server-latency',
  'script-treemap-data',
  'resource-summary',
]);

const MAX_OPPORTUNITIES = 12;
const MAX_ITEMS = 5;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Depth-first search through Lighthouse `details` trees. */
function walk(value: unknown, visit: (obj: Json) => boolean | void, depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, depth + 1);
  } else if (isObj(value)) {
    if (visit(value) === true) return;
    for (const v of Object.values(value)) walk(v, visit, depth + 1);
  }
}

function summarizeNode(node: Json) {
  return {
    selector: truncate(node.selector, 200),
    snippet: truncate(node.snippet, 300),
    label: truncate(node.nodeLabel, 120),
  };
}

function findFirstNode(details: unknown) {
  let found: Json | undefined;
  walk(details, (o) => {
    if (o.type === 'node' && (o.snippet || o.selector)) {
      found = o;
      return true;
    }
  });
  return found ? summarizeNode(found) : undefined;
}

/** LCP phases: LH ≤12 uses {phase, timing}; LH 13 insights use {subpart, duration}. */
function findLcpPhases(details: unknown) {
  const phases: Array<{ phase: string; ms: number }> = [];
  walk(details, (o) => {
    const name = o.subpart ?? o.phase;
    const ms = o.duration ?? o.timing;
    if (typeof name === 'string' && typeof ms === 'number') {
      phases.push({ phase: typeof o.label === 'string' ? o.label : name, ms: Math.round(ms) });
    }
  });
  return phases.length ? phases : undefined;
}

/** Pulls the first table-ish item list out of an audit and keeps only useful fields. */
function summarizeItems(details: unknown, pageUrl?: string) {
  let items: unknown[] | undefined;
  walk(details, (o) => {
    if (Array.isArray(o.items) && o.items.some((i) => isObj(i) && i.type !== 'table' && i.type !== 'list')) {
      items = o.items;
      return true;
    }
  });
  if (!items) return undefined;

  const rows = items
    .filter(isObj)
    .slice(0, MAX_ITEMS)
    .map((it) => {
      const row: Json = {};
      const url = it.url ?? it.source;
      const rawUrl =
        typeof url === 'string' ? url : isObj(url) && typeof url.url === 'string' ? url.url : undefined;
      if (rawUrl) {
        row.url = truncate(rawUrl, 300);
        const owner = attributeUrl(rawUrl, pageUrl);
        if (owner) row.owner = owner;
      }
      const entity = isObj(it.entity) ? it.entity.text : it.entity;
      if (typeof entity === 'string') row.entity = entity;
      if (isObj(it.node)) row.node = summarizeNode(it.node);
      else if (it.type === 'node') row.node = summarizeNode(it);
      for (const k of [
        'totalBytes',
        'wastedBytes',
        'wastedMs',
        'transferSize',
        'blockingTime',
        'mainThreadTime',
        'duration',
        'score',
        'cacheLifetimeMs',
      ]) {
        if (typeof it[k] === 'number')
          row[k] = k === 'score' ? round(it[k] as number, 'CLS') : Math.round(it[k] as number);
      }
      if (typeof it.label === 'string' && !row.url) row.label = truncate(it.label, 120);
      if (typeof it.groupLabel === 'string') row.group = it.groupLabel;
      return row;
    })
    .filter((r) => Object.keys(r).length > 0);
  return rows.length ? rows : undefined;
}

const num = (v: unknown) => (typeof v === 'number' ? Math.round(v) : undefined);
const itemsOf = (a?: LhAudit) =>
  Array.isArray(a?.details?.items) ? (a.details.items as unknown[]).filter(isObj) : [];
const ownerOf = (v: unknown, pageUrl?: string) =>
  typeof v === 'string' && /^https?:/.test(v) ? attributeUrl(v, pageUrl) : undefined;
const urlOf = (v: unknown) => truncate(typeof v === 'string' ? v : isObj(v) ? v.url : undefined, 200);

/** What blocked the main thread during load: the evidence behind TBT (and the lab proxy for INP input delay). */
function summarizeMainThread(audits: Record<string, LhAudit>, pageUrl?: string) {
  const longTasks = itemsOf(audits['long-tasks']).map((t) => ({
    url: urlOf(t.url),
    owner: ownerOf(t.url, pageUrl),
    startMs: num(t.startTime),
    durationMs: num(t.duration),
  }));
  const scripts = itemsOf(audits['bootup-time'])
    .map((s) => ({
      url: urlOf(s.url),
      owner: ownerOf(s.url, pageUrl),
      totalMs: num(s.total),
      scriptingMs: num(s.scripting),
      parseCompileMs: num(s.scriptParseCompile),
    }))
    .filter((s) => (s.totalMs ?? 0) >= 50);
  const breakdown = itemsOf(audits['mainthread-work-breakdown'])
    .map((g) => ({ group: (g.groupLabel ?? g.group) as string, ms: num(g.duration) }))
    .filter((g) => (g.ms ?? 0) >= 50);
  const thirdParties = itemsOf(audits['third-party-summary'] ?? audits['third-parties-insight'])
    .map((t) => ({
      entity: (isObj(t.entity) ? t.entity.text : t.entity) as string | undefined,
      blockingMs: num(t.blockingTime),
      mainThreadMs: num(t.mainThreadTime),
    }))
    .filter((t) => t.entity && ((t.blockingMs ?? 0) > 0 || (t.mainThreadMs ?? 0) >= 50));
  if (!longTasks.length && !scripts.length && !breakdown.length) return undefined;
  return {
    totalMainThreadMs: num(audits['mainthread-work-breakdown']?.numericValue),
    totalScriptMs: num(audits['bootup-time']?.numericValue),
    longTaskCount: longTasks.length || undefined,
    longestTasks: longTasks.length
      ? [...longTasks].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, MAX_ITEMS)
      : undefined,
    heaviestScripts: scripts.length ? scripts.slice(0, MAX_ITEMS) : undefined,
    workByType: breakdown.length ? breakdown.slice(0, 6) : undefined,
    thirdPartyBlocking: thirdParties.length ? thirdParties.slice(0, MAX_ITEMS) : undefined,
    domElements: num(audits['dom-size']?.numericValue ?? audits['dom-size-insight']?.numericValue),
  };
}

function impact(a: LhAudit): number {
  const s = a.metricSavings ?? {};
  return (
    (s.LCP ?? 0) +
    (s.FCP ?? 0) * 0.5 +
    (s.TBT ?? 0) +
    (s.INP ?? 0) +
    (s.CLS ?? 0) * 10_000 +
    (a.details?.overallSavingsMs ?? 0) * 0.1
  );
}

function summarizeField(exp: FieldExperience | undefined) {
  if (!exp?.metrics || Object.keys(exp.metrics).length === 0) return { hasData: false as const };
  const metrics: Json = {};
  for (const [key, name] of Object.entries(FIELD_METRICS)) {
    const m = exp.metrics[key];
    if (!m) continue;
    const p75 = name === 'CLS' ? m.percentile / 100 : m.percentile;
    metrics[name] = {
      p75: round(p75, name),
      rating: m.category ? (CATEGORY[m.category] ?? rate(name, p75)) : rate(name, p75),
      distribution: m.distributions?.map((d) => Math.round(d.proportion * 100) + '%').join(' / '),
    };
  }
  return {
    hasData: true as const,
    scope: exp.origin_fallback ? 'origin (no URL-level data)' : 'url',
    overall: exp.overall_category ? CATEGORY[exp.overall_category] : undefined,
    metrics,
  };
}

export function summarizePsi(res: PsiResponse, strategy: string) {
  const lh = res.lighthouseResult;
  if (!lh) throw new ToolError('PSI response did not include a Lighthouse result');
  if (lh.runtimeError?.code && lh.runtimeError.code !== 'NO_ERROR') {
    throw new ToolError(`Lighthouse failed: ${lh.runtimeError.code} ${lh.runtimeError.message ?? ''}`.trim());
  }
  const audits = lh.audits ?? {};
  const pageUrl = lh.finalDisplayedUrl ?? lh.finalUrl ?? lh.requestedUrl ?? res.id;

  const lab: Json = {};
  for (const [name, id] of LAB_METRICS) {
    const a = audits[id];
    if (typeof a?.numericValue !== 'number') continue;
    const value = round(a.numericValue, name);
    lab[name] = { value, rating: rateLab(name, value, strategy) };
  }

  const lcpAudit = audits['lcp-breakdown-insight'] ?? audits['largest-contentful-paint-element'];
  const lcpDiscovery = audits['lcp-discovery-insight'];
  const lcpElement = {
    node: findFirstNode(lcpAudit?.details) ?? findFirstNode(lcpDiscovery?.details),
    phases:
      findLcpPhases(audits['lcp-breakdown-insight']?.details) ??
      findLcpPhases(audits['largest-contentful-paint-element']?.details),
    lazyLoaded: audits['lcp-lazy-loaded'] ? audits['lcp-lazy-loaded'].score === 0 : undefined,
    discoveryIssues:
      lcpDiscovery && lcpDiscovery.score !== null && lcpDiscovery.score < 1
        ? summarizeItems(lcpDiscovery.details, pageUrl)
        : undefined,
  };

  const clsAudit = audits['cls-culprits-insight'] ?? audits['layout-shifts'];
  const layoutShifts = clsAudit ? summarizeItems(clsAudit.details, pageUrl) : undefined;

  const refs = lh.categories?.performance?.auditRefs ?? Object.keys(audits).map((id) => ({ id }));
  const opportunities = refs
    .map((r) => audits[r.id])
    .filter((a): a is LhAudit => !!a && !SKIP_AUDITS.has(a.id))
    .filter((a) => !['notApplicable', 'manual', 'error'].includes(a.scoreDisplayMode))
    .filter((a) => a.score !== null && a.score < 0.9)
    .sort((a, b) => impact(b) - impact(a))
    .slice(0, MAX_OPPORTUNITIES)
    .map((a) => {
      const savings = Object.fromEntries(
        Object.entries(a.metricSavings ?? {})
          .filter(([, v]) => v > 0)
          .map(([k, v]) => [k, round(v, k)]),
      );
      return {
        id: a.id,
        title: a.title,
        score: a.score,
        displayValue: truncate(a.displayValue, 120),
        metricSavings: Object.keys(savings).length ? savings : undefined,
        savingsBytes: a.details?.overallSavingsBytes ? Math.round(a.details.overallSavingsBytes) : undefined,
        items: summarizeItems(a.details, pageUrl),
      };
    });

  const renderBlocking = audits['render-blocking-insight'] ?? audits['render-blocking-resources'];
  const thirdParty = audits['third-parties-insight'] ?? audits['third-party-summary'];

  return {
    source: 'PageSpeed Insights (Lighthouse lab + CrUX field)',
    strategy,
    url: pageUrl,
    lighthouseVersion: lh.lighthouseVersion,
    fetchTime: lh.fetchTime,
    performanceScore:
      typeof lh.categories?.performance?.score === 'number'
        ? Math.round(lh.categories.performance.score * 100)
        : null,
    labMetrics: lab,
    note:
      'Lab data cannot measure INP; TBT is the lab proxy. TBT and SI are lab-only (Lighthouse score weights: ' +
      'TBT 30%, LCP 25%, CLS 25%, FCP 10%, SI 10%) and are not part of the Core Web Vitals assessment.',
    lcpElement,
    mainThread: summarizeMainThread(audits, pageUrl),
    layoutShifts,
    renderBlocking: renderBlocking ? summarizeItems(renderBlocking.details, pageUrl) : undefined,
    thirdParties: thirdParty ? summarizeItems(thirdParty.details, pageUrl) : undefined,
    opportunities,
    detectedStack: lh.stackPacks?.map((s) => s.title),
    fieldData: {
      page: summarizeField(res.loadingExperience),
      origin: summarizeField(res.originLoadingExperience),
    },
    warnings: lh.runWarnings?.length ? lh.runWarnings.map((w) => truncate(w, 200)) : undefined,
  };
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const runPagespeed: Tool<z.infer<typeof Input>> = {
  name: 'run_pagespeed',
  description:
    'Run a PageSpeed Insights (Lighthouse) lab test on a URL. Returns lab metrics (LCP, CLS, TBT, FCP, SI, TTFB) with ratings, ' +
    'the LCP element and its phase breakdown, main-thread evidence behind TBT (longest tasks, heaviest scripts, work by type, ' +
    'third-party blocking time, DOM size), layout-shift culprits, render-blocking resources, third parties, ' +
    'top failing opportunities with estimated savings, detected stack, and the CrUX field data embedded in the PSI response. ' +
    'Takes 20-60s. Call once per strategy; results are cached for the run.',
  inputSchema: Input,
  async execute(input, ctx) {
    const url = normalizeUrl(input.url).toString();
    // PSI's "Lighthouse returned error" 500s are intermittent on Google's side and each costs ~60 s: retry here,
    // and if it still fails, cache the failure so the agent moves on instead of spending minutes re-calling it.
    return memo(
      ctx,
      `psi:${input.strategy}:${url}`,
      async () => {
        const qs = new URLSearchParams({
          url,
          strategy: input.strategy.toUpperCase(),
          category: 'PERFORMANCE',
        });
        if (ctx.googleApiKey) qs.set('key', ctx.googleApiKey);
        else ctx.logger.warn('GOOGLE_API_KEY not set — PSI will use the tiny anonymous quota');
        try {
          const res = await fetchJson<PsiResponse>(
            `${PSI_ENDPOINT}?${qs}`,
            {},
            {
              // 3 × 80 s stays inside the loop's hard tool timeout (3 × TOOL_TIMEOUT_MS).
              timeoutMs: 80_000,
              attempts: 3,
              baseDelayMs: 2000,
              signal: ctx.signal,
            },
          );
          return summarizePsi(res, input.strategy);
        } catch (err) {
          if (err instanceof HttpError)
            throw new ToolError(
              `${err.message} (failed after 3 attempts; usually a temporary Google-side Lighthouse failure). Do not call ` +
                'run_pagespeed again in this run: use simulate_session for lab evidence (LCP element, layout shifts, long ' +
                'tasks/scripts) and CrUX for field data, and note the missing PSI lab audit in dataGaps.',
            );
          throw err;
        }
      },
      { cacheErrors: true },
    );
  },
};
