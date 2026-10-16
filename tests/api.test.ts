import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChatResponse, LLMProvider } from '../src/agent/llm/types.js';
import { RunManager } from '../src/api/runManager.js';
import { createApp } from '../src/api/server.js';
import { silentLogger } from '../src/lib/logger.js';
import type { Tool } from '../src/tools/types.js';

const report = {
  url: 'https://example.com/',
  device: 'mobile',
  summary: 'LCP is poor at 4.1s p75 because the hero image is lazy-loaded.',
  status: { LCP: 'poor', INP: 'unknown', CLS: 'good' },
  statusSource: 'field-url',
  findings: [
    {
      metric: 'LCP',
      severity: 'high',
      rootCause: 'Hero image img.hero is lazy-loaded',
      evidence: ['PSI: resource load delay 2100ms'],
      location: { selector: 'img.hero' },
      fixType: 'auto',
      fix: 'Remove loading=lazy from img.hero',
      expectedImpact: 'LCP -1s',
      confidence: 'high',
    },
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON access in assertions
const body = (res: Response): Promise<any> => res.json();

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Fake LLM: one tool call, then the report. `gate` lets a test hold the run open. */
function fakeProvider(gate?: Promise<void>): LLMProvider {
  let turn = 0;
  return {
    name: 'fake',
    model: 'fake',
    async chat(req): Promise<ChatResponse> {
      turn++;
      if (turn === 1)
        return {
          text: null,
          usage,
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'a', name: 'probe', args: { url: 'https://example.com/' } }],
        };
      if (gate) await gate;
      req.signal?.throwIfAborted();
      return {
        text: null,
        usage,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'b', name: 'submit_report', args: report }],
      };
    },
  };
}

const probe: Tool<{ url: string }> = {
  name: 'probe',
  description: 'probe',
  inputSchema: z.object({ url: z.string() }),
  execute: async () => ({ ok: true }),
};

let dir: string;
let server: Server;
let base: string;
let release: () => void = () => {};
let provider: LLMProvider;

const limits = { maxToolCalls: 5, maxTotalTokens: 10_000, toolTimeoutMs: 1000 };

async function readEvents(id: string) {
  const res = await fetch(`${base}/api/runs/${id}/events`);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const text = await res.text(); // stream ends after "done"
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => JSON.parse(b.split('\n')[1]!.slice(6)));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cwv-api-'));
  const gate = new Promise<void>((r) => (release = r));
  provider = fakeProvider(gate);
  const runs = new RunManager({
    provider: {
      name: 'proxy',
      model: 'fake',
      chat: (req) => provider.chat(req),
    },
    tools: () => [probe] as Tool<never>[],
    limits,
    logger: silentLogger,
    reportsDir: join(dir, 'reports'),
    runsDir: join(dir, 'runs'),
  });
  const app = createApp({
    runs,
    logger: silentLogger,
    reportsDir: join(dir, 'reports'),
    checkUrl: async () => {},
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('web API', () => {
  it('serves the UI with security headers', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('CWV Agent');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('validates input', async () => {
    expect((await post('/api/runs', { url: '' })).status).toBe(400);
    const bad = await post('/api/runs', { url: 'ftp://example.com' });
    expect(bad.status).toBe(400);
    expect((await body(bad)).error).toMatch(/http/);
    expect((await post('/api/runs', { url: 'https://example.com', device: 'tv' })).status).toBe(400);
  });

  it('rejects cross-origin state changes', async () => {
    const res = await post('/api/runs', { url: 'https://example.com' }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('runs a diagnosis, streams steps, enforces one run at a time, and saves the report', async () => {
    const res = await post('/api/runs', { url: 'example.com', device: 'mobile' });
    expect(res.status).toBe(202);
    const run = await body(res);
    expect(run).toMatchObject({ url: 'https://example.com/', device: 'mobile', status: 'running' });

    expect((await post('/api/runs', { url: 'https://other.com' })).status).toBe(409);

    const eventsPromise = readEvents(run.id);
    release();
    const events = await eventsPromise;
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.outcome).toMatchObject({ status: 'completed', toolCalls: 1 });
    expect(done.outcome.report.findings).toHaveLength(1);
    const steps = events.filter((e) => e.type === 'step').map((e) => e.step);
    expect(steps.map((s) => s.kind)).toEqual(['llm', 'tool', 'llm', 'report']);
    expect(steps[1]).toMatchObject({ toolName: 'probe', input: { url: 'https://example.com/' } });
    expect(steps[1]).not.toHaveProperty('output');

    // Reconnecting after completion replays everything.
    expect((await readEvents(run.id)).at(-1).type).toBe('done');
    expect((await body(await fetch(`${base}/api/runs/${run.id}`))).status).toBe('completed');

    const list = await body(await fetch(`${base}/api/reports`));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: done.outcome.reportName,
      url: 'https://example.com/',
      findings: 1,
    });

    const md = await fetch(`${base}/api/reports/${done.outcome.reportName}.md`);
    expect(md.headers.get('content-disposition')).toContain('attachment');
    expect(await md.text()).toContain('# Core Web Vitals diagnosis');
    const json = await body(await fetch(`${base}/api/reports/${done.outcome.reportName}`));
    expect(json.summary).toBe(report.summary);
  });

  it('cancels a running diagnosis', async () => {
    let unblock: () => void = () => {};
    provider = fakeProvider(new Promise<void>((r) => (unblock = r)));
    const run = await body(await post('/api/runs', { url: 'https://example.com' }));
    const eventsPromise = readEvents(run.id);
    expect((await post(`/api/runs/${run.id}/cancel`, {})).status).toBe(202);
    unblock();
    const done = (await eventsPromise).at(-1);
    expect(done.outcome.status).toBe('cancelled');
  });

  it('refuses path traversal and unknown runs', async () => {
    expect((await fetch(`${base}/api/reports/..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
    expect((await fetch(`${base}/api/reports/..%2F.env`)).status).toBe(400);
    expect((await fetch(`${base}/api/runs/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it('rejects unexpected Host headers when configured (DNS rebinding)', async () => {
    const app = createApp({
      runs: new RunManager({ provider, tools: () => [], limits, logger: silentLogger }),
      logger: silentLogger,
      allowedHosts: ['localhost:1'],
    });
    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/health`);
    expect(res.status).toBe(403);
    s.close();
  });
});
