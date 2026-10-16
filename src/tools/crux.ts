import { z } from 'zod';
import { fetchJson, HttpError } from '../lib/http.js';
import { rate, round, type MetricName } from '../lib/cwv.js';
import { normalizeUrl } from '../lib/url.js';
import { memo, ToolError, type Tool, type ToolContext } from './types.js';

const CRUX_BASE = 'https://chromeuxreport.googleapis.com/v1/records';

const Input = z.object({
  url: z.string().min(1).describe('Page URL (its origin is derived automatically when scope=origin)'),
  scope: z
    .enum(['url', 'origin'])
    .default('url')
    .describe(
      '"url" for this exact page, "origin" for the whole site. Small pages often only have origin data.',
    ),
  device: z.enum(['mobile', 'desktop']).default('mobile'),
});
type Input = z.infer<typeof Input>;

const HistoryInput = Input.extend({
  weeks: z.number().int().min(4).max(40).default(12).describe('Number of weekly collection periods (max 40)'),
});

/** CrUX metric keys → our names. LCP subparts are included when available. */
const METRICS: Record<string, MetricName | string> = {
  largest_contentful_paint: 'LCP',
  interaction_to_next_paint: 'INP',
  cumulative_layout_shift: 'CLS',
  first_contentful_paint: 'FCP',
  experimental_time_to_first_byte: 'TTFB',
  largest_contentful_paint_image_time_to_first_byte: 'LCP.ttfb',
  largest_contentful_paint_image_resource_load_delay: 'LCP.resourceLoadDelay',
  largest_contentful_paint_image_resource_load_duration: 'LCP.resourceLoadDuration',
  largest_contentful_paint_image_element_render_delay: 'LCP.elementRenderDelay',
  // Network round-trip time of real users: high RTT inflates TTFB/LCP regardless of the server.
  round_trip_time: 'RTT',
};
const RATED = new Set(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);

interface CruxDate {
  year: number;
  month: number;
  day: number;
}
interface CruxPeriod {
  firstDate: CruxDate;
  lastDate: CruxDate;
}

export interface CruxRecordResponse {
  record?: {
    key?: Record<string, string>;
    metrics?: Record<
      string,
      {
        histogram?: Array<{ start: number | string; end?: number | string; density?: number }>;
        percentiles?: { p75: number | string };
        fractions?: Record<string, number>;
      }
    >;
    collectionPeriod?: CruxPeriod;
  };
}

export interface CruxHistoryResponse {
  record?: {
    metrics?: Record<
      string,
      {
        percentilesTimeseries?: { p75s?: Array<number | string | null> };
      }
    >;
    collectionPeriods?: CruxPeriod[];
  };
}

const fmtDate = (d?: CruxDate) =>
  d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : undefined;

const pct = (n?: number) => (typeof n === 'number' ? Math.round(n * 100) + '%' : '?');

function target(input: Input) {
  const url = normalizeUrl(input.url);
  return input.scope === 'origin' ? { origin: url.origin } : { url: url.toString() };
}

function formFactor(device: Input['device']) {
  return device === 'desktop' ? 'DESKTOP' : 'PHONE';
}

async function queryCrux<T>(ctx: ToolContext, endpoint: string, body: object): Promise<T | null> {
  if (!ctx.googleApiKey) throw new ToolError('GOOGLE_API_KEY is not configured; CrUX API is unavailable.');
  try {
    return await fetchJson<T>(
      `${CRUX_BASE}:${endpoint}?key=${encodeURIComponent(ctx.googleApiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { timeoutMs: Math.min(ctx.timeoutMs, 30_000), attempts: 3, signal: ctx.signal },
    );
  } catch (err) {
    // 404 = not enough Chrome traffic for this URL/origin.
    if (err instanceof HttpError && err.status === 404) return null;
    if (err instanceof HttpError) throw new ToolError(err.message);
    throw err;
  }
}

/**
 * Google's Core Web Vitals assessment: passes only when every core metric with data is "good" at p75.
 * Metrics without enough data are skipped (as PSI does).
 */
export function assess(metrics: Record<string, unknown>) {
  const core = (['LCP', 'INP', 'CLS'] as const).filter((m) => metrics[m]);
  if (!core.length) return { result: 'no-data' as const, failing: [], noData: ['LCP', 'INP', 'CLS'] };
  const failing = core.filter((m) => (metrics[m] as { rating?: string }).rating !== 'good');
  return {
    result: failing.length ? ('failed' as const) : ('passed' as const),
    failing,
    noData: (['LCP', 'INP', 'CLS'] as const).filter((m) => !metrics[m]),
  };
}

export function summarizeCrux(res: CruxRecordResponse, input: Input) {
  const metrics: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(METRICS)) {
    const m = res.record?.metrics?.[key];
    if (m?.percentiles?.p75 === undefined) continue;
    const p75 = round(Number(m.percentiles.p75), name);
    const entry: Record<string, unknown> = { p75 };
    if (RATED.has(name)) {
      entry.rating = rate(name as MetricName, p75);
      const [g, ni, p] = m.histogram ?? [];
      entry.distribution = `good ${pct(g?.density)} / NI ${pct(ni?.density)} / poor ${pct(p?.density)}`;
    }
    metrics[name] = entry;
  }
  const lcpType = res.record?.metrics?.largest_contentful_paint_resource_type?.fractions;
  const nav = res.record?.metrics?.navigation_types?.fractions;
  return {
    source: 'CrUX API (28-day rolling field data, p75)',
    hasData: true,
    scope: input.scope,
    device: input.device,
    assessment: assess(metrics),
    target: res.record?.key?.url ?? res.record?.key?.origin,
    collectionPeriod: {
      from: fmtDate(res.record?.collectionPeriod?.firstDate),
      to: fmtDate(res.record?.collectionPeriod?.lastDate),
    },
    metrics,
    lcpResourceType: lcpType
      ? Object.fromEntries(Object.entries(lcpType).map(([k, v]) => [k, pct(v)]))
      : undefined,
    navigationTypes: nav
      ? Object.fromEntries(
          Object.entries(nav)
            .filter(([, v]) => v >= 0.01)
            .map(([k, v]) => [k, pct(v)]),
        )
      : undefined,
  };
}

export function summarizeCruxHistory(res: CruxHistoryResponse, input: Input) {
  const periods = res.record?.collectionPeriods ?? [];
  const metrics: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(METRICS)) {
    if (!RATED.has(name)) continue;
    const series = res.record?.metrics?.[key]?.percentilesTimeseries?.p75s;
    if (!series?.length) continue;
    const values = series.map((v) => (v === null || v === undefined ? null : round(Number(v), name)));
    const present = values.filter((v): v is number => v !== null);
    if (!present.length) continue;
    const first = present[0]!;
    const last = present.at(-1)!;
    metrics[name] = {
      weeklyP75: values,
      first,
      latest: last,
      latestRating: rate(name as MetricName, last),
      change: round(last - first, name),
      trend: Math.abs(last - first) / (first || 1) < 0.05 ? 'flat' : last < first ? 'improving' : 'worsening',
    };
  }
  return {
    source: 'CrUX History API (weekly 28-day windows, p75)',
    hasData: true,
    scope: input.scope,
    device: input.device,
    weeks: periods.length,
    periodEnds: periods.map((p) => fmtDate(p.lastDate)),
    metrics,
  };
}

const noData = (input: Input) => ({
  hasData: false,
  scope: input.scope,
  device: input.device,
  message:
    input.scope === 'url'
      ? 'No CrUX data for this URL (insufficient traffic). Try scope="origin".'
      : 'No CrUX data for this origin (insufficient Chrome traffic). Rely on lab data.',
});

export const getCrux: Tool<Input> = {
  name: 'get_crux',
  description:
    'Get real-user Core Web Vitals from the Chrome UX Report (what Google ranks on): p75 LCP, INP, CLS, FCP, TTFB with ' +
    'good/NI/poor distributions, LCP subpart p75s (TTFB, resource load delay/duration, render delay), LCP resource type, ' +
    "navigation types (back_forward / prerender share), users' network round-trip time (RTT p75) and `assessment` — Google's Core Web Vitals pass/fail verdict. " +
    'Returns hasData=false when the URL/origin lacks traffic.',
  inputSchema: Input,
  async execute(input, ctx) {
    const body = { ...target(input), formFactor: formFactor(input.device) };
    return memo(ctx, `crux:${JSON.stringify(body)}`, async () => {
      const res = await queryCrux<CruxRecordResponse>(ctx, 'queryRecord', body);
      return res ? summarizeCrux(res, input) : noData(input);
    });
  },
};

export const getCruxHistory: Tool<z.infer<typeof HistoryInput>> = {
  name: 'get_crux_history',
  description:
    'Get the weekly p75 trend for LCP, INP, CLS, FCP, TTFB from the CrUX History API. Use it to tell whether a metric ' +
    'recently regressed or is improving, and when a change happened.',
  inputSchema: HistoryInput,
  async execute(input, ctx) {
    const body = {
      ...target(input),
      formFactor: formFactor(input.device),
      collectionPeriodCount: input.weeks,
    };
    return memo(ctx, `cruxh:${JSON.stringify(body)}`, async () => {
      const res = await queryCrux<CruxHistoryResponse>(ctx, 'queryHistoryRecord', body);
      return res ? summarizeCruxHistory(res, input) : noData(input);
    });
  },
};
