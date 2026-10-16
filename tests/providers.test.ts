import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/agent/llm/openai.js';
import { LLMError } from '../src/agent/llm/types.js';
import { jsonResponse } from './helpers.js';

describe('OpenAICompatibleProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://proxy.test/v1/',
    apiKey: 'sk-test-12345',
    model: 'gpt-6-luna',
    attempts: 1,
  });

  it('maps messages/tools to the OpenAI wire format and parses tool calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'run_pagespeed', arguments: '{"url":"https://a.com"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await provider.chat({
      system: 'sys',
      tools: [{ name: 'run_pagespeed', description: 'd', parameters: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c0', name: 'get_crux', args: { url: 'x' } }] },
        { role: 'tool', toolCallId: 'c0', name: 'get_crux', content: '{}' },
      ],
    });

    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'run_pagespeed', args: { url: 'https://a.com' } }]);
    expect(res.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://proxy.test/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test-12345');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: 'get_crux', arguments: '{"url":"x"}' });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c0', content: '{}' });
    expect(body.tools[0].type).toBe('function');
  });

  it('adds cache breakpoints on the system prompt and newest message, and reads cached usage', async () => {
    const cached = new OpenAICompatibleProvider({
      baseUrl: 'https://proxy.test/v1',
      apiKey: 'k',
      model: 'm',
      attempts: 1,
      promptCache: true,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        usage: {
          prompt_tokens: 9000,
          completion_tokens: 5,
          total_tokens: 9005,
          prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 900 },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await cached.chat({
      system: 'sys',
      tools: [],
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c0', name: 'get_crux', args: {} }] },
        { role: 'tool', toolCallId: 'c0', name: 'get_crux', content: '{"a":1}' },
      ],
    });
    expect(res.usage).toMatchObject({ cachedInputTokens: 8000, cacheWriteTokens: 900 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const bp = { type: 'ephemeral' };
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'sys', cache_control: bp }]);
    expect(body.messages[1].content).toBe('go'); // only the newest message carries the moving breakpoint
    expect(body.messages[3].content).toEqual([{ type: 'text', text: '{"a":1}', cache_control: bp }]);
  });

  it('wraps HTTP failures in LLMError without leaking the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'model not allowed' } }, 403)),
    );
    const err = await provider.chat({ system: 's', messages: [], tools: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.message).toContain('model not allowed');
    expect(err.message).not.toContain('sk-test-12345');
  });

  it('passes malformed tool arguments through for validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{bad' } }],
              },
            },
          ],
        }),
      ),
    );
    const res = await provider.chat({ system: 's', messages: [], tools: [] });
    expect(res.toolCalls[0]!.args).toEqual({ __invalidJson: '{bad' });
  });
});
