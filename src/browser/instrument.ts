/**
 * In-page instrumentation injected before any page script runs (Playwright `addInitScript`).
 * Records every layout shift (with sources), event-timing entries (interactions), long animation frames
 * (with script attribution) and LCP candidates into `window.__cwv`. Plain ES2020 string: no bundling needed.
 */
export const INSTRUMENT_SCRIPT = String.raw`(() => {
  if (window.__cwv) return;
  const data = { doc: Math.random().toString(36).slice(2), steps: [], shifts: [], events: [], loafs: [], lcp: [], mutations: [], inputs: [] };
  window.__cwv = data;

  const sel = (n) => {
    if (!n) return null;
    if (n.nodeType === 3) n = n.parentElement;
    if (!n || n.nodeType !== 1) return null;
    const parts = [];
    for (let el = n, i = 0; el && el.nodeType === 1 && i < 4; i++, el = el.parentElement) {
      let s = el.tagName.toLowerCase();
      if (el.id && !/\d{4,}/.test(el.id)) { parts.unshift(s + '#' + CSS.escape(el.id)); break; }
      const cls = [...el.classList].filter((c) => !/^(is-|has-|js-)|\d{4,}|^[a-z]{1,2}-?[0-9a-f]{5,}$/i.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
      parts.unshift(s);
    }
    return parts.join(' > ').slice(0, 200);
  };
  const r = (x) => Math.round(x);
  const observe = (type, cb, extra) => {
    try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...extra }); } catch {}
  };

  // Shift sources are the elements that MOVED; the cause is usually content inserted/resized just before.
  const sizeOf = (el) => { try { return Math.round(el.getBoundingClientRect().height); } catch { return 0; } };
  const onMutations = (list) => {
    if (data.mutations.length > 400) return;
    const t = Math.round(performance.now());
    for (const m of list) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1) { const h = sizeOf(n); if (h >= 10) data.mutations.push({ t, kind: 'inserted', node: sel(n), h }); }
      } else if (m.target.nodeType === 1) {
        const h = sizeOf(m.target);
        if (h >= 10) data.mutations.push({ t, kind: 'resized/restyled', node: sel(m.target), h });
      }
    }
  };
  const startMO = () => new MutationObserver(onMutations).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'height', 'src'] });
  if (document.documentElement) startMO(); else addEventListener('DOMContentLoaded', startMO, { once: true });
  // Remember input targets: Event Timing loses the target when a handler removes it (e.g. consent button).
  for (const type of ['pointerdown', 'click', 'keydown']) {
    addEventListener(type, (e) => { if (data.inputs.length < 50) data.inputs.push({ t: Math.round(e.timeStamp), node: sel(e.target) }); }, { capture: true });
  }

  observe('layout-shift', (e) => {
    data.shifts.push({
      t: r(e.startTime), value: e.value, input: e.hadRecentInput,
      sources: (e.sources || []).slice(0, 3).map((s) => ({
        node: sel(s.node),
        dy: r(s.currentRect.y - s.previousRect.y),
        dh: r(s.currentRect.height - s.previousRect.height),
        h: r(s.currentRect.height),
      })),
    });
  });
  observe('event', (e) => {
    if (!e.interactionId) return;
    data.events.push({
      id: e.interactionId, name: e.name, t: r(e.startTime), duration: r(e.duration),
      inputDelay: r(e.processingStart - e.startTime),
      processing: r(e.processingEnd - e.processingStart),
      presentation: r(e.startTime + e.duration - e.processingEnd),
      target: sel(e.target),
    });
  }, { durationThreshold: 16 });
  observe('long-animation-frame', (e) => {
    data.loafs.push({
      t: r(e.startTime), duration: r(e.duration), blocking: r(e.blockingDuration || 0),
      scripts: (e.scripts || []).slice(0, 5).map((s) => ({
        url: (s.sourceURL || '').split(/[?#]/)[0].slice(0, 200),
        fn: (s.sourceFunctionName || '').slice(0, 60),
        invoker: (s.invoker || '').replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 120),
        type: s.invokerType, duration: r(s.duration), pos: s.sourceCharPosition >= 0 ? s.sourceCharPosition : undefined,
      })),
    });
  });
  observe('largest-contentful-paint', (e) => {
    data.lcp.push({ t: r(e.startTime), node: sel(e.element), size: e.size, url: (e.url || '').split(/[?#]/)[0].slice(0, 200) });
  });
})();`;

/** Shapes of what the script above records (read back with `page.evaluate`). */
export interface RawShift {
  t: number;
  value: number;
  input: boolean;
  sources: Array<{ node: string | null; dy: number; dh: number; h: number }>;
}
export interface RawEvent {
  id: number;
  name: string;
  t: number;
  duration: number;
  inputDelay: number;
  processing: number;
  presentation: number;
  target: string | null;
}
export interface RawLoaf {
  t: number;
  duration: number;
  blocking: number;
  scripts: Array<{ url: string; fn: string; invoker: string; type: string; duration: number; pos?: number }>;
}
export interface RawLcp {
  t: number;
  node: string | null;
  size: number;
  url: string;
}
export interface RawMutation {
  t: number;
  kind: 'inserted' | 'resized/restyled';
  node: string | null;
  h: number;
}
export interface RawSession {
  doc: string;
  mutations?: RawMutation[];
  inputs?: Array<{ t: number; node: string | null }>;
  steps: Array<{ name: string; t: number }>;
  shifts: RawShift[];
  events: RawEvent[];
  loafs: RawLoaf[];
  lcp: RawLcp[];
}

/** In-page expressions for `page.evaluate` (strings: server code is compiled without DOM types). */
export const PAGE_JS = {
  mark: (name: string) =>
    `window.__cwv && window.__cwv.steps.push({ name: ${JSON.stringify(name)}, t: Math.round(performance.now()) })`,
  atBottom: 'innerHeight + scrollY >= document.documentElement.scrollHeight - 5',
  scrollTop: 'scrollTo(0, 0)',
  read: 'window.__cwv',
  /** First same-site link that is not this page, an anchor or an account/cart page. */
  sameSiteLink: (origin: string) => `(() => {
    const o = ${JSON.stringify(origin)};
    const here = location.href.split(/[?#]/)[0];
    const a = [...document.querySelectorAll('a[href]')].find((x) =>
      x.href.startsWith(o) && !x.href.includes('#') && x.href.split('?')[0] !== here &&
      !/logout|cart|checkout|account|wp-admin|login/i.test(x.href));
    return a ? a.href : null;
  })()`,
  /** After history.back(): same document id = restored from bfcache; else Chrome's notRestoredReasons. */
  bfcacheCheck: `(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const nrr = nav && nav.notRestoredReasons;
    const reasons = [];
    if (nrr) {
      for (const r of nrr.reasons || []) reasons.push(r.reason);
      for (const c of nrr.children || []) for (const r of c.reasons || []) reasons.push(r.reason + ' (iframe ' + (c.src || c.url || '') + ')');
    }
    return { doc: window.__cwv && window.__cwv.doc, reasons };
  })()`,
};
