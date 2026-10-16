import { describe, expect, it } from 'vitest';
import { renderMarkdown, ReportSchema } from '../src/agent/report.js';

describe('report', () => {
  it('validates and renders markdown', () => {
    const report = ReportSchema.parse({
      url: 'https://example.com/',
      device: 'mobile',
      summary: 'CLS fails because the cookie banner pushes content down.',
      status: { LCP: 'good', INP: 'unknown', CLS: 'poor' },
      statusSource: 'lab',
      findings: [
        {
          metric: 'CLS',
          severity: 'high',
          rootCause: 'Cookie banner injected above content',
          evidence: ['PSI: layout shift 0.31 on div.cookie'],
          location: { selector: 'div.cookie' },
          fixType: 'recommend',
          fix: 'Render the banner as a fixed overlay',
          expectedImpact: 'CLS -0.3',
          confidence: 'medium',
        },
      ],
      dataGaps: ['No CrUX data'],
      assessment: { result: 'failed', scope: 'origin', failing: ['CLS'] },
      labFieldGap: [
        {
          metric: 'CLS',
          lab: 'PSI CLS 0.02',
          field: 'CrUX CLS 0.31',
          explanation: 'Banner shifts | after consent',
        },
      ],
    });
    const md = renderMarkdown(report, { model: 'm', toolCalls: 3 });
    expect(md).toContain('| CLS | 🔴 poor |');
    expect(md).toContain('### 1. [CLS] Cookie banner injected above content');
    expect(md).toContain('selector `div.cookie`');
    expect(md).toContain('## Data gaps');
    expect(md).toContain('**Core Web Vitals assessment (origin):** ❌ Failed (CLS)');
    expect(md).toContain('| CLS | PSI CLS 0.02 | CrUX CLS 0.31 | Banner shifts \\| after consent |');
  });

  it('rejects findings without evidence', () => {
    const r = ReportSchema.safeParse({
      url: 'x',
      device: 'mobile',
      summary: 'x'.repeat(30),
      status: { LCP: 'good', INP: 'good', CLS: 'good' },
      statusSource: 'lab',
      findings: [
        {
          metric: 'LCP',
          severity: 'low',
          rootCause: 'something long',
          evidence: [],
          fixType: 'auto',
          fix: 'do something',
          expectedImpact: '?',
          confidence: 'low',
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});
