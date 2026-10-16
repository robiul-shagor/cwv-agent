import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ReportSchema } from '../agent/report.js';
import { RumPayloadSchema } from '../rum-client/schema.js';
import { hostAllowed, type RumStore } from '../rum/store.js';
import type { Logger } from '../lib/logger.js';
import { assertPublicUrl, normalizeUrl, UnsafeUrlError } from '../lib/url.js';
import { parseSourceSpec, SourceError } from '../source/index.js';
import { BusyError, type RunEvent, type RunManager } from './runManager.js';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const RUM_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'rum', 'cwv-rum.js');
/** Beacons per client IP per minute (a page view sends 1-3). */
const RUM_RATE_PER_MIN = 120;

/** `<host>-<device>-<runId>` — strict so it can never escape the reports directory. */
const REPORT_NAME =
  /^[a-z0-9.-]{1,253}-(mobile|desktop)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}$/i;

const StartRunBody = z.object({
  url: z.string().trim().min(1, 'URL is required').max(2048),
  device: z.enum(['mobile', 'desktop']).default('mobile'),
  source: z.string().trim().max(500).optional(),
});

export interface AppOptions {
  runs: RunManager;
  logger: Logger;
  reportsDir?: string;
  /** Host:port values accepted in the Host header (DNS-rebinding protection). Empty = allow all. */
  allowedHosts?: string[];
  /** Validates that a URL is publicly reachable (overridable in tests). */
  checkUrl?: (url: URL) => Promise<void>;
  /** RUM collection: public project keys → allowed site hosts, and where beacons are stored. */
  rum?: { keys: Map<string, string[]>; store: RumStore; publicUrl?: string };
}

/** Fixed-window counter per key; bounded memory. */
function rateLimiter(perMinute: number) {
  const hits = new Map<string, { start: number; n: number }>();
  return (key: string, now = Date.now()): boolean => {
    const e = hits.get(key);
    if (!e || now - e.start >= 60_000) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { start: now, n: 1 });
      return true;
    }
    return ++e.n <= perMinute;
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(opts: AppOptions) {
  const reportsDir = opts.reportsDir ?? 'reports';
  const checkUrl = opts.checkUrl ?? assertPublicUrl;
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    // The server can spend API quota: only accept requests addressed to us (blocks DNS rebinding)…
    if (opts.allowedHosts?.length && !opts.allowedHosts.includes(req.headers.host ?? '')) {
      res.status(403).json({ error: 'Host not allowed' });
      return;
    }
    // …and only state changes coming from our own page (blocks cross-site POSTs).
    // Exception: RUM beacons are cross-site by design (validated by project key + site host instead).
    const origin = req.headers.origin;
    if (
      req.path !== '/api/rum' &&
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      origin &&
      origin !== `${req.protocol}://${req.headers.host}`
    ) {
      res.status(403).json({ error: 'Cross-origin request rejected' });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  // ── RUM collector ──────────────────────────────────────────────────────
  const rumRate = rateLimiter(RUM_RATE_PER_MIN);
  // The client sends text/plain (a CORS "simple request" that works with sendBeacon).
  app.post('/api/rum', express.text({ type: () => true, limit: '64kb' }), async (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      if (!opts.rum?.keys.size) throw new HttpError(404, 'RUM collection is not enabled');
      if (!rumRate(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many beacons');
      let body: unknown;
      try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      } catch {
        throw new HttpError(400, 'Invalid JSON');
      }
      const parsed = RumPayloadSchema.safeParse(body);
      if (!parsed.success) throw new HttpError(400, 'Invalid RUM payload');
      const allowed = opts.rum.keys.get(parsed.data.key);
      if (!allowed) throw new HttpError(403, 'Unknown project key');
      if (!hostAllowed(new URL(parsed.data.url).hostname, allowed))
        throw new HttpError(403, 'Site not allowed for this key');
      await opts.rum.store.append(allowed[0]!, parsed.data);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
  // Install guide data for the UI: key for this site, collector URLs, reachability and collected samples.
  app.get('/api/rum/setup', async (req, res, next) => {
    try {
      let host: string;
      try {
        host = new URL(String(req.query.url ?? '')).hostname.toLowerCase();
      } catch {
        throw new HttpError(400, 'url is required');
      }
      const keys = opts.rum?.keys ?? new Map<string, string[]>();
      const key = [...keys.entries()].find(([, hosts]) => hostAllowed(host, hosts))?.[0];
      const collectorUrl = (opts.rum?.publicUrl ?? `${req.protocol}://${req.headers.host}`).replace(
        /\/+$/,
        '',
      );
      const store = opts.rum?.store;
      const site = store ? await store.findSite(host) : undefined;
      const records = site && store ? await store.read(site, 28) : [];
      const pageViews = records.filter((r) => r.name === 'LCP').length;
      res.json({
        enabled: keys.size > 0,
        host,
        key: key ?? null,
        collectorUrl,
        scriptUrl: `${collectorUrl}/rum/cwv-rum.js`,
        endpoint: `${collectorUrl}/api/rum`,
        reachable: !/^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(collectorUrl),
        https: collectorUrl.startsWith('https://'),
        samples: {
          pageViews,
          metrics: records.length,
          lastSeen: records.length
            ? new Date(records.reduce((m, r) => Math.max(m, r.ts), 0)).toISOString()
            : null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/rum/cwv-rum.js', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(
      RUM_SCRIPT,
      { maxAge: '1h' },
      (err) => err && next(new HttpError(404, 'Run npm run build:rum first')),
    );
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, activeRuns: opts.runs.activeCount });
  });

  app.post('/api/runs', async (req, res) => {
    const body = StartRunBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? 'Invalid request');
    let url: URL;
    try {
      url = normalizeUrl(body.data.url);
      await checkUrl(url);
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new HttpError(400, err.message);
      throw new HttpError(400, `Could not resolve ${body.data.url}`);
    }
    const source = body.data.source || undefined;
    if (source) {
      try {
        parseSourceSpec(source); // fail fast on typos; cloning happens in the run
      } catch (err) {
        if (err instanceof SourceError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    try {
      const run = opts.runs.start(url.toString(), body.data.device, source);
      res.status(202).json(run);
    } catch (err) {
      if (err instanceof BusyError) throw new HttpError(409, err.message);
      throw err;
    }
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = opts.runs.get(req.params.id);
    if (!run) throw new HttpError(404, 'Run not found');
    res.json(run);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    if (!opts.runs.cancel(req.params.id)) throw new HttpError(409, 'Run is not running');
    res.status(202).json({ ok: true });
  });

  /** Server-sent events: replays steps so far, then streams new ones until the run finishes. */
  app.get('/api/runs/:id/events', (req, res) => {
    const run = opts.runs.get(req.params.id);
    if (!run) throw new HttpError(404, 'Run not found');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const send = (event: RunEvent) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    for (const step of run.steps) send({ type: 'step', step });
    if (run.outcome) {
      send({ type: 'done', outcome: run.outcome });
      res.end();
      return;
    }

    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    const unsubscribe = opts.runs.subscribe(run.id, (event) => {
      send(event);
      if (event.type === 'done') cleanup();
    });
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    req.on('close', cleanup);
  });

  app.get('/api/reports', async (_req, res) => {
    let files: string[] = [];
    try {
      files = (await readdir(reportsDir)).filter(
        (f) => f.endsWith('.json') && REPORT_NAME.test(f.slice(0, -5)),
      );
    } catch {
      /* no reports yet */
    }
    const items = await Promise.all(
      files.map(async (file) => {
        const name = file.slice(0, -5);
        try {
          const path = join(reportsDir, file);
          const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
          const report = ReportSchema.safeParse(JSON.parse(raw));
          if (!report.success) return null;
          return {
            name,
            url: report.data.url,
            device: report.data.device,
            status: report.data.status,
            findings: report.data.findings.length,
            summary: report.data.summary,
            createdAt: info.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      }),
    );
    res.json(
      items
        .filter((i) => i !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50),
    );
  });

  app.get('/api/reports/:name', async (req, res) => {
    const name = req.params.name;
    const match = /^(.+)\.(md|json)$/.exec(name);
    const base = match ? match[1]! : name;
    if (!REPORT_NAME.test(base)) throw new HttpError(400, 'Invalid report name');
    const ext = match?.[2] ?? 'json';
    let content: string;
    try {
      content = await readFile(join(reportsDir, `${base}.${ext}`), 'utf8');
    } catch {
      throw new HttpError(404, 'Report not found');
    }
    if (match) {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.${ext}"`);
      res.type(ext === 'md' ? 'text/markdown' : 'application/json').send(content);
    } else {
      res.type('application/json').send(content);
    }
  });

  app.use(express.static(WEB_DIR, { index: 'index.html', maxAge: 0 }));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : ((err as { status?: number }).status ?? 500);
    const message = status >= 500 ? 'Internal server error' : (err as Error).message;
    if (status >= 500) opts.logger.error('Request failed', { error: (err as Error).message });
    if (!res.headersSent) res.status(status).json({ error: message });
  });

  return app;
}
