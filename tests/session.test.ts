import { describe, expect, it } from 'vitest';
import { clsFromShifts, summarizeSession } from '../src/browser/analyze.js';
import type { RawSession } from '../src/browser/instrument.js';

const shift = (t: number, value: number, node: string, input = false, dy = 40) => ({
  t,
  value,
  input,
  sources: [{ node, dy, dh: 0, h: 100 }],
});

const raw: RawSession = {
  doc: 'd1',
  steps: [
    { name: 'load', t: 0 },
    { name: 'post-load-idle', t: 3000 },
    { name: 'consent', t: 7000 },
    { name: 'scroll', t: 9000 },
  ],
  shifts: [
    shift(500, 0.05, 'h1.hero-title'),
    shift(900, 0.04, 'h1.hero-title'),
    shift(4000, 0.12, 'div.ad-slot'),
    shift(7100, 0.3, 'main', true), // right after the consent click: excluded
    shift(9500, 0.02, 'header.sticky'),
  ],
  events: [
    {
      id: 1,
      name: 'pointerup',
      t: 7000,
      duration: 120,
      inputDelay: 10,
      processing: 90,
      presentation: 20,
      target: 'button#accept',
    },
    {
      id: 1,
      name: 'click',
      t: 7000,
      duration: 320,
      inputDelay: 30,
      processing: 250,
      presentation: 40,
      target: null,
    },
  ],
  loafs: [
    {
      t: 6990,
      duration: 330,
      blocking: 280,
      scripts: [
        {
          url: 'https://cdn.cookielaw.org/otBannerSdk.js',
          fn: 'accept',
          invoker: 'BUTTON#accept.onclick',
          type: 'event-listener',
          duration: 210,
        },
        {
          url: 'https://www.googletagmanager.com/gtm.js',
          fn: '',
          invoker: 'TimerHandler:setTimeout',
          type: 'user-callback',
          duration: 60,
        },
      ],
    },
    {
      t: 1000,
      duration: 200,
      blocking: 150,
      scripts: [
        {
          url: 'https://example.com/app.js',
          fn: 'init',
          invoker: 'https://example.com/app.js',
          type: 'classic-script',
          duration: 180,
        },
      ],
    },
  ],
  mutations: [
    { t: 3990, kind: 'inserted', node: 'div.cookie-bar', h: 120 },
    { t: 3995, kind: 'resized/restyled', node: 'span.tiny', h: 12 },
    { t: 1500, kind: 'inserted', node: 'div.too-early', h: 300 },
  ],
  inputs: [{ t: 7002, node: 'button#accept' }],
  lcp: [
    { t: 1200, node: 'h1.hero-title', size: 5000, url: '' },
    { t: 2100, node: 'img.hero', size: 90000, url: 'https://example.com/hero.jpg' },
  ],
};

describe('session analysis', () => {
  it('computes CLS with session windows and ignores shifts after input', () => {
    expect(clsFromShifts(raw.shifts)).toBe(0.12); // 0.05+0.04 window < the lone 0.12 ad shift
    expect(clsFromShifts([shift(0, 0.1, 'a'), shift(800, 0.1, 'a'), shift(1600, 0.1, 'a')])).toBe(0.3);
    expect(clsFromShifts([shift(0, 0.1, 'a'), shift(1200, 0.1, 'a')])).toBe(0.1); // > 1 s gap
  });

  it('attributes shifts to steps and elements', () => {
    const s = summarizeSession(raw, 'https://example.com/');
    expect(s.cls).toMatchObject({ value: 0.12, rating: 'needs-improvement', excludedAfterInput: 1 });
    expect(s.cls.byStep).toEqual([
      { step: 'load', cls: 0.09, shifts: 2 },
      { step: 'post-load-idle', cls: 0.12, shifts: 1 },
      { step: 'scroll', cls: 0.02, shifts: 1 },
    ]);
    expect(s.cls.topSources[0]).toMatchObject({
      element: 'div.ad-slot',
      cls: 0.12,
      steps: ['post-load-idle'],
      movedPx: 40,
    });
    expect(s.cls.topSources[0]!.likelyCauses).toEqual([
      { element: 'div.cookie-bar', what: 'inserted (120px tall) 10 ms before' },
      { element: 'span.tiny', what: 'resized/restyled (12px tall) 5 ms before' },
    ]);
    expect(s.cls.topSources[1]).toMatchObject({ element: 'h1.hero-title', cls: 0.09, shifts: 2 });
  });

  it('reports interactions with the scripts that ran, LCP and main-thread owners', () => {
    const s = summarizeSession(raw, 'https://example.com/');
    expect(s.inp.value).toBe(320);
    expect(s.inp.rating).toBe('needs-improvement');
    expect(s.inp.interactions).toHaveLength(1);
    expect(s.inp.interactions[0]).toMatchObject({
      step: 'consent',
      type: 'click',
      target: 'button#accept (removed by its handler)',
      processingMs: 250,
    });
    expect(s.inp.interactions[0]!.scripts[0]).toMatchObject({
      owner: 'vendor:OneTrust consent',
      invoker: 'BUTTON#accept.onclick',
      durationMs: 210,
    });
    expect(s.lcp).toEqual({ timeMs: 2100, element: 'img.hero', url: 'https://example.com/hero.jpg' });
    expect(s.mainThread.blockingMs).toBe(430);
    expect(s.mainThread.topScripts[0]).toMatchObject({ owner: 'vendor:OneTrust consent', totalMs: 210 });
  });
});
