/**
 * CWV Agent RUM client (browser). Measures Core Web Vitals with `web-vitals/attribution` and sends
 * compact beacons to the CWV Agent collector.
 *
 * Install (async, anywhere in the page):
 *   <script async src="/cwv-rum.js"
 *     data-endpoint="https://collector.example.com/api/rum"
 *     data-key="pk_live_xxx"
 *     data-sample-rate="0.5"
 *     data-consent="required"></script>
 *
 * Or set `window.cwvRumConfig = { endpoint, key, ... }` before the script loads (tag managers).
 * With consent required, nothing leaves the browser until `window.cwvRum.consent()` is called.
 */
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals/attribution';
import { detectDevice, isSampled, sanitizeUrl, toRumMetric, type VitalsMetricLike } from './payload.js';
import { createReporter } from './reporter.js';

export interface RumConfig {
  /** Collector URL (POST). */
  endpoint: string;
  /** Public project key (not a secret). */
  key: string;
  /** 0–1, decided once per page view. Default 1. */
  sampleRate?: number;
  /** When true, beacons are held until `cwvRum.consent()` is called. Default false. */
  consentRequired?: boolean;
  /** Query parameters safe to keep in reported URLs (all others are stripped). */
  keepQueryParams?: string[];
  /** Log metrics to the console. */
  debug?: boolean;
}

interface CwvRumApi {
  consent(): void;
  revokeConsent(): void;
  flush(): void;
  readonly version: string;
}

declare global {
  interface Window {
    cwvRumConfig?: Partial<RumConfig>;
    cwvRum?: CwvRumApi;
  }
  interface Navigator {
    userAgentData?: { mobile?: boolean };
    connection?: { effectiveType?: string };
  }
}

const VERSION = '1.0.0';

function readConfig(script: HTMLScriptElement | null): RumConfig | null {
  const fromWindow = window.cwvRumConfig ?? {};
  const d = script?.dataset ?? {};
  const endpoint = fromWindow.endpoint ?? d.endpoint;
  const key = fromWindow.key ?? d.key;
  if (!endpoint || !key) return null;
  const rate = fromWindow.sampleRate ?? (d.sampleRate !== undefined ? Number(d.sampleRate) : 1);
  return {
    endpoint,
    key,
    sampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 1,
    consentRequired: fromWindow.consentRequired ?? d.consent === 'required',
    keepQueryParams:
      fromWindow.keepQueryParams ?? (d.keepQuery ? d.keepQuery.split(',').map((s) => s.trim()) : []),
    debug: fromWindow.debug ?? d.debug === 'true',
  };
}

function createTransport(endpoint: string) {
  return (body: string): boolean => {
    // text/plain keeps this a CORS "simple request": no preflight, works with sendBeacon cross-origin.
    const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
    try {
      if (navigator.sendBeacon?.(endpoint, blob)) return true;
    } catch {
      /* fall through to fetch */
    }
    try {
      void fetch(endpoint, {
        method: 'POST',
        body: blob,
        keepalive: true,
        credentials: 'omit',
        mode: 'no-cors',
      }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
}

export function start(config: RumConfig): CwvRumApi | null {
  const log = config.debug ? (...args: unknown[]) => console.log('[cwv-rum]', ...args) : () => {};
  if (!isSampled(config.sampleRate ?? 1)) {
    log('page view not sampled');
    return null;
  }

  let consented = !config.consentRequired;
  const reporter = createReporter({
    base: {
      key: config.key,
      url: sanitizeUrl(location.href, config.keepQueryParams) ?? location.origin,
      device: detectDevice(navigator.userAgent, navigator.userAgentData?.mobile),
      connection: navigator.connection?.effectiveType,
    },
    send: createTransport(config.endpoint),
    canSend: () => consented,
  });

  // Metrics are observed in memory regardless of consent; only sending is gated.
  const handle = (metric: VitalsMetricLike) => {
    const m = toRumMetric(metric);
    if (!m) return;
    log(m.name, m.value, m.rating, m.attribution);
    reporter.add(m);
  };
  onTTFB(handle);
  onFCP(handle);
  onLCP(handle);
  onCLS(handle);
  onINP(handle);

  // Registered after web-vitals' own listeners, so final CLS/INP values are queued before we flush.
  const flush = () => {
    const sent = reporter.flush();
    if (sent) log(`sent ${sent} metric(s)`);
  };
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  addEventListener('pagehide', flush);

  return {
    version: VERSION,
    consent() {
      consented = true;
      log('consent granted');
    },
    revokeConsent() {
      consented = false;
      log('consent revoked');
    },
    flush,
  };
}

// Auto-start from the <script> tag / window config. Never throw into the host page.
try {
  if (typeof window !== 'undefined' && !window.cwvRum) {
    const config = readConfig(document.currentScript as HTMLScriptElement | null);
    if (config) {
      const api = start(config);
      if (api) window.cwvRum = api;
      else window.cwvRum = { version: VERSION, consent() {}, revokeConsent() {}, flush() {} };
    } else {
      console.warn('[cwv-rum] missing data-endpoint or data-key; RUM disabled');
    }
  }
} catch (err) {
  console.warn('[cwv-rum] disabled due to error', err);
}
