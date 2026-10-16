import { describe, expect, it, vi } from 'vitest';
import { HttpError, isRetryable, withRetry } from '../src/lib/http.js';
import { createLogger, redact, registerSecrets } from '../src/lib/logger.js';
import { rate } from '../src/lib/cwv.js';
import { assertPublicUrl, isPrivateAddress, normalizeUrl } from '../src/lib/url.js';

describe('withRetry', () => {
  it('retries transient errors then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('boom', 503, ''))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors or daily quota exhaustion', async () => {
    expect(isRetryable(new HttpError('x', 400, ''))).toBe(false);
    expect(isRetryable(new HttpError('x', 429, "limit 'Queries per day'"))).toBe(false);
    expect(isRetryable(new HttpError('x', 429, 'per minute'))).toBe(true);
    const fn = vi.fn().mockRejectedValue(new HttpError('bad', 400, ''));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow('bad');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('logger redaction', () => {
  it('removes registered secrets and key query params', () => {
    registerSecrets(['super-secret-token']);
    expect(redact('auth super-secret-token ?key=AIza123&x=1')).toBe('auth [REDACTED] ?key=[REDACTED]&x=1');
    const lines: string[] = [];
    createLogger('info', (l) => lines.push(l)).info('call', { url: 'https://x?key=abc' });
    expect(lines[0]).toContain('key=[REDACTED]');
  });
});

describe('cwv rating', () => {
  it('uses inclusive good thresholds', () => {
    expect(rate('LCP', 2500)).toBe('good');
    expect(rate('LCP', 2501)).toBe('needs-improvement');
    expect(rate('CLS', 0.26)).toBe('poor');
    expect(rate('INP', 200)).toBe('good');
  });
});

describe('url safety', () => {
  it('normalises and rejects bad schemes', () => {
    expect(normalizeUrl('example.com/a#x').toString()).toBe('https://example.com/a');
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeUrl('https://u:p@example.com')).toThrow();
  });

  it('detects private addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '172.20.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });

  it('blocks hosts resolving to private IPs', async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertPublicUrl(new URL('https://evil.example'), resolver as never)).rejects.toThrow(
      /private/,
    );
    await expect(assertPublicUrl(new URL('http://localhost:3000'))).rejects.toThrow(/non-public/);
    await expect(assertPublicUrl(new URL('http://169.254.169.254/latest'))).rejects.toThrow(/private/);
  });
});
