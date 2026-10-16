import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv, secretValues } from '../src/config/env.js';

describe('parseEnv', () => {
  it('applies defaults and treats empty strings as unset', () => {
    const env = parseEnv({ LLM_API_KEY: 'sk-abcdefgh', GOOGLE_API_KEY: '' });
    expect(env.LLM_MODEL).toBe('gpt-6-luna');
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.AGENT_MAX_TOOL_CALLS).toBe(20);
  });

  it('requires the LLM key without leaking other values', () => {
    expect(() => parseEnv({ LLM_API_KEY: '' })).toThrow(ConfigError);
    try {
      parseEnv({ GOOGLE_API_KEY: 'AIza-secret-value', AGENT_MAX_TOOL_CALLS: 'abc' });
    } catch (e) {
      expect((e as Error).message).toContain('LLM_API_KEY');
      expect((e as Error).message).toContain('AGENT_MAX_TOOL_CALLS');
      expect((e as Error).message).not.toContain('AIza-secret-value');
    }
  });

  it('collects secrets for redaction', () => {
    const env = parseEnv({ LLM_API_KEY: 'sk-abcdefgh', GOOGLE_API_KEY: 'AIzaXYZ12345' });
    expect(secretValues(env)).toEqual(['sk-abcdefgh', 'AIzaXYZ12345']);
  });
});
