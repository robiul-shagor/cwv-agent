import { z } from 'zod';
import { summarizeSession } from '../browser/analyze.js';
import { runSession } from '../browser/session.js';
import { normalizeUrl, UnsafeUrlError } from '../lib/url.js';
import { memo, ToolError, type Tool, urlKey } from './types.js';

const Input = z.object({
  url: z.string().min(1).describe('Absolute URL of the page'),
  device: z.enum(['mobile', 'desktop']).default('mobile'),
});

export const simulateSession: Tool<z.infer<typeof Input>> = {
  name: 'simulate_session',
  description:
    'Play a realistic user visit in real Chrome (mobile: 4x CPU slowdown + slow 4G) and record what PSI misses: ' +
    'load → 4 s idle → accept consent banner → scroll to bottom and back → open/close menu → toggle accordions/tabs → ' +
    'navigate away and back. Returns session CLS with every shift attributed to the step that caused it (load / ' +
    'post-load-idle / consent / scroll / menu / widgets) and the element that moved; INP of the simulated interactions ' +
    'with input delay / processing / presentation and the scripts (with owner) that ran; the LCP element; scripts in ' +
    "long animation frames; and a real back/forward-cache test with Chrome's not-restored reasons. Takes 30-60 s. " +
    'Use it whenever CLS or INP fail in the field, or to confirm bfcache.',
  inputSchema: Input,
  async execute(input, ctx) {
    return memo(ctx, `session:${input.device}:${urlKey(input.url)}`, async () => {
      try {
        const result = await runSession({
          url: normalizeUrl(input.url).toString(),
          device: input.device,
          chromePath: ctx.chromePath,
          timeoutMs: Math.max(ctx.timeoutMs, 60_000),
          signal: ctx.signal,
          logger: ctx.logger,
        });
        return {
          source:
            'Simulated session in real Chrome (lab, one visit). Shows WHICH elements/scripts shift or block during a ' +
            'realistic visit; field CrUX/RUM still decides how often it happens to real users.',
          device: input.device,
          finalUrl: result.finalUrl,
          steps: result.steps,
          ...summarizeSession(result.raw, result.finalUrl),
          bfcache: result.bfcache,
        };
      } catch (err) {
        if (err instanceof UnsafeUrlError) throw new ToolError(err.message);
        if (err instanceof Error && /Chrome|Timeout|net::ERR|Target .*closed/i.test(err.message)) {
          throw new ToolError(`Browser session failed: ${err.message.split('\n')[0]}`);
        }
        throw err;
      }
    });
  },
};
