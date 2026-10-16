/* eslint-disable @typescript-eslint/no-explicit-any -- loose access into summarised JSON */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunManager } from '../src/api/runManager.js';
import { createApp } from '../src/api/server.js';
import { silentLogger } from '../src/lib/logger.js';
import { p75, summarizeRum } from '../src/rum/aggregate.js';
import { hostAllowed, parseRumKeys, RumStore, type RumRecord } from '../src/rum/store.js';
import { getRum } from '../src/tools/rum.js';
import { ctx } from './helpers.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cwv-rum-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const rec = (
  name: RumRecord['name'],
  value: number,
  rating: RumRecord['rating'],
  attribution: Record<string, unknown> = {},
  over: Partial<RumRecord> = {},
): RumRecord => ({
  ts: Date.now(),
  url: 'https://example.com/',
  device: 'mobile',
  name,
  id: Math.random().toString(36).slice(2),
  value,
  rating,
  navigationType: 'navigate',
  attribution,
  ...over,
});

describe('RUM keys and store', () => {
  it('parses keys and checks hosts', () => {
    const keys = parseRumKeys('pk_a=example.com|shop.example.com, pk_b = other.org ,broken');
    expect([...keys.entries()]).toEqual([
      ['pk_a', ['example.com', 'shop.example.com']],
      ['pk_b', ['other.org']],
    ]);
    expect(hostAllowed('www.example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('blog.example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('example.com.evil.io', ['example.com'])).toBe(false);
  });

  it('appends JSONL, keeps the latest value per metric id and prunes old days', async () => {
    const store = new RumStore(join(dir, 'store'), 30);
    const now = Date.UTC(2026, 9, 13);
    const payload = (value: number) => ({
      v: 1 as const,
      key: 'pk',
      url: 'https://www.example.com/a',
      device: 'mobile' as const,
      metrics: [
        { name: 'CLS' as const, id: 'v1-1', value, rating: 'good' as const, navigationType: 'navigate' },
      ],
    });
    await store.append('www.example.com', payload(0.01), now - 40 * 86_400_000); // old: pruned
    await store.append('www.example.com', payload(0.02), now - 1000);
    await store.append('www.example.com', payload(0.05), now);
    const recs = await store.read('example.com', 28, now);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ value: 0.05, url: 'https://www.example.com/a' });
    expect((await readdir(join(dir, 'store', 'example.com'))).sort()).toEqual([
      '2026-10-12.jsonl',
      '2026-10-13.jsonl',
    ]);
    expect(await store.sites()).toEqual(['example.com']);
  });
});

describe('RUM aggregation', () => {
  it('computes p75 and ranks attribution by share of bad visits', () => {
    expect(p75([1, 2, 3, 4])).toBe(3);
    expect(p75([5])).toBe(5);
    const records = [
      ...Array.from({ length: 6 }, () =>
        rec('CLS', 0.3, 'poor', {
          largestShiftTarget: 'div.ad-slot',
          loadState: 'complete',
          largestShiftTime: 9000,
        }),
      ),
      ...Array.from({ length: 2 }, () =>
        rec('CLS', 0.15, 'needs-improvement', { largestShiftTarget: 'h1.hero', loadState: 'loading' }),
      ),
      ...Array.from({ length: 4 }, () =>
        rec('CLS', 0.02, 'good', { largestShiftTarget: 'h1.hero', loadState: 'loading' }),
      ),
      ...Array.from({ length: 5 }, () =>
        rec('INP', 450, 'needs-improvement', {
          interactionTarget: 'button.accept',
          interactionType: 'pointer',
          inputDelay: 40,
          processingDuration: 380,
          presentationDelay: 30,
          loadState: 'complete',
          longestScript: {
            sourceURL: 'https://cdn.cookielaw.org/otBannerSdk.js',
            invoker: 'BUTTON.onclick',
            intersectingDuration: 300,
          },
        }),
      ),
      rec('LCP', 3200, 'needs-improvement', {
        target: 'img.hero',
        resourceLoadDelay: 1200,
        url: 'https://example.com/hero.jpg',
      }),
      rec(
        'LCP',
        1800,
        'good',
        { target: 'img.hero', resourceLoadDelay: 200 },
        { navigationType: 'back-forward-cache' },
      ),
    ];
    const s = summarizeRum(records, { pageUrl: 'https://example.com/', days: 28, scope: 'page' }) as any;
    const m = s.devices.mobile;
    expect(m.metrics.CLS).toMatchObject({ p75: 0.3, rating: 'poor', samples: 12, lowSample: true });
    expect(m.cls.topShiftElements[0]).toMatchObject({
      key: 'div.ad-slot',
      shareOfBadVisits: '75%',
      whenShifted: { complete: '100%' },
      medianShiftTimeMs: 9000,
    });
    expect(m.inp.topInteractions[0]).toMatchObject({
      key: 'pointer on button.accept',
      p75Ms: 450,
      median: { processing: 380 },
      topScripts: [{ owner: 'vendor:OneTrust consent', seenIn: 5, medianMs: 300, invoker: 'BUTTON.onclick' }],
    });
    expect(m.lcp.topElements[0]).toMatchObject({
      key: 'img.hero',
      medianSubpartsMs: { resourceLoadDelay: 1200 },
    });
    expect(m.navigationTypes).toEqual({ navigate: '50%', 'back-forward-cache': '50%' });
  });
});

describe('RUM interaction keys', () => {
  it('falls back to the handler when the interaction target was removed', () => {
    const r = rec('INP', 400, 'needs-improvement', {
      interactionType: 'pointer',
      longestScript: { sourceURL: 'https://example.com/app.js', invoker: 'BUTTON#accept.onclick' },
    });
    const s = summarizeRum([r], { pageUrl: 'https://example.com/', days: 28, scope: 'page' }) as any;
    expect(s.devices.mobile.inp.topInteractions[0].key).toBe(
      'pointer on (target removed; handler BUTTON#accept.onclick)',
    );
  });
});

describe('POST /api/rum and get_rum', () => {
  let server: Server;
  let base: string;
  const rumDir = () => join(dir, 'collector');

  beforeAll(async () => {
    const app = createApp({
      runs: new RunManager({
        provider: {
          name: 'x',
          model: 'x',
          chat: async () => ({
            content: '',
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          }),
        } as never,
        tools: () => [],
        limits: { maxToolCalls: 1, maxTotalTokens: 1000, toolTimeoutMs: 1000 },
        logger: silentLogger,
      }),
      logger: silentLogger,
      rum: { keys: parseRumKeys('pk_test=example.com'), store: new RumStore(rumDir()) },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const beacon = (body: unknown, origin = 'https://www.example.com') =>
    fetch(`${base}/api/rum`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: origin },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const payload = (over: Record<string, unknown> = {}) => ({
    v: 1,
    key: 'pk_test',
    url: 'https://www.example.com/pricing',
    device: 'mobile',
    metrics: [
      {
        name: 'CLS',
        id: 'v1-a',
        value: 0.31,
        rating: 'poor',
        navigationType: 'navigate',
        attribution: { largestShiftTarget: 'div.promo-bar', loadState: 'complete' },
      },
    ],
    ...over,
  });

  it('accepts cross-site text/plain beacons and validates key, host and shape', async () => {
    const ok = await beacon(payload());
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    expect((await beacon(payload({ key: 'pk_nope' }))).status).toBe(403);
    expect((await beacon(payload({ url: 'https://evil.io/' }))).status).toBe(403);
    expect((await beacon(payload({ metrics: [] }))).status).toBe(400);
    expect((await beacon('{not json')).status).toBe(400);
  });

  it('GET /api/rum/setup returns the key, URLs, reachability and collected samples', async () => {
    const r = (await (
      await fetch(`${base}/api/rum/setup?url=${encodeURIComponent('https://www.example.com/pricing')}`)
    ).json()) as any;
    expect(r).toMatchObject({
      enabled: true,
      host: 'www.example.com',
      key: 'pk_test',
      collectorUrl: base,
      scriptUrl: `${base}/rum/cwv-rum.js`,
      endpoint: `${base}/api/rum`,
      reachable: false, // 127.0.0.1: visitors can't reach it
      https: false,
    });
    expect(r.samples.metrics).toBeGreaterThan(0);
    const other = (await (await fetch(`${base}/api/rum/setup?url=https://other.org/`)).json()) as any;
    expect(other).toMatchObject({ key: null, samples: { metrics: 0, lastSeen: null } });
    expect((await fetch(`${base}/api/rum/setup?url=nope`)).status).toBe(400);
  });

  it('get_rum returns the collected attribution; hasData=false for unknown sites', async () => {
    const c = ctx({ rumDataDir: rumDir() });
    const r = (await getRum.execute({ url: 'https://example.com/pricing', days: 28 }, c)) as any;
    expect(r).toMatchObject({ hasData: true, site: 'example.com', scope: 'site' });
    expect(r.devices.mobile.cls.topShiftElements[0]).toMatchObject({
      key: 'div.promo-bar',
      whenShifted: { complete: '100%' },
    });
    const none = (await getRum.execute({ url: 'https://unknown.org/', days: 28 }, c)) as any;
    expect(none.hasData).toBe(false);
    expect(none.message).toContain('Install the RUM script');
    expect(((await getRum.execute({ url: 'https://example.com/', days: 28 }, ctx())) as any).hasData).toBe(
      false,
    );
  });
});
