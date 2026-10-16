import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}

/** Parses and normalises a public http(s) URL. Adds https:// when the scheme is missing. */
export function normalizeUrl(input: string): URL {
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Only http(s) URLs are supported: ${input}`);
  }
  if (url.username || url.password) throw new UnsafeUrlError('URLs with credentials are not allowed');
  url.hash = '';
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('ff')
    );
  }
  return false;
}

/**
 * Guards against SSRF: the agent fetches URLs chosen by an LLM that reads untrusted pages,
 * so we refuse anything resolving to loopback/private/link-local ranges.
 */
export async function assertPublicUrl(url: URL, resolver: typeof lookup = lookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new UnsafeUrlError(`Refusing to fetch non-public host: ${host}`);
  }
  const addresses = isIP(host) ? [{ address: host }] : await resolver(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new UnsafeUrlError(`Could not resolve host: ${host}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new UnsafeUrlError(`Refusing to fetch private address for ${host}`);
  }
}
