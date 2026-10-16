import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { assertPublicUrl } from './url.js';

/** Where the time to first byte goes for one fresh connection (no reuse): network vs server. */
export interface RequestTiming {
  status: number;
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  /** Request sent → first byte: server / edge processing (+ one round trip). */
  serverWaitMs: number;
  ttfbMs: number;
  serverTiming?: string;
}

/** One GET on a new connection with phase timestamps (headers only; the body is discarded). */
export async function timeRequest(
  rawUrl: string,
  userAgent: string,
  timeoutMs: number,
): Promise<RequestTiming> {
  const url = new URL(rawUrl);
  await assertPublicUrl(url);
  const t0 = performance.now();
  let dns = t0;
  let connect = t0;
  let tls = t0;
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        agent: false,
        headers: { 'User-Agent': userAgent, Accept: 'text/html,*/*;q=0.8', 'Accept-Encoding': 'gzip, br' },
        timeout: timeoutMs,
      },
      (res) => {
        const first = performance.now();
        res.destroy();
        const ms = (a: number, b: number) => Math.max(0, Math.round(b - a));
        const st = res.headers['server-timing'];
        resolve({
          status: res.statusCode ?? 0,
          dnsMs: ms(t0, dns),
          connectMs: ms(dns, connect),
          tlsMs: url.protocol === 'https:' ? ms(connect, tls) : 0,
          serverWaitMs: ms(url.protocol === 'https:' ? tls : connect, first),
          ttfbMs: ms(t0, first),
          serverTiming:
            typeof st === 'string'
              ? st.slice(0, 300)
              : Array.isArray(st)
                ? st.join(', ').slice(0, 300)
                : undefined,
        });
      },
    );
    req.on('socket', (socket: Socket) => {
      socket.once('lookup', () => (dns = performance.now()));
      socket.once('connect', () => {
        connect = performance.now();
        if (dns === t0) dns = connect; // IP literal or cached lookup
      });
      socket.once('secureConnect', () => (tls = performance.now()));
    });
    req.on('timeout', () => req.destroy(new Error('Timing request timed out')));
    req.on('error', reject);
    req.end();
  });
}
