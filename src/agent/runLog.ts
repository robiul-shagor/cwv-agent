import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from '../lib/logger.js';
import type { RunResult } from './loop.js';
import { renderMarkdown, type Report } from './report.js';

/** Persists the full run (every step) as JSON — the audit trail until Postgres lands in Phase 2. */
export async function saveRunLog(run: RunResult, dir = 'runs'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${run.runId}.json`);
  await writeFile(path, redact(JSON.stringify(run, null, 2)) + '\n', 'utf8');
  return path;
}

export interface SavedReport {
  /** File base name shared by the .md and .json files: `<host>-<device>-<runId>`. */
  name: string;
  markdown: string;
  mdPath: string;
  jsonPath: string;
}

/** Writes the client-facing report as markdown + JSON. */
export async function saveReportFiles(
  run: RunResult & { report: Report },
  dir = 'reports',
): Promise<SavedReport> {
  const markdown = renderMarkdown(run.report, {
    generatedAt: run.finishedAt,
    model: run.model,
    toolCalls: run.toolCalls,
    source: run.source,
  });
  await mkdir(dir, { recursive: true });
  const name = `${new URL(run.url).hostname}-${run.device}-${run.runId}`;
  const mdPath = join(dir, `${name}.md`);
  const jsonPath = join(dir, `${name}.json`);
  await writeFile(mdPath, markdown, 'utf8');
  const meta = {
    generatedAt: run.finishedAt,
    model: run.model,
    toolCalls: run.toolCalls,
    source: run.source,
  };
  await writeFile(jsonPath, JSON.stringify({ ...run.report, meta }, null, 2) + '\n', 'utf8');
  return { name, markdown, mdPath, jsonPath };
}
