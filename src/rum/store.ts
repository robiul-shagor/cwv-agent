import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RumPayloadInput } from '../rum-client/schema.js';

/**
 * Append-only JSONL storage for RUM beacons until the Postgres phase:
 * `<dir>/<site>/<YYYY-MM-DD>.jsonl`, one line per metric. A metric may be re-sent with a newer value
 * (CLS/INP grow during the visit); readers keep the last line per `name:id`.
 */

export interface RumRecord {
  ts: number;
  /** Origin + path (the client already strips query strings). */
  url: string;
  device: 'mobile' | 'tablet' | 'desktop';
  connection?: string;
  name: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
  id: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  navigationType: string;
  attribution?: Record<string, unknown>;
}

const DAY_MS = 86_400_000;
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** Directory-safe site id: lowercase host without `www.`. */
export function siteId(host: string): string {
  return host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9.-]/g, '_')
    .slice(0, 253);
}

export class RumStore {
  private lastPrune = '';

  constructor(
    readonly dir: string,
    private readonly retentionDays = 90,
  ) {}

  async append(site: string, payload: RumPayloadInput, now = Date.now()): Promise<number> {
    const siteDir = join(resolve(this.dir), siteId(site));
    await mkdir(siteDir, { recursive: true });
    const lines = payload.metrics.map((m) =>
      JSON.stringify({
        ts: now,
        url: payload.url,
        device: payload.device,
        connection: payload.connection,
        ...m,
      } satisfies RumRecord),
    );
    await appendFile(join(siteDir, `${day(now)}.jsonl`), lines.join('\n') + '\n');
    if (this.lastPrune !== day(now)) {
      this.lastPrune = day(now);
      await this.prune(siteDir, now).catch(() => {});
    }
    return lines.length;
  }

  private async prune(siteDir: string, now: number) {
    const cutoff = day(now - this.retentionDays * DAY_MS);
    for (const f of await readdir(siteDir))
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) await rm(join(siteDir, f));
  }

  /** Site dir for a host: the host itself or a parent domain (projects are keyed by their main host). */
  async findSite(host: string): Promise<string | undefined> {
    const sites = new Set(await this.sites());
    const labels = siteId(host).split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join('.');
      if (sites.has(candidate)) return candidate;
    }
    return undefined;
  }

  async sites(): Promise<string[]> {
    try {
      return (await readdir(resolve(this.dir), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Latest value per metric instance over the last `days` days. */
  async read(site: string, days: number, now = Date.now()): Promise<RumRecord[]> {
    const siteDir = join(resolve(this.dir), siteId(site));
    let files: string[];
    try {
      files = await readdir(siteDir);
    } catch {
      return [];
    }
    const from = now - days * DAY_MS;
    const latest = new Map<string, RumRecord>();
    for (const f of files
      .filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x) && x.slice(0, 10) >= day(from))
      .sort()) {
      for (const line of (await readFile(join(siteDir, f), 'utf8')).split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as RumRecord;
          if (r.ts >= from) latest.set(`${r.name}:${r.id}`, r);
        } catch {
          // skip a torn line (crash mid-append)
        }
      }
    }
    return [...latest.values()];
  }
}

/** `RUM_KEYS="pk_live_abc=example.com|shop.example.com,pk_x=other.org"` → key → allowed hosts. */
export function parseRumKeys(spec: string | undefined): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const part of (spec ?? '').split(',')) {
    const [key, hosts] = part.split('=').map((s) => s?.trim());
    if (!key || !hosts) continue;
    keys.set(
      key,
      hosts
        .split('|')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  return keys;
}

/** Host equals an allowed host or is its subdomain (`www.` is always accepted). */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith('.' + a) || h === 'www.' + a);
}
