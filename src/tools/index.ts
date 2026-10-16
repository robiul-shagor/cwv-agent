import { z } from 'zod';
import type { ToolSpec } from '../agent/llm/types.js';
import { codeTools } from './code.js';
import { getCrux, getCruxHistory } from './crux.js';
import { fetchHtml } from './fetchHtml.js';
import { checkFieldFactors } from './fieldFactors.js';
import { checkLabIntegrity } from './labIntegrity.js';
import { inspectPlatform } from './platform.js';
import { getRum } from './rum.js';
import { inspectScript } from './script.js';
import { simulateSession } from './session.js';
import { runPagespeed } from './pagespeed.js';
import type { Tool } from './types.js';

export * from './types.js';

/** Registry of tools available to the agent. Add new tools here. */
export const tools: Tool<never>[] = [
  runPagespeed,
  getCrux,
  getCruxHistory,
  fetchHtml,
  checkFieldFactors,
  checkLabIntegrity,
  inspectPlatform,
  simulateSession,
  getRum,
  inspectScript,
] as Tool<never>[];

/** Measurement tools, plus code tools when a source folder/repository is linked. */
export function toolsFor(opts: { code: boolean }): Tool<never>[] {
  return opts.code ? [...tools, ...(codeTools as Tool<never>[])] : tools;
}

export function toToolSpec(tool: Pick<Tool, 'name' | 'description' | 'inputSchema'>): ToolSpec {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    unrepresentable: 'any',
  });
  return { name: tool.name, description: tool.description, parameters };
}
