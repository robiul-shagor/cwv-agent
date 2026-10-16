import { RUM_PAYLOAD_VERSION, type RumMetric, type RumPayload } from './payload.js';

export interface ReporterOptions {
  /** Static per-page-view fields. */
  base: Omit<RumPayload, 'v' | 'metrics'>;
  /** Transport; returns false if the send could not be queued. */
  send: (body: string) => boolean;
  /** Called before every flush; nothing is sent while it returns false (consent). */
  canSend?: () => boolean;
  /** Safety cap per beacon (sendBeacon/keepalive bodies are limited to 64 KB). */
  maxBatch?: number;
}

/** Collects metrics and sends them in batches; a metric re-reported with the same id replaces the old one. */
export function createReporter(opts: ReporterOptions) {
  const queue = new Map<string, RumMetric>();
  const maxBatch = opts.maxBatch ?? 20;

  return {
    add(metric: RumMetric) {
      queue.set(`${metric.name}:${metric.id}`, metric);
    },
    get size() {
      return queue.size;
    },
    /** Sends queued metrics. Returns the number of metrics handed to the transport. */
    flush(): number {
      if (queue.size === 0 || (opts.canSend && !opts.canSend())) return 0;
      const metrics = [...queue.values()];
      let sent = 0;
      for (let i = 0; i < metrics.length; i += maxBatch) {
        const batch = metrics.slice(i, i + maxBatch);
        const payload: RumPayload = { v: RUM_PAYLOAD_VERSION, ...opts.base, metrics: batch };
        if (!opts.send(JSON.stringify(payload))) break;
        for (const m of batch) queue.delete(`${m.name}:${m.id}`);
        sent += batch.length;
      }
      return sent;
    },
  };
}
