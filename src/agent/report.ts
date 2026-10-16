import { z } from 'zod';

const Rating = z.enum(['good', 'needs-improvement', 'poor', 'unknown']);

export const FindingSchema = z.object({
  metric: z.enum(['LCP', 'INP', 'CLS', 'TTFB', 'FCP', 'TBT', 'SI']),
  severity: z.enum(['high', 'medium', 'low']),
  rootCause: z.string().min(10).describe('The specific cause, not a generic tip'),
  evidence: z
    .array(z.string().min(5))
    .min(1)
    .describe(
      'Concrete data points with their source, e.g. "PSI: LCP element is img.hero, resource load delay 1.8s"',
    ),
  location: z
    .object({
      file: z.string().optional(),
      line: z.number().int().optional(),
      selector: z.string().optional(),
      resourceUrl: z.string().optional(),
      origin: z
        .string()
        .optional()
        .describe(
          'Only for findings about code. Exactly "repository" or "dependency <package>@<version> (package.json:<line>)", ' +
            'from inspect_script `origin`. Omit for server/CDN/third-party findings; put explanations in evidence.',
        ),
      owner: z
        .string()
        .optional()
        .describe(
          'Who owns the resource, from `owner` in tool output, e.g. "wp-plugin:elementor", "vendor:Hotjar"',
        ),
    })
    .nullable()
    .default(null)
    .describe('Where the problem lives (selector / resource URL until code access is available)'),
  fixType: z.enum(['auto', 'recommend', 'platform']),
  fix: z.string().min(10).describe('Precise, actionable fix'),
  patch: z.string().nullable().default(null),
  expectedImpact: z.string().describe('Estimated improvement, e.g. "LCP -0.8 to -1.2s"'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const ReportSchema = z.object({
  url: z.string(),
  device: z.enum(['mobile', 'desktop']),
  summary: z.string().min(20).describe('2-4 sentences: what fails, by how much, and the main cause'),
  status: z
    .object({ LCP: Rating, INP: Rating, CLS: Rating })
    .describe(
      'Field (CrUX) ratings when available, otherwise lab-based; INP is "unknown" without field data',
    ),
  statusSource: z.enum(['field-url', 'field-origin', 'lab']).describe('Where the status ratings come from'),
  assessment: z
    .object({
      result: z.enum(['passed', 'failed', 'no-data']),
      scope: z.enum(['url', 'origin', 'none']).describe('"origin" when the URL has no own CrUX data'),
      failing: z.array(z.enum(['LCP', 'INP', 'CLS'])).default([]),
    })
    .nullable()
    .default(null)
    .describe("Google's Core Web Vitals assessment, copied from get_crux `assessment`"),
  labFieldGap: z
    .array(
      z.object({
        metric: z.enum(['LCP', 'INP', 'CLS', 'TTFB']),
        lab: z.string().describe('Lab value/verdict, e.g. "PSI LCP 1.9s (good)"'),
        field: z.string().describe('Field value/verdict, e.g. "CrUX LCP p75 3.4s (NI)"'),
        explanation: z.string().min(10).describe('Why real users differ from the lab, with evidence'),
      }),
    )
    .default([])
    .describe('Metrics where lab and field disagree, and why'),
  labIntegrity: z
    .object({
      verdict: z.enum(['trustworthy', 'gamed', 'suspicious']),
      explanation: z
        .string()
        .min(10)
        .describe(
          'What check_lab_integrity found (cloaking, UA sniffing, JS delayed to interaction), with evidence',
        ),
    })
    .nullable()
    .default(null)
    .describe('Whether the PageSpeed lab score reflects what real users load, from check_lab_integrity'),
  findings: z.array(FindingSchema).describe('Ordered by expected impact, highest first'),
  notInCode: z
    .array(z.string())
    .default([])
    .describe('Issues outside the codebase: server, CDN, hosting, third-party vendors'),
  dataGaps: z
    .array(z.string())
    .default([])
    .describe(
      'Only evidence that is still missing AFTER running the tool that could close it (see "Closing data gaps")',
    ),
  nextSteps: z
    .array(z.string())
    .default([])
    .describe(
      'Actions for the site owner that would raise confidence, e.g. "Install the RUM script to confirm div.cookie-bar in the field"',
    ),
  verification: z.null().default(null),
});

export type Report = z.infer<typeof ReportSchema>;
export type Finding = z.infer<typeof FindingSchema>;

const BADGE: Record<string, string> = {
  good: '🟢 good',
  'needs-improvement': '🟠 needs improvement',
  poor: '🔴 poor',
  unknown: '⚪ unknown',
};

export function renderMarkdown(
  report: Report,
  meta?: { generatedAt?: string; model?: string; toolCalls?: number; source?: string },
): string {
  const lines: string[] = [];
  lines.push(`# Core Web Vitals diagnosis`, '');
  lines.push(`**URL:** ${report.url}  `);
  lines.push(`**Device:** ${report.device}  `);
  if (meta?.generatedAt) lines.push(`**Generated:** ${meta.generatedAt}  `);
  if (meta?.source) lines.push(`**Source code:** ${meta.source}  `);
  lines.push('', '## Summary', '', report.summary, '');
  lines.push(`## Status (${report.statusSource})`, '', '| Metric | Rating |', '|---|---|');
  for (const m of ['LCP', 'INP', 'CLS'] as const) lines.push(`| ${m} | ${BADGE[report.status[m]]} |`);
  lines.push('');

  if (report.assessment) {
    const a = report.assessment;
    const verdict =
      a.result === 'passed'
        ? '✅ Passed'
        : a.result === 'failed'
          ? `❌ Failed (${a.failing.join(', ')})`
          : '⚪ No data';
    lines.push(`**Core Web Vitals assessment (${a.scope}):** ${verdict}`, '');
  }
  if (report.labIntegrity && report.labIntegrity.verdict !== 'trustworthy') {
    const label = report.labIntegrity.verdict === 'gamed' ? '🚩 Gamed' : '⚠️ Suspicious';
    lines.push('## Is the PageSpeed score real?', '', `**${label}:** ${report.labIntegrity.explanation}`, '');
  }
  if (report.labFieldGap.length) {
    lines.push('## Why lab and field disagree', '', '| Metric | Lab | Field | Why |', '|---|---|---|---|');
    for (const g of report.labFieldGap)
      lines.push(`| ${g.metric} | ${g.lab} | ${g.field} | ${g.explanation.replace(/\|/g, '\\|')} |`);
    lines.push('');
  }

  lines.push('## Findings', '');
  if (report.findings.length === 0) lines.push('_No actionable findings._', '');
  report.findings.forEach((f, i) => {
    lines.push(`### ${i + 1}. [${f.metric}] ${f.rootCause}`, '');
    lines.push(
      `- **Severity:** ${f.severity} · **Confidence:** ${f.confidence} · **Fix type:** ${f.fixType}`,
    );
    lines.push(`- **Expected impact:** ${f.expectedImpact}`);
    const loc = f.location;
    if (loc && (loc.file || loc.selector || loc.resourceUrl || loc.owner || loc.origin)) {
      const parts = [
        loc.file ? `\`${loc.file}${loc.line ? `:${loc.line}` : ''}\`` : null,
        loc.selector ? `selector \`${loc.selector}\`` : null,
        loc.resourceUrl ? `resource ${loc.resourceUrl}` : null,
        loc.owner ? `owner **${loc.owner}**` : null,
        loc.origin ? `comes from **${loc.origin}**` : null,
      ].filter(Boolean);
      lines.push(`- **Location:** ${parts.join(', ')}`);
    }
    lines.push(`- **Fix:** ${f.fix}`);
    lines.push('- **Evidence:**');
    for (const e of f.evidence) lines.push(`  - ${e}`);
    if (f.patch) lines.push('', '```diff', f.patch, '```');
    lines.push('');
  });

  if (report.notInCode.length) {
    lines.push('## Outside the codebase', '');
    for (const n of report.notInCode) lines.push(`- ${n}`);
    lines.push('');
  }
  if (report.nextSteps.length) {
    lines.push('## Next steps to confirm', '');
    for (const n of report.nextSteps) lines.push(`- ${n}`);
    lines.push('');
  }
  if (report.dataGaps.length) {
    lines.push('## Data gaps', '');
    for (const g of report.dataGaps) lines.push(`- ${g}`);
    lines.push('');
  }
  lines.push(
    '---',
    '_Field data (CrUX) is a 28-day rolling window: improvements take up to ~4 weeks to fully appear in Search Console. ' +
      'No fix has been verified yet._',
  );
  if (meta?.model)
    lines.push(
      '',
      `<sub>Generated by CWV Agent · model ${meta.model} · ${meta.toolCalls ?? 0} tool calls</sub>`,
    );
  return lines.join('\n') + '\n';
}
