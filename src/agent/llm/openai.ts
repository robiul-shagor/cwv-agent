import { fetchJson, HttpError } from '../../lib/http.js';
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, ToolCall } from './types.js';
import { LLMError } from './types.js';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  attempts?: number;
  /**
   * Mark the system prompt and the newest message with `cache_control` breakpoints so the gateway serves the
   * repeated conversation prefix from its prompt cache (the proxy only reads the cache with explicit breakpoints).
   */
  promptCache?: boolean;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIResponse {
  choices?: Array<{
    finish_reason: string | null;
    message: { content: string | null; tool_calls?: OAIToolCall[] };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
      cache_creation_tokens?: number;
    };
  };
}

const CACHE = { type: 'ephemeral' } as const;

/** Text content as a single part carrying a cache breakpoint. */
const cachedText = (text: string) => [{ type: 'text', text, cache_control: CACHE }];

/** Works with OpenAI and any OpenAI-compatible gateway (LiteLLM proxies, etc). */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly url: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const cache = this.opts.promptCache ?? false;
    const messages = req.messages.map(toOpenAIMessage);
    if (cache) {
      // Breakpoint on the newest user/tool message: the next turn re-reads everything up to here from the cache.
      const last = messages.at(-1);
      if (last && (last.role === 'user' || last.role === 'tool') && typeof last.content === 'string')
        last.content = cachedText(last.content);
    }
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: cache ? cachedText(req.system) : req.system }, ...messages],
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
    };

    let res: OAIResponse;
    try {
      res = await fetchJson<OAIResponse>(
        this.url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify(body),
        },
        { timeoutMs: this.opts.timeoutMs ?? 180_000, attempts: this.opts.attempts ?? 3, signal: req.signal },
      );
    } catch (err) {
      if (err instanceof HttpError) throw new LLMError(`LLM request failed: ${err.message}`, { cause: err });
      throw err;
    }

    const choice = res.choices?.[0];
    if (!choice) throw new LLMError('LLM returned no choices');

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: safeParseArgs(tc.function.arguments),
    }));

    const input = res.usage?.prompt_tokens ?? 0;
    const output = res.usage?.completion_tokens ?? 0;
    const details = res.usage?.prompt_tokens_details;
    return {
      text: choice.message.content ?? null,
      toolCalls,
      finishReason: choice.finish_reason,
      usage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: res.usage?.total_tokens ?? input + output,
        cachedInputTokens: details?.cached_tokens ?? 0,
        cacheWriteTokens: details?.cache_write_tokens ?? details?.cache_creation_tokens ?? 0,
      },
    };
  }
}

function safeParseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Surface to the tool's validator, which reports the error back to the model.
    return { __invalidJson: raw.slice(0, 500) };
  }
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: m.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
}
