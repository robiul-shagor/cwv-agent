import { attributeUrl } from '../lib/attribution.js';
import { rate } from '../lib/cwv.js';
import type { RawEvent, RawLoaf, RawSession, RawShift } from './instrument.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** CLS = largest session window (shifts < 1 s apart, window ≤ 5 s), excluding shifts right after input. */
export function clsFromShifts(shifts: RawShift[]): number {
  let max = 0;
  let cur = 0;
  let first = -Infinity;
  let prev = -Infinity;
  for (const s of [...shifts].filter((x) => !x.input).sort((a, b) => a.t - b.t)) {
    if (s.t - prev < 1000 && s.t - first < 5000) cur += s.value;
    else {
      cur = s.value;
      first = s.t;
    }
    prev = s.t;
    max = Math.max(max, cur);
  }
  return r3(max);
}

function stepAt(steps: RawSession['steps'], t: number): string {
  let name = steps[0]?.name ?? 'load';
  for (const s of steps) if (s.t <= t) name = s.name;
  return name;
}

function scriptsIn(loafs: RawLoaf[], from: number, to: number, pageUrl: string, max = 3) {
  return loafs
    .filter((l) => l.t < to && l.t + l.duration > from)
    .flatMap((l) => l.scripts)
    .filter((s) => s.duration >= 5)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, max)
    .map((s) => ({
      url: s.url || undefined,
      owner: s.url ? attributeUrl(s.url, pageUrl) : undefined,
      fn: s.fn || undefined,
      invoker: s.invoker || undefined,
      durationMs: s.duration,
      charPosition: s.pos,
    }));
}

/** One entry per interaction (Event Timing reports several events per interaction): keep the longest. */
function interactions(events: RawEvent[]) {
  const byId = new Map<number, RawEvent>();
  for (const e of events) {
    const cur = byId.get(e.id);
    if (!cur || e.duration > cur.duration) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/** Target remembered at input time (Event Timing reports null when the handler removed the element). */
function inputTarget(raw: RawSession, t: number) {
  const hit = (raw.inputs ?? []).find((i) => Math.abs(i.t - t) <= 8 && i.node);
  return hit ? `${hit.node} (removed by its handler)` : undefined;
}

export function summarizeSession(raw: RawSession, pageUrl: string) {
  const { steps, shifts, loafs } = raw;

  // ── CLS ────────────────────────────────────────────────────────────────
  const counted = shifts.filter((s) => !s.input);
  const byStep = new Map<string, { cls: number; shifts: number }>();
  for (const s of counted) {
    const k = stepAt(steps, s.t);
    const e = byStep.get(k) ?? { cls: 0, shifts: 0 };
    e.cls += s.value;
    e.shifts++;
    byStep.set(k, e);
  }
  const sources = new Map<
    string,
    {
      total: number;
      count: number;
      steps: Set<string>;
      maxDy: number;
      dh: number;
      causes: Map<string, string>;
    }
  >();
  for (const s of counted) {
    for (const src of s.sources.slice(0, 1)) {
      // The first source is the most impactful one in Chrome's ordering.
      const key = src.node ?? '(removed element)';
      const e = sources.get(key) ?? {
        total: 0,
        count: 0,
        steps: new Set(),
        maxDy: 0,
        dh: 0,
        causes: new Map(),
      };
      // DOM inserted/resized in the second before the shift: what pushed this element.
      for (const m of (raw.mutations ?? [])
        .filter((m) => m.node && m.t >= s.t - 1000 && m.t <= s.t + 50)
        .sort((a, b) => b.h - a.h)
        .slice(0, 2))
        if (!e.causes.has(m.node!)) e.causes.set(m.node!, `${m.kind} (${m.h}px tall) ${s.t - m.t} ms before`);
      e.total += s.value;
      e.count++;
      e.steps.add(stepAt(steps, s.t));
      if (Math.abs(src.dy) > Math.abs(e.maxDy)) e.maxDy = src.dy;
      if (Math.abs(src.dh) > Math.abs(e.dh)) e.dh = src.dh;
      sources.set(key, e);
    }
  }
  const cls = clsFromShifts(shifts);

  // ── INP (from the simulated interactions) ──────────────────────────────
  const inter = interactions(raw.events).sort((a, b) => b.duration - a.duration);
  const inp = inter[0]?.duration;

  // ── Main thread: scripts in long animation frames ──────────────────────
  // Per script URL: total time, plus the single slowest entry (its function + position = the hotspot to map).
  const scriptTotals = new Map<
    string,
    { totalMs: number; frames: number; invoker?: string; maxMs: number; fn?: string; pos?: number }
  >();
  for (const l of loafs)
    for (const s of l.scripts) {
      if (!s.url) continue;
      const e = scriptTotals.get(s.url) ?? { totalMs: 0, frames: 0, maxMs: -1 };
      e.totalMs += s.duration;
      e.frames++;
      if (s.duration > e.maxMs)
        Object.assign(e, {
          maxMs: s.duration,
          fn: s.fn || undefined,
          pos: s.pos,
          invoker: s.invoker || undefined,
        });
      scriptTotals.set(s.url, e);
    }
  const lcp = raw.lcp.at(-1);

  return {
    cls: {
      value: cls,
      rating: rate('CLS', cls),
      byStep: [...byStep.entries()].map(([step, v]) => ({ step, cls: r3(v.cls), shifts: v.shifts })),
      topSources: [...sources.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 6)
        .map(([element, v]) => ({
          element,
          cls: r3(v.total),
          shifts: v.count,
          steps: [...v.steps],
          movedPx: v.maxDy || undefined,
          heightChangePx: v.dh || undefined,
          likelyCauses: v.causes.size
            ? [...v.causes.entries()].slice(0, 2).map(([element, what]) => ({ element, what }))
            : undefined,
        })),
      excludedAfterInput: shifts.length - counted.length || undefined,
    },
    inp: {
      value: inp,
      rating: inp === undefined ? 'unknown' : rate('INP', inp),
      interactions: inter.slice(0, 5).map((e) => ({
        step: stepAt(steps, e.t),
        type: e.name,
        target: e.target ?? inputTarget(raw, e.t),
        durationMs: e.duration,
        inputDelayMs: e.inputDelay,
        processingMs: e.processing,
        presentationMs: e.presentation,
        scripts: scriptsIn(loafs, e.t, e.t + e.duration, pageUrl),
      })),
    },
    lcp: lcp ? { timeMs: lcp.t, element: lcp.node ?? undefined, url: lcp.url || undefined } : undefined,
    mainThread: {
      longFrames: loafs.length,
      blockingMs: loafs.reduce((n, l) => n + l.blocking, 0),
      topScripts: [...scriptTotals.entries()]
        .sort((a, b) => b[1].totalMs - a[1].totalMs)
        .slice(0, 6)
        .map(([url, v]) => ({
          url,
          owner: attributeUrl(url, pageUrl),
          totalMs: v.totalMs,
          frames: v.frames,
          invoker: v.invoker,
          hotspot: { fn: v.fn, charPosition: v.pos, ms: v.maxMs },
        })),
    },
  };
}
