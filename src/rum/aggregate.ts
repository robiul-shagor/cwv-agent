import { attributeUrl } from '../lib/attribution.js';
import { rate, round } from '../lib/cwv.js';
import type { RumRecord } from './store.js';

/** Below this many samples a p75 is too noisy to act on. */
export const MIN_SAMPLES = 50;

/** CrUX-style p75: nearest-rank on the sorted values. */
export function p75(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.75 * s.length) - 1)];
}

const median = (v: number[]) => {
  if (!v.length) return undefined;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) + '%' : '0%');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const attr = (r: RumRecord) => (r.attribution ?? {}) as Record<string, unknown>;

/** Groups records by a key and ranks groups by how much they contribute to non-good experiences. */
function topBy<T>(
  records: RumRecord[],
  key: (r: RumRecord) => string | undefined,
  describe: (rs: RumRecord[]) => T,
  max = 5,
) {
  const groups = new Map<string, RumRecord[]>();
  for (const r of records) {
    const k = key(r);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const bad = records.filter((r) => r.rating !== 'good').length;
  return [...groups.entries()]
    .map(([k, rs]) => ({ k, rs, bad: rs.filter((r) => r.rating !== 'good').length }))
    .sort((a, b) => b.bad - a.bad || b.rs.length - a.rs.length)
    .slice(0, max)
    .map(({ k, rs, bad: b }) => ({
      key: k,
      samples: rs.length,
      shareOfBadVisits: pct(b, bad),
      ...describe(rs),
    }));
}

function metricSummary(rs: RumRecord[], name: RumRecord['name']) {
  const values = rs.map((r) => r.value);
  const v = p75(values);
  if (v === undefined) return undefined;
  const p = round(v, name);
  const good = rs.filter((r) => r.rating === 'good').length;
  const poor = rs.filter((r) => r.rating === 'poor').length;
  return {
    p75: p,
    rating: rate(name, p),
    samples: rs.length,
    distribution: `good ${pct(good, rs.length)} / NI ${pct(rs.length - good - poor, rs.length)} / poor ${pct(poor, rs.length)}`,
    lowSample: rs.length < MIN_SAMPLES || undefined,
  };
}

function summarizeDevice(records: RumRecord[], pageUrl: string) {
  const of = (n: RumRecord['name']) => records.filter((r) => r.name === n);
  const lcp = of('LCP');
  const inp = of('INP');
  const cls = of('CLS');
  const ttfb = of('TTFB');
  const navTypes = new Map<string, number>();
  for (const r of lcp) navTypes.set(r.navigationType, (navTypes.get(r.navigationType) ?? 0) + 1);

  return {
    pageViews: lcp.length || Math.max(cls.length, ttfb.length),
    metrics: {
      LCP: metricSummary(lcp, 'LCP'),
      INP: metricSummary(inp, 'INP'),
      CLS: metricSummary(cls, 'CLS'),
      FCP: metricSummary(of('FCP'), 'FCP'),
      TTFB: metricSummary(ttfb, 'TTFB'),
    },
    navigationTypes: Object.fromEntries([...navTypes.entries()].map(([k, n]) => [k, pct(n, lcp.length)])),
    cls: {
      topShiftElements: topBy(
        cls.filter((r) => r.value > 0),
        (r) => str(attr(r).largestShiftTarget) ?? '(unknown element)',
        (rs) => ({
          p75Cls: round(p75(rs.map((r) => r.value)) ?? 0, 'CLS'),
          whenShifted: Object.fromEntries(
            [...new Set(rs.map((r) => str(attr(r).loadState) ?? 'unknown'))].map((s) => [
              s,
              pct(rs.filter((r) => (str(attr(r).loadState) ?? 'unknown') === s).length, rs.length),
            ]),
          ),
          medianShiftTimeMs: median(
            rs.map((r) => num(attr(r).largestShiftTime)).filter((n): n is number => n !== undefined),
          ),
        }),
      ),
    },
    inp: {
      topInteractions: topBy(
        inp,
        (r) => {
          // The target is lost when the handler removed it; the handler that ran still identifies the control.
          const a = attr(r);
          const invoker = str(((a.longestScript ?? {}) as Record<string, unknown>).invoker);
          const target =
            str(a.interactionTarget) ?? (invoker ? `(target removed; handler ${invoker})` : '(unknown)');
          return `${str(a.interactionType) ?? 'interaction'} on ${target}`;
        },
        (rs) => {
          const a = rs.map(attr);
          const scripts = new Map<string, { n: number; ms: number[]; invoker?: string }>();
          for (const x of a) {
            const s = (x.longestScript ?? {}) as Record<string, unknown>;
            const url = str(s.sourceURL);
            if (!url) continue;
            const e = scripts.get(url) ?? { n: 0, ms: [], invoker: str(s.invoker) };
            e.n++;
            const d = num(s.intersectingDuration);
            if (d !== undefined) e.ms.push(d);
            scripts.set(url, e);
          }
          const m = (k: string) =>
            median(a.map((x) => num(x[k])).filter((n): n is number => n !== undefined));
          return {
            p75Ms: p75(rs.map((r) => r.value)),
            median: {
              inputDelay: m('inputDelay'),
              processing: m('processingDuration'),
              presentation: m('presentationDelay'),
            },
            duringLoad: pct(a.filter((x) => x.loadState !== 'complete').length, a.length),
            topScripts: [...scripts.entries()]
              .sort((x, y) => y[1].n - x[1].n)
              .slice(0, 3)
              .map(([url, v]) => ({
                url,
                owner: attributeUrl(url, pageUrl),
                seenIn: v.n,
                medianMs: median(v.ms),
                invoker: v.invoker,
              })),
          };
        },
      ),
    },
    lcp: {
      topElements: topBy(
        lcp,
        (r) => str(attr(r).target) ?? '(unknown element)',
        (rs) => {
          const m = (k: string) =>
            median(rs.map((r) => num(attr(r)[k])).filter((n): n is number => n !== undefined));
          const urls = rs.map((r) => str(attr(r).url)).filter(Boolean);
          return {
            p75Ms: p75(rs.map((r) => r.value)),
            medianSubpartsMs: {
              ttfb: m('timeToFirstByte'),
              resourceLoadDelay: m('resourceLoadDelay'),
              resourceLoadDuration: m('resourceLoadDuration'),
              elementRenderDelay: m('elementRenderDelay'),
            },
            resource: urls[0],
          };
        },
        3,
      ),
    },
  };
}

/**
 * Agent-facing RUM summary per device: p75 + rating per metric (like CrUX), and the attribution CrUX lacks:
 * which elements shift, which interactions/scripts are slow, which LCP elements and phases dominate.
 */
export function summarizeRum(
  records: RumRecord[],
  opts: { pageUrl: string; days: number; scope: 'page' | 'site' },
) {
  const devices = ['mobile', 'desktop', 'tablet'] as const;
  const byDevice = Object.fromEntries(
    devices
      .map((d) => [d, records.filter((r) => r.device === d)] as const)
      .filter(([, rs]) => rs.length > 0)
      .map(([d, rs]) => [d, summarizeDevice(rs, opts.pageUrl)]),
  );

  // Worst pages (site scope only): where to look first.
  let worstPages: unknown;
  if (opts.scope === 'site') {
    const paths = new Map<string, RumRecord[]>();
    for (const r of records) {
      try {
        const p = new URL(r.url).pathname;
        const g = paths.get(p);
        if (g) g.push(r);
        else paths.set(p, [r]);
      } catch {
        /* ignore */
      }
    }
    worstPages = (['LCP', 'INP', 'CLS'] as const).map((name) => ({
      metric: name,
      pages: [...paths.entries()]
        .map(([path, rs]) => ({ path, rs: rs.filter((r) => r.name === name) }))
        .filter((x) => x.rs.length >= 20)
        .map((x) => ({
          path: x.path,
          p75: round(p75(x.rs.map((r) => r.value))!, name),
          samples: x.rs.length,
        }))
        .sort((a, b) => b.p75 - a.p75)
        .slice(0, 5),
    }));
  }

  return {
    source: `Own RUM (web-vitals attribution, all browsers that support each metric), last ${opts.days} days, p75`,
    scope: opts.scope,
    note:
      'CrUX decides the assessment; use RUM for attribution (which element / interaction / script). ' +
      `Treat metrics with lowSample (< ${MIN_SAMPLES} samples) as indicative.`,
    devices: byDevice,
    worstPages,
  };
}
