import { silentLogger } from '../src/lib/logger.js';
import type { ToolContext } from '../src/tools/types.js';

export const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  googleApiKey: 'test-google-key-123',
  timeoutMs: 5000,
  logger: silentLogger,
  cache: new Map(),
  ...over,
});

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
