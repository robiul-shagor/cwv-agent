import { EventEmitter } from 'node:events';
import { newRunId, runAgent, type AgentLimits, type RunResult, type RunStep } from '../agent/loop.js';
import type { LLMProvider, Usage } from '../agent/llm/types.js';
import type { Report } from '../agent/report.js';
import { saveReportFiles, saveRunLog } from '../agent/runLog.js';
import type { Logger } from '../lib/logger.js';
import { CODE_TOOL_CALL_BONUS, resolveSource, SourceError, type ResolvedSource } from '../source/index.js';
import { toolsFor } from '../tools/index.js';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Step as shown in the UI: no raw tool outputs (large, untrusted) — the report carries the evidence. */
export interface PublicStep {
  stepNo: number;
  kind: RunStep['kind'] | 'setup';
  toolName?: string;
  input?: unknown;
  durationMs: number;
  error?: string;
  note?: string;
  tokens?: number;
}

export interface RunOutcome {
  status: Exclude<RunStatus, 'running'>;
  error?: string;
  report?: Report;
  reportName?: string;
  toolCalls: number;
  usage: Usage;
  durationMs: number;
  /** Linked source code, if any. */
  source?: string;
}

export interface RunState {
  id: string;
  url: string;
  device: 'mobile' | 'desktop';
  /** Source spec as entered (local path or GitHub repo). */
  sourceSpec?: string;
  status: RunStatus;
  startedAt: string;
  steps: PublicStep[];
  outcome?: RunOutcome;
}

export type RunEvent = { type: 'step'; step: PublicStep } | { type: 'done'; outcome: RunOutcome };

export interface RunManagerDeps {
  provider: LLMProvider;
  /** Override the tool set (tests). Default: measurement tools + code tools when a source is linked. */
  tools?: (opts: { code: boolean }) => ReturnType<typeof toolsFor>;
  githubToken?: string;
  limits: AgentLimits;
  logger: Logger;
  googleApiKey?: string;
  chromePath?: string;
  rumDataDir?: string;
  reportsDir?: string;
  runsDir?: string;
  /** Concurrent runs allowed (PSI quota + LLM cost). Default 1. */
  maxConcurrent?: number;
  /** Finished runs kept in memory for reconnecting clients. Default 20. */
  maxRetained?: number;
}

export class BusyError extends Error {
  override name = 'BusyError';
}

interface Entry {
  state: RunState;
  controller: AbortController;
  events: EventEmitter;
}

function toPublicStep(step: RunStep): PublicStep {
  const base = { stepNo: step.stepNo, kind: step.kind, durationMs: step.durationMs, error: step.error };
  if (step.kind === 'llm') {
    const calls = (step.output as { toolCalls?: string[] } | undefined)?.toolCalls ?? [];
    return {
      ...base,
      tokens: step.usage?.totalTokens,
      note: calls.length ? `Requested ${calls.join(', ')}` : 'Responded without tool calls',
    };
  }
  if (step.kind === 'report')
    return { ...base, toolName: step.toolName, note: step.error ? 'Report rejected' : 'Report submitted' };
  return { ...base, toolName: step.toolName, input: step.input };
}

export class RunManager {
  private readonly runs = new Map<string, Entry>();

  constructor(private readonly deps: RunManagerDeps) {}

  get activeCount(): number {
    return [...this.runs.values()].filter((e) => e.state.status === 'running').length;
  }

  start(url: string, device: 'mobile' | 'desktop', sourceSpec?: string): RunState {
    if (this.activeCount >= (this.deps.maxConcurrent ?? 1)) {
      throw new BusyError('A diagnosis is already running. Wait for it to finish or cancel it.');
    }
    const id = newRunId();
    const entry: Entry = {
      state: {
        id,
        url,
        device,
        sourceSpec,
        status: 'running',
        startedAt: new Date().toISOString(),
        steps: [],
      },
      controller: new AbortController(),
      events: new EventEmitter(),
    };
    entry.events.setMaxListeners(50);
    this.runs.set(id, entry);
    this.prune();
    void this.execute(entry);
    return entry.state;
  }

  get(id: string): RunState | undefined {
    return this.runs.get(id)?.state;
  }

  cancel(id: string): boolean {
    const entry = this.runs.get(id);
    if (!entry || entry.state.status !== 'running') return false;
    entry.controller.abort(new Error('Cancelled by user'));
    return true;
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    const entry = this.runs.get(id);
    if (!entry) return () => {};
    entry.events.on('event', listener);
    return () => entry.events.off('event', listener);
  }

  shutdown(): void {
    for (const entry of this.runs.values()) {
      if (entry.state.status === 'running') entry.controller.abort(new Error('Server shutting down'));
    }
  }

  private emit(entry: Entry, event: RunEvent) {
    entry.events.emit('event', event);
  }

  private async execute(entry: Entry): Promise<void> {
    const { state } = entry;
    const t0 = performance.now();
    const log = this.deps.logger;
    let run: RunResult | undefined;
    let linked: ResolvedSource | undefined;
    let setupError: string | undefined;
    if (state.sourceSpec) {
      const s0 = performance.now();
      try {
        linked = await resolveSource(state.sourceSpec, {
          githubToken: this.deps.githubToken,
          signal: entry.controller.signal,
        });
      } catch (err) {
        setupError =
          err instanceof SourceError ? err.message : `Could not prepare source: ${(err as Error).message}`;
      }
      const step: PublicStep = {
        stepNo: 0,
        kind: 'setup',
        toolName: 'prepare_source',
        input: { source: state.sourceSpec },
        durationMs: Math.round(performance.now() - s0),
        note: linked ? `Linked ${linked.info.label}` : undefined,
        error: setupError,
      };
      state.steps.push(step);
      this.emit(entry, { type: 'step', step });
    }
    try {
      if (setupError) throw new SourceError(setupError);
      run = await runAgent({
        runId: state.id,
        url: state.url,
        device: state.device,
        provider: this.deps.provider,
        tools: (this.deps.tools ?? toolsFor)({ code: !!linked }),
        source: linked?.source,
        limits: {
          ...this.deps.limits,
          maxToolCalls: this.deps.limits.maxToolCalls + (linked ? CODE_TOOL_CALL_BONUS : 0),
        },
        logger: log,
        googleApiKey: this.deps.googleApiKey,
        chromePath: this.deps.chromePath,
        rumDataDir: this.deps.rumDataDir,
        signal: entry.controller.signal,
        onStep: (step) => {
          const pub = toPublicStep(step);
          state.steps.push(pub);
          this.emit(entry, { type: 'step', step: pub });
        },
      });
      await saveRunLog(run, this.deps.runsDir);
    } catch (err) {
      if (!(err instanceof SourceError))
        log.error('Run crashed', { runId: state.id, error: (err as Error).message });
    } finally {
      await linked?.cleanup().catch(() => {});
    }

    const cancelled = entry.controller.signal.aborted;
    const outcome: RunOutcome = {
      status: cancelled ? 'cancelled' : run?.status === 'completed' && run.report ? 'completed' : 'failed',
      error: cancelled ? 'Cancelled' : (setupError ?? run?.error),
      source: linked?.info.label,
      toolCalls: run?.toolCalls ?? 0,
      usage: run?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: Math.round(performance.now() - t0),
    };
    if (outcome.status === 'completed' && run?.report) {
      try {
        const saved = await saveReportFiles({ ...run, report: run.report }, this.deps.reportsDir);
        outcome.report = run.report;
        outcome.reportName = saved.name;
      } catch (err) {
        outcome.status = 'failed';
        outcome.error = `Could not save report: ${(err as Error).message}`;
      }
    }
    state.status = outcome.status;
    state.outcome = outcome;
    log.info('Run finished', { runId: state.id, status: outcome.status, ms: outcome.durationMs });
    this.emit(entry, { type: 'done', outcome });
    entry.events.removeAllListeners();
  }

  private prune() {
    const max = this.deps.maxRetained ?? 20;
    const finished = [...this.runs.values()].filter((e) => e.state.status !== 'running');
    for (const e of finished.slice(0, Math.max(0, finished.length - max))) this.runs.delete(e.state.id);
  }
}
