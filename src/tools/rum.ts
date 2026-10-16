import { z } from 'zod';
import { summarizeRum, MIN_SAMPLES } from '../rum/aggregate.js';
import { RumStore } from '../rum/store.js';
import { normalizeUrl } from '../lib/url.js';
import { memo, type Tool } from './types.js';

const Input = z.object({
  url: z.string().min(1).describe('Page URL; its site is looked up in the collected RUM data'),
  days: z.number().int().min(1).max(90).default(28).describe('Window, default 28 days like CrUX'),
});

export const getRum: Tool<z.infer<typeof Input>> = {
  name: 'get_rum',
  description:
    "Get the site's own real-user monitoring data (web-vitals attribution build, collected by our RUM script): p75 LCP/" +
    'INP/CLS/FCP/TTFB per device and the attribution CrUX lacks — the elements causing layout shifts (and whether during ' +
    'or after load), the slowest interactions with their phases and the scripts (with owner) that blocked them, the LCP ' +
    'elements with subpart medians, navigation types and the worst pages. Page-level when the page has enough samples, ' +
    'otherwise site-level. Returns hasData=false when RUM is not installed on the site.',
  inputSchema: Input,
  async execute(input, ctx) {
    const url = normalizeUrl(input.url);
    if (!ctx.rumDataDir)
      return { hasData: false, message: 'RUM collection is not configured on this agent (RUM_DATA_DIR).' };
    return memo(ctx, `rum:${url.toString()}:${input.days}`, async () => {
      const store = new RumStore(ctx.rumDataDir!);
      const site = await store.findSite(url.hostname);
      const records = site ? await store.read(site, input.days) : [];
      if (!records.length) {
        return {
          hasData: false,
          message:
            `No RUM data for ${url.hostname} in the last ${input.days} days. Install the RUM script on the site ` +
            '(see README "RUM") to get element-level CLS, interaction-level INP and LCP attribution from real users.',
        };
      }
      const path = url.pathname;
      const pageRecords = records.filter((r) => {
        try {
          return new URL(r.url).pathname === path;
        } catch {
          return false;
        }
      });
      const pageLevel = pageRecords.filter((r) => r.name === 'LCP').length >= MIN_SAMPLES;
      return {
        hasData: true,
        site,
        ...summarizeRum(pageLevel ? pageRecords : records, {
          pageUrl: url.toString(),
          days: input.days,
          scope: pageLevel ? 'page' : 'site',
        }),
      };
    });
  },
};
