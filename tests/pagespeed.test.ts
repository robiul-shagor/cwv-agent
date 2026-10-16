import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPagespeed, summarizePsi, type PsiResponse } from '../src/tools/pagespeed.js';
import { ToolError } from '../src/tools/types.js';
import { ctx, jsonResponse } from './helpers.js';

const metric = (id: string, numericValue: number) => ({
  id,
  title: id,
  score: 0.5,
  scoreDisplayMode: 'numeric',
  numericValue,
});

/** Lighthouse 13-style response (insight audits). */
const lh13: PsiResponse = {
  id: 'https://example.com/',
  loadingExperience: {
    overall_category: 'SLOW',
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: {
        percentile: 4100,
        category: 'SLOW',
        distributions: [
          { min: 0, max: 2500, proportion: 0.5 },
          { min: 2500, max: 4000, proportion: 0.2 },
          { min: 4000, proportion: 0.3 },
        ],
      },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: 'FAST' },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: 'AVERAGE' },
    },
  },
  originLoadingExperience: { metrics: {} },
  lighthouseResult: {
    lighthouseVersion: '13.0.0',
    finalDisplayedUrl: 'https://example.com/',
    categories: {
      performance: {
        score: 0.42,
        auditRefs: [
          { id: 'largest-contentful-paint' },
          { id: 'lcp-breakdown-insight' },
          { id: 'lcp-discovery-insight' },
          { id: 'render-blocking-insight' },
          { id: 'image-delivery-insight' },
          { id: 'dom-size-insight' },
        ],
      },
    },
    stackPacks: [{ id: 'next.js', title: 'Next.js' }],
    audits: {
      'first-contentful-paint': metric('first-contentful-paint', 1900.4),
      'largest-contentful-paint': metric('largest-contentful-paint', 5200.7),
      'total-blocking-time': metric('total-blocking-time', 640),
      'cumulative-layout-shift': metric('cumulative-layout-shift', 0.1234),
      'speed-index': metric('speed-index', 4000),
      'lcp-breakdown-insight': {
        id: 'lcp-breakdown-insight',
        title: 'LCP breakdown',
        score: 0,
        scoreDisplayMode: 'metricSavings',
        details: {
          type: 'list',
          items: [
            {
              type: 'table',
              items: [
                { subpart: 'timeToFirstByte', label: 'Time to first byte', duration: 600.2 },
                { subpart: 'resourceLoadDelay', label: 'Resource load delay', duration: 2100 },
              ],
            },
            {
              type: 'node',
              selector: 'main > img.hero',
              snippet: '<img class="hero" loading="lazy" src="/hero.jpg">',
              nodeLabel: 'Hero',
            },
          ],
        },
      },
      'lcp-discovery-insight': {
        id: 'lcp-discovery-insight',
        title: 'LCP request discovery',
        score: 0,
        scoreDisplayMode: 'metricSavings',
        metricSavings: { LCP: 1500 },
        details: {
          type: 'list',
          items: [{ type: 'checklist', items: { lazy: { label: 'lazy load not applied', value: false } } }],
        },
      },
      'render-blocking-insight': {
        id: 'render-blocking-insight',
        title: 'Render blocking requests',
        score: 0,
        scoreDisplayMode: 'metricSavings',
        metricSavings: { FCP: 800, LCP: 800 },
        details: {
          type: 'table',
          items: [{ url: 'https://example.com/app.css', totalBytes: 50000, wastedMs: 780 }],
        },
      },
      'image-delivery-insight': {
        id: 'image-delivery-insight',
        title: 'Improve image delivery',
        score: 0.5,
        scoreDisplayMode: 'metricSavings',
        metricSavings: { LCP: 300 },
        details: {
          type: 'table',
          overallSavingsBytes: 220000,
          items: [{ url: 'https://example.com/hero.jpg', totalBytes: 400000, wastedBytes: 220000 }],
        },
      },
      'dom-size-insight': {
        id: 'dom-size-insight',
        title: 'DOM size',
        score: 1,
        scoreDisplayMode: 'metricSavings',
        numericValue: 2100,
      },
      'long-tasks': {
        id: 'long-tasks',
        title: 'Long tasks',
        score: null,
        scoreDisplayMode: 'informative',
        details: {
          type: 'table',
          items: [
            { url: 'https://example.com/app.js', startTime: 2000.4, duration: 180.2 },
            { url: 'https://www.googletagmanager.com/gtm.js', startTime: 1500, duration: 420 },
          ],
        },
      },
      'bootup-time': {
        id: 'bootup-time',
        title: 'JS execution time',
        score: 0.3,
        scoreDisplayMode: 'metricSavings',
        numericValue: 2400,
        details: {
          type: 'table',
          items: [
            { url: 'https://example.com/app.js', total: 1300, scripting: 1100, scriptParseCompile: 150 },
            { url: 'https://example.com/tiny.js', total: 20, scripting: 10, scriptParseCompile: 5 },
          ],
        },
      },
      'mainthread-work-breakdown': {
        id: 'mainthread-work-breakdown',
        title: 'Main thread',
        score: 0.2,
        scoreDisplayMode: 'metricSavings',
        numericValue: 4100,
        details: {
          type: 'table',
          items: [
            { group: 'scriptEvaluation', groupLabel: 'Script Evaluation', duration: 2600 },
            { group: 'styleLayout', groupLabel: 'Style & Layout', duration: 700 },
            { group: 'other', groupLabel: 'Other', duration: 10 },
          ],
        },
      },
      'third-party-summary': {
        id: 'third-party-summary',
        title: 'Third parties',
        score: 0,
        scoreDisplayMode: 'metricSavings',
        details: {
          type: 'table',
          items: [
            { entity: 'Google Tag Manager', blockingTime: 370, mainThreadTime: 600, transferSize: 90000 },
          ],
        },
      },
    },
  },
};

describe('summarizePsi', () => {
  it('extracts lab metrics, LCP element/phases, opportunities and field data (LH13)', () => {
    const s = summarizePsi(lh13, 'mobile');
    expect(s.performanceScore).toBe(42);
    expect(s.labMetrics.LCP).toEqual({ value: 5201, rating: 'poor' });
    expect(s.labMetrics.CLS).toEqual({ value: 0.123, rating: 'needs-improvement' });
    expect(s.labMetrics.TBT).toEqual({ value: 640, rating: 'poor' });
    expect(s.labMetrics.SI).toEqual({ value: 4000, rating: 'needs-improvement' });
    expect(s.mainThread).toEqual({
      totalMainThreadMs: 4100,
      totalScriptMs: 2400,
      longTaskCount: 2,
      longestTasks: [
        {
          url: 'https://www.googletagmanager.com/gtm.js',
          owner: 'vendor:Google Tag Manager',
          startMs: 1500,
          durationMs: 420,
        },
        { url: 'https://example.com/app.js', owner: 'first-party', startMs: 2000, durationMs: 180 },
      ],
      heaviestScripts: [
        {
          url: 'https://example.com/app.js',
          owner: 'first-party',
          totalMs: 1300,
          scriptingMs: 1100,
          parseCompileMs: 150,
        },
      ],
      workByType: [
        { group: 'Script Evaluation', ms: 2600 },
        { group: 'Style & Layout', ms: 700 },
      ],
      thirdPartyBlocking: [{ entity: 'Google Tag Manager', blockingMs: 370, mainThreadMs: 600 }],
      domElements: 2100,
    });
    expect(s.lcpElement.node?.selector).toBe('main > img.hero');
    expect(s.lcpElement.phases).toEqual([
      { phase: 'Time to first byte', ms: 600 },
      { phase: 'Resource load delay', ms: 2100 },
    ]);
    // Sorted by impact; passing audits excluded.
    expect(s.opportunities.map((o) => o.id)).toEqual([
      'lcp-discovery-insight',
      'render-blocking-insight',
      'image-delivery-insight',
      'lcp-breakdown-insight',
    ]);
    expect(s.renderBlocking?.[0]).toMatchObject({
      url: 'https://example.com/app.css',
      owner: 'first-party',
      wastedMs: 780,
    });
    expect(s.fieldData.page).toMatchObject({ hasData: true, scope: 'url', overall: 'poor' });
    expect((s.fieldData.page as { metrics: Record<string, unknown> }).metrics.CLS).toMatchObject({
      p75: 0.12,
      rating: 'needs-improvement',
    });
    expect(s.fieldData.origin).toEqual({ hasData: false });
    expect(s.detectedStack).toEqual(['Next.js']);
    expect(JSON.stringify(s).length).toBeLessThan(6000);
  });

  it('handles Lighthouse 12 LCP element format', () => {
    const lh12: PsiResponse = {
      lighthouseResult: {
        audits: {
          'largest-contentful-paint-element': {
            id: 'largest-contentful-paint-element',
            title: 'LCP element',
            score: 0,
            scoreDisplayMode: 'metricSavings',
            details: {
              type: 'list',
              items: [
                {
                  type: 'table',
                  items: [{ node: { type: 'node', selector: 'h1.title', snippet: '<h1 class="title">' } }],
                },
                {
                  type: 'table',
                  items: [
                    { phase: 'TTFB', timing: 300, percent: '10%' },
                    { phase: 'Render Delay', timing: 2400, percent: '80%' },
                  ],
                },
              ],
            },
          },
          'lcp-lazy-loaded': {
            id: 'lcp-lazy-loaded',
            title: 'lazy',
            score: 1,
            scoreDisplayMode: 'metricSavings',
          },
        },
      },
    };
    const s = summarizePsi(lh12, 'desktop');
    expect(s.lcpElement.node?.selector).toBe('h1.title');
    expect(s.lcpElement.phases).toEqual([
      { phase: 'TTFB', ms: 300 },
      { phase: 'Render Delay', ms: 2400 },
    ]);
    expect(s.lcpElement.lazyLoaded).toBe(false);
  });

  it('surfaces Lighthouse runtime errors', () => {
    expect(() =>
      summarizePsi(
        { lighthouseResult: { audits: {}, runtimeError: { code: 'NO_FCP', message: 'no paint' } } },
        'mobile',
      ),
    ).toThrow(ToolError);
  });
});

describe('run_pagespeed tool', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls PSI with the key, caches per run and maps HTTP errors to ToolError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(lh13));
    vi.stubGlobal('fetch', fetchMock);
    const c = ctx();
    await runPagespeed.execute({ url: 'example.com', strategy: 'mobile' }, c);
    await runPagespeed.execute({ url: 'https://example.com/', strategy: 'mobile' }, c);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const called = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(called.searchParams.get('url')).toBe('https://example.com/');
    expect(called.searchParams.get('strategy')).toBe('MOBILE');
    expect(called.searchParams.get('key')).toBe('test-google-key-123');

    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Quota exceeded per day' } }, 429));
    const err = await runPagespeed
      .execute({ url: 'https://other.com', strategy: 'mobile' }, ctx())
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).not.toContain('test-google-key-123');
  });
});
