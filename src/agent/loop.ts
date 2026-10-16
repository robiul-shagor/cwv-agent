import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Logger } from '../lib/logger.js';
import type { CodeSource } from '../source/types.js';
import { toToolSpec, ToolError, type Tool, type ToolContext } from '../tools/index.js';
import type { ChatMessage, LLMProvider, ToolCall, Usage } from './llm/types.js';
import { buildSystemPrompt, buildTaskPrompt } from './prompt.js';
import { ReportSchema, type Report } from './report.js';

export const SUBMIT_REPORT = 'submit_report';
const MAX_TOOL_OUTPUT_CHARS = 30_000;
const MAX_REPORT_ATTEMPTS = 3;
const MAX_NUDGES = 2;

export interface AgentLimits {
  maxToolCalls: number;
  maxTotalTokens: number;
  toolTimeoutMs: number;
}

export interface RunStep {
  stepNo: number;
  kind: 'llm' | 'tool' | 'report';
  startedAt: string;
  durationMs: number;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  reasoning?: string | null;
  usage?: Usage;
}

export interface RunResult {
  runId: string;
  status: 'completed' | 'failed';
  url: string;
  device: 'mobile' | 'desktop';
  model: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  toolCalls: number;
  usage: Usage;
  steps: RunStep[];
  report?: Report;
  error?: string;
  /** Linked source code, if any. */
  source?: string;
}

export interface RunAgentOptions {
  url: string;
  device: 'mobile' | 'desktop';
  provider: LLMProvider;
  tools: Tool<never>[];
  limits: AgentLimits;
  logger: Logger;
  googleApiKey?: string;
  chromePath?: string;
  rumDataDir?: string;
  /** Linked project source (enables code tools + location checks). */
  source?: CodeSource;
  signal?: AbortSignal;
  onStep?: (step: RunStep) => void;
  /** Caller-supplied id (e.g. so a UI can subscribe before the run starts). */
  runId?: string;
  /** Start the always-needed measurements (CrUX, PSI, session) before the first LLM turn. Default true. */
  prefetch?: boolean;
}

/** Calls every diagnosis makes: started at t=0 so they overlap with the first LLM turn (results land in the memo). */
const PREFETCH: Array<{
  tool: string;
  args: (url: string, device: 'mobile' | 'desktop') => Record<string, unknown>;
}> = [
  { tool: 'get_crux', args: (url, device) => ({ url, scope: 'url', device }) },
  { tool: 'get_crux', args: (url, device) => ({ url, scope: 'origin', device }) },
  { tool: 'run_pagespeed', args: (url, device) => ({ url, strategy: device }) },
  { tool: 'simulate_session', args: (url, device) => ({ url, device }) },
  { tool: 'check_lab_integrity', args: (url, device) => ({ url, device }) },
];

/** Tokens counted against the budget: cached input costs ~10% of fresh input. */
function budgetTokens(u: Usage): number {
  return u.totalTokens - Math.round(0.9 * (u.cachedInputTokens ?? 0));
}

/** Sortable, filesystem-safe run id: ISO timestamp + random suffix. */
export function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
}

export class AgentError extends Error {
  override name = 'AgentError';
}

const submitReportTool = {
  name: SUBMIT_REPORT,
  description:
    'Submit the final diagnosis report. Call exactly once, after gathering evidence. The run ends when a valid report is submitted.',
  inputSchema: ReportSchema,
};

function stringifyOutput(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json.length > MAX_TOOL_OUTPUT_CHARS
    ? json.slice(0, MAX_TOOL_OUTPUT_CHARS) + '…[truncated: output exceeded size limit]'
    : json;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 15)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const { provider, limits, logger } = opts;
  const runId = opts.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
  const steps: RunStep[] = [];
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t as Tool<unknown>]));
  const toolSpecs = [...opts.tools.map(toToolSpec), toToolSpec(submitReportTool)];
  const system = buildSystemPrompt();
  const messages: ChatMessage[] = [
    { role: 'user', content: buildTaskPrompt(opts.url, opts.device, opts.source?.label) },
  ];
  const toolCtx: ToolContext = {
    googleApiKey: opts.googleApiKey,
    signal: opts.signal,
    timeoutMs: limits.toolTimeoutMs,
    logger,
    cache: new Map(),
    source: opts.source,
    chromePath: opts.chromePath,
    rumDataDir: opts.rumDataDir,
  };

  let toolCalls = 0;
  let reportAttempts = 0;
  let nudges = 0;
  let budgetWarned = false;

  const record = (step: Omit<RunStep, 'stepNo'>) => {
    const full = { stepNo: steps.length + 1, ...step };
    steps.push(full);
    opts.onStep?.(full);
    return full;
  };

  const finish = (status: RunResult['status'], extra: Partial<RunResult>): RunResult => ({
    runId,
    status,
    url: opts.url,
    device: opts.device,
    model: provider.model,
    provider: provider.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    toolCalls,
    usage,
    steps,
    source: opts.source?.label,
    ...extra,
  });

  if (opts.prefetch ?? true) {
    for (const p of PREFETCH) {
      const tool = toolsByName.get(p.tool);
      const input = tool?.inputSchema.safeParse(p.args(opts.url, opts.device));
      // Errors are ignored here: the agent's own call reports them (or retries, for non-cached failures).
      if (tool && input?.success) void tool.execute(input.data, toolCtx).catch(() => {});
    }
  }

  // Hard ceiling on LLM turns so a misbehaving model can't loop forever.
  const maxTurns = limits.maxToolCalls + MAX_REPORT_ATTEMPTS + MAX_NUDGES + 3;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      opts.signal?.throwIfAborted();

      const overBudget = toolCalls >= limits.maxToolCalls || budgetTokens(usage) >= limits.maxTotalTokens;
      if (overBudget && !budgetWarned) {
        budgetWarned = true;
        logger.warn('Budget reached — asking the model to submit its report', {
          toolCalls,
          tokens: budgetTokens(usage),
        });
        messages.push({
          role: 'user',
          content:
            `Budget exhausted (tool calls ${toolCalls}/${limits.maxToolCalls}, tokens ${budgetTokens(usage)}). ` +
            `Call ${SUBMIT_REPORT} now with the evidence you have; list missing evidence in dataGaps.`,
        });
      }
      if (budgetTokens(usage) >= limits.maxTotalTokens * 1.25) {
        throw new AgentError(`Token budget exceeded (${budgetTokens(usage)} tokens) without a valid report`);
      }

      const t0 = performance.now();
      const res = await provider.chat({ system, messages, tools: toolSpecs, signal: opts.signal });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.totalTokens += res.usage.totalTokens;
      usage.cachedInputTokens! += res.usage.cachedInputTokens ?? 0;
      usage.cacheWriteTokens! += res.usage.cacheWriteTokens ?? 0;
      record({
        kind: 'llm',
        startedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        reasoning: res.text,
        usage: res.usage,
        output: { toolCalls: res.toolCalls.map((c) => c.name), finishReason: res.finishReason },
      });
      logger.info(`LLM turn ${turn + 1}`, {
        tools: res.toolCalls.map((c) => c.name),
        tokens: res.usage.totalTokens,
        cached: res.usage.cachedInputTokens,
        ms: Math.round(performance.now() - t0),
      });

      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

      if (res.toolCalls.length === 0) {
        if (++nudges > MAX_NUDGES) throw new AgentError('Model stopped without submitting a report');
        messages.push({
          role: 'user',
          content: `Do not reply with text. Continue investigating with tools or call ${SUBMIT_REPORT} with the final report.`,
        });
        continue;
      }

      // Independent tool calls of one turn run concurrently; results go back in call order.
      const toolResults = await Promise.all(
        res.toolCalls.filter((c) => c.name !== SUBMIT_REPORT).map(handleToolCall),
      );
      messages.push(...toolResults);
      for (const call of res.toolCalls.filter((c) => c.name === SUBMIT_REPORT)) {
        const report = await handleReport(call);
        if (report) return finish('completed', { report });
      }
    }
    throw new AgentError(`Exceeded ${maxTurns} LLM turns without a valid report`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Agent run failed', { error: message });
    return finish('failed', { error: message });
  }

  /** Rejects findings that cite files/lines that don't exist in the linked source. */
  async function checkLocations(report: Report): Promise<string | null> {
    if (!opts.source) return null;
    const problems: string[] = [];
    for (const [i, f] of report.findings.entries()) {
      const file = f.location?.file?.replace(/^\.\//, '');
      if (!file) continue;
      if (!(await opts.source.exists(file))) {
        problems.push(`findings.${i}.location.file "${file}" does not exist in the source`);
        continue;
      }
      if (f.location?.line) {
        const { totalLines } = await opts.source.readFile(file, 1, 1);
        if (f.location.line > totalLines)
          problems.push(`findings.${i}.location.line ${f.location.line} > ${totalLines} lines in ${file}`);
      }
      f.location!.file = file;
    }
    return problems.length
      ? `${problems.join('; ')}. Only cite files/lines you found with search_code/read_file.`
      : null;
  }

  async function handleReport(call: ToolCall): Promise<Report | null> {
    reportAttempts++;
    const parsed = ReportSchema.safeParse(call.args);
    const locationError = parsed.success ? await checkLocations(parsed.data) : null;
    if (parsed.success && !locationError) {
      const report = { ...parsed.data, device: opts.device };
      record({
        kind: 'report',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        toolName: SUBMIT_REPORT,
        input: report,
      });
      logger.info('Report submitted', { findings: report.findings.length });
      return report;
    }
    const error = locationError ?? formatZodError(parsed.error!);
    record({
      kind: 'report',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      toolName: SUBMIT_REPORT,
      error,
    });
    logger.warn('Report failed validation', { attempt: reportAttempts, error });
    if (reportAttempts >= MAX_REPORT_ATTEMPTS) {
      throw new AgentError(`Report failed validation ${MAX_REPORT_ATTEMPTS} times: ${error}`);
    }
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify({ error: `Report is invalid, fix and resubmit: ${error}` }),
    });
    return null;
  }

  async function handleToolCall(call: ToolCall): Promise<ChatMessage> {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    let output: unknown;
    let error: string | undefined;

    const tool = toolsByName.get(call.name);
    if (!tool) {
      error = `Unknown tool "${call.name}". Available: ${[...toolsByName.keys(), SUBMIT_REPORT].join(', ')}`;
    } else if (toolCalls >= limits.maxToolCalls) {
      error = `Tool budget exhausted (${limits.maxToolCalls} calls). Call ${SUBMIT_REPORT} now.`;
    } else {
      toolCalls++;
      const input = tool.inputSchema.safeParse(call.args);
      if (!input.success) {
        error = `Invalid arguments: ${formatZodError(input.error)}`;
      } else {
        try {
          const hardTimeout = AbortSignal.timeout(limits.toolTimeoutMs * 3);
          const signal = opts.signal ? AbortSignal.any([opts.signal, hardTimeout]) : hardTimeout;
          output = await Promise.race([
            tool.execute(input.data, { ...toolCtx, signal }),
            new Promise<never>((_, reject) =>
              signal.addEventListener('abort', () => reject(new ToolError(`Tool timed out`)), { once: true }),
            ),
          ]);
        } catch (err) {
          opts.signal?.throwIfAborted();
          error = err instanceof Error ? err.message : String(err);
          if (!(err instanceof ToolError)) logger.error(`Tool ${call.name} crashed`, { error });
        }
      }
    }

    const durationMs = Math.round(performance.now() - t0);
    record({ kind: 'tool', startedAt, durationMs, toolName: call.name, input: call.args, output, error });
    if (error) logger.warn(`Tool ${call.name} failed`, { error, ms: durationMs });
    else logger.info(`Tool ${call.name} ok`, { ms: durationMs });

    return {
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: error ? JSON.stringify({ error }) : stringifyOutput(output),
    };
  }
}
