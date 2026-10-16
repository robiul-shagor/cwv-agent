/** Provider-neutral chat types. The agent loop only talks to this interface. */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw arguments as parsed from the model; validated by the tool's zod schema. */
  args: unknown;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Input tokens served from the prompt cache (billed at a fraction of the normal rate). */
  cachedInputTokens?: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens?: number;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string | null;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class LLMError extends Error {
  override name = 'LLMError';
}
