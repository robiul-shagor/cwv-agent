export type Rating = 'good' | 'needs-improvement' | 'poor';

/** Core Web Vitals thresholds (good ≤ first, poor > second). Times in ms, CLS unitless. */
export const THRESHOLDS = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
  TBT: [200, 600],
} as const;

export type MetricName = keyof typeof THRESHOLDS;

export function rate(metric: MetricName, value: number): Rating {
  const [good, poor] = THRESHOLDS[metric];
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}

export function round(value: number, metric?: MetricName | string): number {
  return metric === 'CLS' ? Math.round(value * 1000) / 1000 : Math.round(value);
}

export function truncate(s: unknown, max = 160): string | undefined {
  if (typeof s !== 'string') return undefined;
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}
