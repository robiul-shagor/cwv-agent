/**
 * DOM-free payload logic for the RUM client: shared by the browser bundle, the (future) /api/rum
 * endpoint and tests. Inputs are typed structurally so this compiles without DOM types.
 */

export const RUM_PAYLOAD_VERSION = 1;

export type MetricName = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
export type Device = 'mobile' | 'tablet' | 'desktop';

export interface RumMetric {
  name: MetricName;
  /** Unique per metric per page view. A metric may be re-sent with a newer value; keep the latest per id. */
  id: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  navigationType: string;
  attribution?: Record<string, string | number | Record<string, string | number>>;
}

export interface RumPayload {
  v: typeof RUM_PAYLOAD_VERSION;
  key: string;
  url: string;
  device: Device;
  connection?: string;
  metrics: RumMetric[];
}

/** Structural subset of web-vitals' `Metric` (+ attribution) that we read. */
export interface VitalsMetricLike {
  name: string;
  id: string;
  value: number;
  rating: string;
  navigationType: string;
  attribution?: object;
}

const MAX_STR = 200;

function str(v: unknown, max = MAX_STR): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return v.length > max ? v.slice(0, max - 1) + '…' : v;
}

function ms(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
}

/** Removes query strings/fragments embedded in free text (script invokers, selectors). */
function stripQueries(v: string | undefined): string | undefined {
  return v?.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1');
}

/**
 * Keeps origin + path only (query strings often carry PII: emails, tokens, search terms).
 * `keepParams` allow-lists query parameters that are safe and useful (e.g. "page").
 */
export function sanitizeUrl(input: unknown, keepParams: readonly string[] = []): string | undefined {
  if (typeof input !== 'string' || input === '') return undefined;
  try {
    const url = new URL(input);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return `${url.protocol}…`;
    const kept = new URLSearchParams();
    for (const p of keepParams) {
      const value = url.searchParams.get(p);
      if (value !== null) kept.set(p, value);
    }
    const qs = kept.toString();
    return str(`${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`, 300);
  } catch {
    return undefined;
  }
}

function compact<T extends Record<string, unknown>>(
  obj: T,
): Record<string, string | number | Record<string, string | number>> {
  const out: Record<string, string | number | Record<string, string | number>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      const nested = compact(v as Record<string, unknown>) as Record<string, string | number>;
      if (Object.keys(nested).length) out[k] = nested;
    } else if (typeof v === 'string' || typeof v === 'number') {
      out[k] = v;
    }
  }
  return out;
}

/** Reduces web-vitals attribution (which holds DOM nodes and perf entries) to small JSON. */
export function compactAttribution(name: string, attr: object | undefined) {
  const a = attr as Record<string, unknown> | undefined;
  if (!a) return undefined;
  switch (name) {
    case 'LCP':
      return compact({
        target: str(a.target),
        url: sanitizeUrl(a.url),
        timeToFirstByte: ms(a.timeToFirstByte),
        resourceLoadDelay: ms(a.resourceLoadDelay),
        resourceLoadDuration: ms(a.resourceLoadDuration),
        elementRenderDelay: ms(a.elementRenderDelay),
      });
    case 'INP': {
      const longest = a.longestScript as
        { entry?: Record<string, unknown>; subpart?: string; intersectingDuration?: number } | undefined;
      const entry = longest?.entry;
      return compact({
        interactionTarget: str(a.interactionTarget),
        interactionType: str(a.interactionType),
        inputDelay: ms(a.inputDelay),
        processingDuration: ms(a.processingDuration),
        presentationDelay: ms(a.presentationDelay),
        loadState: str(a.loadState),
        totalScriptDuration: ms(a.totalScriptDuration),
        totalStyleAndLayoutDuration: ms(a.totalStyleAndLayoutDuration),
        totalPaintDuration: ms(a.totalPaintDuration),
        totalUnattributedDuration: ms(a.totalUnattributedDuration),
        longestScript: entry
          ? {
              sourceURL: sanitizeUrl(entry.sourceURL),
              sourceFunctionName: str(entry.sourceFunctionName, 100),
              invokerType: str(entry.invokerType, 40),
              invoker: stripQueries(str(entry.invoker)),
              subpart: str(longest?.subpart, 40),
              intersectingDuration: ms(longest?.intersectingDuration),
            }
          : undefined,
      });
    }
    case 'CLS':
      return compact({
        largestShiftTarget: str(a.largestShiftTarget),
        largestShiftValue:
          typeof a.largestShiftValue === 'number' ? Math.round(a.largestShiftValue * 1000) / 1000 : undefined,
        largestShiftTime: ms(a.largestShiftTime),
        loadState: str(a.loadState),
      });
    case 'FCP':
      return compact({
        timeToFirstByte: ms(a.timeToFirstByte),
        firstByteToFCP: ms(a.firstByteToFCP),
        loadState: str(a.loadState),
      });
    case 'TTFB':
      return compact({
        waitingDuration: ms(a.waitingDuration),
        cacheDuration: ms(a.cacheDuration),
        dnsDuration: ms(a.dnsDuration),
        connectionDuration: ms(a.connectionDuration),
        requestDuration: ms(a.requestDuration),
      });
    default:
      return undefined;
  }
}

const NAMES = new Set<MetricName>(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);

export function toRumMetric(m: VitalsMetricLike): RumMetric | null {
  if (!NAMES.has(m.name as MetricName) || !Number.isFinite(m.value)) return null;
  const name = m.name as MetricName;
  const attribution = compactAttribution(name, m.attribution);
  return {
    name,
    id: str(m.id, 100) ?? '',
    value: name === 'CLS' ? Math.round(m.value * 10_000) / 10_000 : Math.round(m.value),
    rating: m.rating as RumMetric['rating'],
    navigationType: m.navigationType,
    ...(attribution && Object.keys(attribution).length ? { attribution } : {}),
  };
}

/** Mirrors CrUX form factors (PHONE / TABLET / DESKTOP) from the user agent. */
export function detectDevice(userAgent: string, uaDataMobile?: boolean): Device {
  if (uaDataMobile === true) return 'mobile';
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobi)/i.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Opera Mini|IEMobile/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

/** One decision per page view so all metrics of a view are kept or dropped together. */
export function isSampled(sampleRate: number, random: number = Math.random()): boolean {
  if (!(sampleRate > 0)) return false;
  return sampleRate >= 1 || random < sampleRate;
}
