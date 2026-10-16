/* eslint-disable @typescript-eslint/no-explicit-any -- loose access into summarised JSON */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assess, getCrux, getCruxHistory } from '../src/tools/crux.js';
import { ToolError } from '../src/tools/types.js';
import { ctx, jsonResponse } from './helpers.js';

const record = {
  record: {
    key: { url: 'https://example.com/', formFactor: 'PHONE' },
    metrics: {
      largest_contentful_paint: {
        histogram: [
          { start: 0, end: 2500, density: 0.6 },
          { start: 2500, end: 4000, density: 0.25 },
          { start: 4000, density: 0.15 },
        ],
        percentiles: { p75: 3100 },
      },
      cumulative_layout_shift: {
        histogram: [
          { start: '0.00', end: '0.10', density: 0.9 },
          { start: '0.10', end: '0.25', density: 0.06 },
          { start: '0.25', density: 0.04 },
        ],
        percentiles: { p75: '0.05' },
      },
      largest_contentful_paint_image_resource_load_delay: { percentiles: { p75: 900 } },
      largest_contentful_paint_resource_type: { fractions: { image: 0.8, text: 0.2 } },
    },
    collectionPeriod: {
      firstDate: { year: 2026, month: 9, day: 1 },
      lastDate: { year: 2026, month: 9, day: 28 },
    },
  },
};

describe('get_crux', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('summarises p75s, ratings, distributions and LCP subparts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(record));
    vi.stubGlobal('fetch', fetchMock);
    const s = (await getCrux.execute(
      { url: 'https://example.com/', scope: 'url', device: 'mobile' },
      ctx(),
    )) as Record<string, any>;
    expect(s.metrics.LCP).toEqual({
      p75: 3100,
      rating: 'needs-improvement',
      distribution: 'good 60% / NI 25% / poor 15%',
    });
    expect(s.metrics.CLS).toMatchObject({ p75: 0.05, rating: 'good' });
    expect(s.metrics['LCP.resourceLoadDelay']).toEqual({ p75: 900 });
    expect(s.lcpResourceType).toEqual({ image: '80%', text: '20%' });
    expect(s.collectionPeriod).toEqual({ from: '2026-09-01', to: '2026-09-28' });
    expect(s.assessment).toEqual({ result: 'failed', failing: ['LCP'], noData: ['INP'] });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({ url: 'https://example.com/', formFactor: 'PHONE' });
  });

  it('uses origin scope and returns hasData=false on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'not found' } }, 404));
    vi.stubGlobal('fetch', fetchMock);
    const s = (await getCrux.execute(
      { url: 'https://example.com/a/b', scope: 'origin', device: 'desktop' },
      ctx(),
    )) as Record<string, any>;
    expect(s.hasData).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      origin: 'https://example.com',
      formFactor: 'DESKTOP',
    });
  });

  it('fails clearly without an API key', async () => {
    await expect(
      getCrux.execute(
        { url: 'https://example.com', scope: 'url', device: 'mobile' },
        ctx({ googleApiKey: undefined }),
      ),
    ).rejects.toThrow(ToolError);
  });
});

describe('get_crux_history', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('computes trend from weekly p75s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          record: {
            metrics: {
              largest_contentful_paint: { percentilesTimeseries: { p75s: [null, 4000, 3500, 3000] } },
              cumulative_layout_shift: { percentilesTimeseries: { p75s: ['0.05', '0.05', '0.30', '0.31'] } },
            },
            collectionPeriods: [1, 2, 3, 4].map((d) => ({
              firstDate: { year: 2026, month: 8, day: d },
              lastDate: { year: 2026, month: 9, day: d },
            })),
          },
        }),
      ),
    );
    const s = (await getCruxHistory.execute(
      { url: 'https://example.com', scope: 'url', device: 'mobile', weeks: 4 },
      ctx(),
    )) as Record<string, any>;
    expect(s.metrics.LCP).toMatchObject({
      first: 4000,
      latest: 3000,
      trend: 'improving',
      latestRating: 'needs-improvement',
    });
    expect(s.metrics.CLS).toMatchObject({ latest: 0.31, trend: 'worsening', latestRating: 'poor' });
    expect(s.weeks).toBe(4);
  });
});

describe('assess', () => {
  it('passes only when every core metric with data is good', () => {
    expect(assess({ LCP: { rating: 'good' }, CLS: { rating: 'good' } })).toEqual({
      result: 'passed',
      failing: [],
      noData: ['INP'],
    });
    expect(assess({ FCP: { rating: 'good' } }).result).toBe('no-data');
  });
});
