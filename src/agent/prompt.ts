import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** System prompt = role/rules + every playbook markdown file. */
export function buildSystemPrompt(): string {
  const system = readFileSync(join(here, 'prompts', 'system.md'), 'utf8');
  const playbookDir = join(here, 'playbook');
  const playbook = readdirSync(playbookDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => readFileSync(join(playbookDir, f), 'utf8').trim())
    .join('\n\n');
  return `${system.trim()}\n\n# CWV playbook\n\n${playbook}\n`;
}

export function buildTaskPrompt(url: string, device: 'mobile' | 'desktop', sourceLabel?: string): string {
  const lines = [
    `Diagnose the Core Web Vitals of ${url} for ${device}.`,
    `Use device/strategy "${device}" for every tool call.`,
  ];
  if (sourceLabel) {
    lines.push(
      `The site's source code is linked: ${sourceLabel}.`,
      'After measuring, locate the exact code behind each finding with list_files / search_code / read_file, ' +
        'set location.file + location.line, and give a code-level fix (with a suggested diff in `patch` when it is a contained change).',
    );
  } else {
    lines.push('No source code is linked: locate issues by selector / resource URL only.');
  }
  lines.push('Gather evidence with the tools, then call submit_report with the final structured report.');
  return lines.join('\n');
}
