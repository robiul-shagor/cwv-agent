import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const EnvSchema = z.object({
  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.url().default('https://llm-proxy.cenario.ai/v1')),
  LLM_API_KEY: z.preprocess(emptyToUndefined, z.string({ error: 'required' })),
  LLM_MODEL: z.preprocess(emptyToUndefined, z.string().default('gpt-6-luna')),
  /** Send cache_control breakpoints so the proxy serves the repeated prompt prefix from cache. */
  LLM_PROMPT_CACHE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true')),
  GOOGLE_API_KEY: optionalString,
  /** Optional: read access to private GitHub repos linked with --source. */
  GITHUB_TOKEN: optionalString,
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(100).default(20),
  AGENT_MAX_TOTAL_TOKENS: z.coerce.number().int().min(1000).default(400_000),
  TOOL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90_000),
  /** Chrome executable for the browser session tool (default: installed Google Chrome). */
  CHROME_PATH: optionalString,
  /** RUM project keys: "pk_key=example.com|shop.example.com,pk_other=other.org". Empty = collector off. */
  RUM_KEYS: optionalString,
  RUM_DATA_DIR: z.preprocess(emptyToUndefined, z.string().default('data/rum')),
  /** Public HTTPS address visitors' browsers use to reach this server (shown in the RUM install guide). */
  RUM_PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  HOST: z.preprocess(emptyToUndefined, z.string().default('127.0.0.1')),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Loads `.env` (if present) into process.env without overriding already-set variables. */
export function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (process.env.CWV_SKIP_DOTENV === '1' || !existsSync(path)) return;
  process.loadEnvFile(path);
}

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Only report variable names + messages, never values.
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return result.data;
}

/** Secret values from the env, used by the logger to redact accidental leaks. */
export function secretValues(env: Env): string[] {
  return [env.LLM_API_KEY, env.GOOGLE_API_KEY, env.GITHUB_TOKEN].filter(
    (v): v is string => typeof v === 'string' && v.length >= 8,
  );
}
