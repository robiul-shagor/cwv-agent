import type { Env } from '../../config/env.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

export function createProvider(env: Env): LLMProvider {
  return new OpenAICompatibleProvider({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    promptCache: env.LLM_PROMPT_CACHE === 'true',
  });
}
