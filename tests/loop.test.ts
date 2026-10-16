import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runAgent, type AgentLimits } from '../src/agent/loop.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../src/agent/llm/types.js';
import { silentLogger } from '../src/lib/logger.js';
import { memo, ToolError, type Tool } from '../src/tools/types.js';

const validReport = {
  url: 'https://example.com/',
  device: 'mobile',
  summary: 'LCP is poor at 4.1s p75 because the hero image is lazy-loaded.',
  status: { LCP: 'poor', INP: 'unknown', CLS: 'good' },
  statusSource: 'field-url',
  findings: [
    {
      metric: 'LCP',
      severity: 'high',
      rootCause: 'Hero image img.hero is lazy-loaded and discovered late',
      evidence: ['PSI: resource load delay 2100ms on img.hero'],
      location: { selector: 'img.hero' },
      fixType: 'auto',
      fix: 'Remove loading=lazy and add fetchpriority=high to img.hero',
      expectedImpact: 'LCP -1.0 to -1.5s',
      confidence: 'high',
    },
  ],
};

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function scripted(responses: Array<Partial<ChatResponse>>) {
  const requests: ChatRequest[] = [];
  const provider: LLMProvider = {
    name: 'fake',
    model: 'fake-1',
    chat: vi.fn(async (req: ChatRequest) => {
      requests.push(structuredClone(req));
      const r = responses.shift();
      if (!r) throw new Error('no more scripted responses');
      return { text: null, toolCalls: [], usage, finishReason: 'stop', ...r };
    }),
  };
  return { provider, requests };
}

const echoTool: Tool<{ q: string }> = {
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({ q: z.string() }),
  execute: vi.fn(async ({ q }) => ({ echoed: q })),
};

const limits: AgentLimits = { maxToolCalls: 5, maxTotalTokens: 100_000, toolTimeoutMs: 1000 };
const base = { url: 'https://example.com/', device: 'mobile' as const, logger: silentLogger, limits };

describe('runAgent', () => {
  it('runs tools, feeds back validation errors, and accepts a valid report', async () => {
    const { provider, requests } = scripted([
      {
        toolCalls: [
          { id: 'a', name: 'echo', args: { q: 'hi' } },
          { id: 'b', name: 'echo', args: { q: 1 } },
        ],
      },
      { toolCalls: [{ id: 'c', name: 'submit_report', args: { url: 'x' } }] },
      { toolCalls: [{ id: 'd', name: 'submit_report', args: validReport }] },
    ]);
    const run = await runAgent({ ...base, provider, tools: [echoTool] as Tool<never>[] });

    expect(run.status).toBe('completed');
    expect(run.report?.findings[0]?.location?.selector).toBe('img.hero');
    expect(run.report?.notInCode).toEqual([]);
    expect(run.toolCalls).toBe(2);
    expect(run.usage.totalTokens).toBe(45);

    const toolMsgs = requests[1]!.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs[0]).toMatchObject({ toolCallId: 'a', content: '{"echoed":"hi"}' });
    expect(toolMsgs[1]!.role === 'tool' && toolMsgs[1]!.content).toContain('Invalid arguments');
    const reportErr = requests[2]!.messages.at(-1);
    expect(reportErr).toMatchObject({ role: 'tool', toolCallId: 'c' });
    expect(reportErr?.role === 'tool' && reportErr.content).toContain('Report is invalid');

    expect(requests[0]!.tools.map((t) => t.name)).toEqual(['echo', 'submit_report']);
    expect(requests[0]!.tools[0]!.parameters).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
  });

  it('reports tool errors and unknown tools back to the model instead of crashing', async () => {
    const failing: Tool<Record<string, never>> = {
      name: 'fail',
      description: 'fails',
      inputSchema: z.object({}),
      execute: async () => {
        throw new ToolError('quota exceeded');
      },
    };
    const { provider, requests } = scripted([
      {
        toolCalls: [
          { id: 'a', name: 'fail', args: {} },
          { id: 'b', name: 'nope', args: {} },
        ],
      },
      { toolCalls: [{ id: 'c', name: 'submit_report', args: validReport }] },
    ]);
    const run = await runAgent({ ...base, provider, tools: [failing] as Tool<never>[] });
    expect(run.status).toBe('completed');
    const contents = requests[1]!.messages
      .filter((m) => m.role === 'tool')
      .map((m) => (m.role === 'tool' ? m.content : ''));
    expect(contents[0]).toContain('quota exceeded');
    expect(contents[1]).toContain('Unknown tool');
  });

  it('enforces the tool-call budget and asks for the report', async () => {
    const calls = Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`,
      name: 'echo',
      args: { q: String(i) },
    }));
    const { provider, requests } = scripted([
      { toolCalls: calls },
      { toolCalls: [{ id: 'x', name: 'echo', args: { q: 'more' } }] },
      { toolCalls: [{ id: 'r', name: 'submit_report', args: validReport }] },
    ]);
    const run = await runAgent({
      ...base,
      limits: { ...limits, maxToolCalls: 2 },
      provider,
      tools: [echoTool] as Tool<never>[],
    });
    expect(run.status).toBe('completed');
    expect(run.toolCalls).toBe(2);
    const second = requests[1]!.messages;
    expect(second.filter((m) => m.role === 'tool').at(-1)).toMatchObject({
      content: expect.stringContaining('budget exhausted'),
    });
    expect(second.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Budget exhausted'),
    });
  });

  it('fails after the model keeps replying with text', async () => {
    const { provider } = scripted([{ text: 'hello' }, { text: 'hello' }, { text: 'hello' }]);
    const run = await runAgent({ ...base, provider, tools: [] });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/without submitting/);
  });

  it('fails cleanly when the LLM errors', async () => {
    const provider: LLMProvider = {
      name: 'x',
      model: 'x',
      chat: async () => {
        throw new Error('proxy down');
      },
    };
    const run = await runAgent({ ...base, provider, tools: [] });
    expect(run).toMatchObject({ status: 'failed', error: 'proxy down' });
  });
});

describe('runAgent with linked source', () => {
  it('rejects reports citing files that do not exist, then accepts real locations', async () => {
    const source = {
      label: 'test-repo',
      exists: async (f: string) => f === 'src/Hero.tsx',
      readText: async () => null,
      readFile: async () => ({
        file: 'src/Hero.tsx',
        startLine: 1,
        endLine: 1,
        totalLines: 40,
        content: '',
        truncated: false,
      }),
      listFiles: async () => ({ files: [], truncated: false }),
      search: async () => ({ matches: [], truncated: false }),
    };
    const withLoc = (file: string, line: number) => ({
      ...validReport,
      findings: [{ ...validReport.findings[0]!, location: { file, line, selector: 'img.hero' } }],
    });
    const { provider, requests } = scripted([
      { toolCalls: [{ id: 'a', name: 'submit_report', args: withLoc('src/Invented.tsx', 3) }] },
      { toolCalls: [{ id: 'b', name: 'submit_report', args: withLoc('./src/Hero.tsx', 99) }] },
      { toolCalls: [{ id: 'c', name: 'submit_report', args: withLoc('./src/Hero.tsx', 12) }] },
    ]);
    const run = await runAgent({ ...base, provider, tools: [], source });
    expect(run.status).toBe('completed');
    expect(run.source).toBe('test-repo');
    expect(run.report?.findings[0]?.location).toMatchObject({ file: 'src/Hero.tsx', line: 12 });
    const err1 = requests[1]!.messages.at(-1);
    expect(err1?.role === 'tool' && err1.content).toContain('does not exist');
    const err2 = requests[2]!.messages.at(-1);
    expect(err2?.role === 'tool' && err2.content).toContain('> 40 lines');
    expect(requests[0]!.messages[0]).toMatchObject({
      content: expect.stringContaining('source code is linked: test-repo'),
    });
  });

  it('runs the tool calls of one turn in parallel and keeps results in call order', async () => {
    const slow = (name: string, ms: number): Tool<{ q: string }> => ({
      name,
      description: name,
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { q };
      },
    });
    const { provider, requests } = scripted([
      {
        toolCalls: [
          { id: 'a', name: 'slow_a', args: { q: 'first' } },
          { id: 'b', name: 'slow_b', args: { q: 'second' } },
        ],
      },
      { toolCalls: [{ id: 'r', name: 'submit_report', args: validReport }] },
    ]);
    const t0 = performance.now();
    const run = await runAgent({
      ...base,
      provider,
      tools: [slow('slow_a', 250), slow('slow_b', 250)] as Tool<never>[],
    });
    expect(run.status).toBe('completed');
    expect(performance.now() - t0).toBeLessThan(450); // sequential would be ≥ 500 ms
    const toolMsgs = requests[1]!.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.role === 'tool' && m.toolCallId)).toEqual(['a', 'b']);
  });

  it('prefetches CrUX/PSI at start and shares the result with the agent call', async () => {
    let executions = 0;
    const crux: Tool<{ url: string; scope: string; device: string }> = {
      name: 'get_crux',
      description: 'crux',
      inputSchema: z.object({
        url: z.string(),
        scope: z.string().default('url'),
        device: z.string().default('mobile'),
      }),
      execute: (input, ctx) =>
        memo(ctx, `crux:${input.scope}:${input.url}`, async () => {
          executions++;
          await new Promise((r) => setTimeout(r, 50));
          return { hasData: true };
        }),
    };
    const { provider } = scripted([
      {
        toolCalls: [
          {
            id: 'a',
            name: 'get_crux',
            args: { url: 'https://example.com/', scope: 'url', device: 'mobile' },
          },
        ],
      },
      { toolCalls: [{ id: 'r', name: 'submit_report', args: validReport }] },
    ]);
    const run = await runAgent({ ...base, provider, tools: [crux] as Tool<never>[] });
    expect(run.status).toBe('completed');
    // url + origin prefetched; the agent's url call reused the in-flight prefetch.
    expect(executions).toBe(2);
    expect(run.steps.find((s) => s.kind === 'tool')?.output).toEqual({ hasData: true });
  });
});
