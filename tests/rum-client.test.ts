import { describe, expect, it, vi } from 'vitest';
import {
  compactAttribution,
  detectDevice,
  isSampled,
  sanitizeUrl,
  toRumMetric,
} from '../src/rum-client/payload.js';
import { createReporter } from '../src/rum-client/reporter.js';
import { RumPayloadSchema } from '../src/rum-client/schema.js';

const fakeNode = { nodeType: 1, nodeName: 'IMG' };

const inpMetric = {
  name: 'INP',
  id: 'v6-1-1',
  value: 412.6,
  rating: 'needs-improvement',
  navigationType: 'navigate',
  attribution: {
    interactionTarget: 'button#add-to-cart',
    interactionType: 'pointer',
    inputDelay: 120.4,
    processingDuration: 250.2,
    presentationDelay: 42,
    loadState: 'complete',
    processedEventEntries: [{ target: fakeNode }],
    longAnimationFrameEntries: [{ scripts: [] }],
    longestScript: {
      entry: {
        sourceURL: 'https://cdn.example.com/app.js?v=123&token=secret',
        sourceFunctionName: 'onClick',
        invokerType: 'event-listener',
        invoker: 'BUTTON#add-to-cart.onclick',
        duration: 240,
      },
      subpart: 'processing-duration',
      intersectingDuration: 230.7,
    },
    totalScriptDuration: 260.1,
  },
};

describe('sanitizeUrl', () => {
  it('drops query strings and fragments unless allow-listed', () => {
    expect(sanitizeUrl('https://shop.com/p/1?email=a@b.com&page=2#top')).toBe('https://shop.com/p/1');
    expect(sanitizeUrl('https://shop.com/p/1?email=a@b.com&page=2', ['page'])).toBe(
      'https://shop.com/p/1?page=2',
    );
    expect(sanitizeUrl('data:image/png;base64,AAAA')).toBe('data:…');
    expect(sanitizeUrl('not a url')).toBeUndefined();
  });
});

describe('toRumMetric / compactAttribution', () => {
  it('keeps INP phases + longest script, strips DOM/perf entries and query strings', () => {
    const m = toRumMetric(inpMetric)!;
    expect(m).toMatchObject({ name: 'INP', value: 413, rating: 'needs-improvement' });
    expect(m.attribution).toEqual({
      interactionTarget: 'button#add-to-cart',
      interactionType: 'pointer',
      inputDelay: 120,
      processingDuration: 250,
      presentationDelay: 42,
      loadState: 'complete',
      totalScriptDuration: 260,
      longestScript: {
        sourceURL: 'https://cdn.example.com/app.js',
        sourceFunctionName: 'onClick',
        invokerType: 'event-listener',
        invoker: 'BUTTON#add-to-cart.onclick',
        subpart: 'processing-duration',
        intersectingDuration: 231,
      },
    });
    expect(JSON.stringify(m)).not.toContain('secret');
  });

  it('compacts LCP, CLS and TTFB attribution', () => {
    expect(
      compactAttribution('LCP', {
        target: 'img.hero',
        url: 'https://img.cdn.com/hero.jpg?w=1200',
        timeToFirstByte: 500.4,
        resourceLoadDelay: 1200,
        resourceLoadDuration: 300,
        elementRenderDelay: 50,
        lcpEntry: fakeNode,
      }),
    ).toEqual({
      target: 'img.hero',
      url: 'https://img.cdn.com/hero.jpg',
      timeToFirstByte: 500,
      resourceLoadDelay: 1200,
      resourceLoadDuration: 300,
      elementRenderDelay: 50,
    });
    expect(
      compactAttribution('CLS', {
        largestShiftTarget: 'div.banner',
        largestShiftValue: 0.18234,
        largestShiftSource: fakeNode,
      }),
    ).toEqual({
      largestShiftTarget: 'div.banner',
      largestShiftValue: 0.182,
    });
    expect(
      toRumMetric({ name: 'CLS', id: 'x', value: 0.123456, rating: 'poor', navigationType: 'reload' })?.value,
    ).toBe(0.1235);
    expect(compactAttribution('TTFB', { requestDuration: 300.6, dnsDuration: 0 })).toEqual({
      requestDuration: 301,
      dnsDuration: 0,
    });
  });

  it('ignores unknown metrics and non-finite values', () => {
    expect(
      toRumMetric({ name: 'FID', id: 'x', value: 1, rating: 'good', navigationType: 'navigate' }),
    ).toBeNull();
    expect(
      toRumMetric({ name: 'LCP', id: 'x', value: NaN, rating: 'good', navigationType: 'navigate' }),
    ).toBeNull();
  });
});

describe('detectDevice / isSampled', () => {
  it('maps user agents to CrUX-like form factors', () => {
    expect(detectDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe(
      'mobile',
    );
    expect(detectDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile Safari/537.36')).toBe(
      'mobile',
    );
    expect(detectDevice('Mozilla/5.0 (Linux; Android 13; SM-X700) Chrome/130 Safari/537.36')).toBe('tablet');
    expect(detectDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(detectDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130')).toBe('desktop');
    expect(detectDevice('anything', true)).toBe('mobile');
  });

  it('samples per page view', () => {
    expect(isSampled(1, 0.99)).toBe(true);
    expect(isSampled(0, 0)).toBe(false);
    expect(isSampled(0.25, 0.2)).toBe(true);
    expect(isSampled(0.25, 0.3)).toBe(false);
    expect(isSampled(NaN)).toBe(false);
  });
});

describe('createReporter', () => {
  const base = { key: 'pk_test', url: 'https://shop.com/p/1', device: 'mobile' as const, connection: '4g' };
  const metric = (name: 'LCP' | 'CLS', id: string, value: number) =>
    toRumMetric({ name, id, value, rating: 'good', navigationType: 'navigate' })!;

  it('dedupes by metric id (latest wins), batches, and produces schema-valid payloads', () => {
    const sent: string[] = [];
    const r = createReporter({ base, send: (b) => (sent.push(b), true), maxBatch: 2 });
    r.add(metric('CLS', 'c1', 0.01));
    r.add(metric('CLS', 'c1', 0.05));
    r.add(metric('LCP', 'l1', 1800));
    r.add(metric('LCP', 'l2', 900));
    expect(r.flush()).toBe(3);
    expect(sent).toHaveLength(2);
    const first = RumPayloadSchema.parse(JSON.parse(sent[0]!));
    expect(first.metrics.find((m) => m.name === 'CLS')?.value).toBe(0.05);
    expect(first).toMatchObject({ v: 1, key: 'pk_test', device: 'mobile' });
    expect(r.size).toBe(0);
    expect(r.flush()).toBe(0);
  });

  it('holds metrics until consent and keeps them if the transport fails', () => {
    let consent = false;
    const send = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const r = createReporter({ base, send, canSend: () => consent });
    r.add(metric('LCP', 'l1', 1800));
    expect(r.flush()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    consent = true;
    expect(r.flush()).toBe(0); // transport refused
    expect(r.size).toBe(1);
    expect(r.flush()).toBe(1);
  });

  it('accepts a full INP payload in the server schema and rejects garbage', () => {
    const payload = { v: 1, ...base, metrics: [toRumMetric(inpMetric)] };
    expect(RumPayloadSchema.safeParse(payload).success).toBe(true);
    expect(RumPayloadSchema.safeParse({ ...payload, metrics: [] }).success).toBe(false);
    expect(RumPayloadSchema.safeParse({ ...payload, url: 'javascript:alert(1)' }).success).toBe(false);
  });
});
