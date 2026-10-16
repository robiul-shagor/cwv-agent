import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never depend on real secrets or network.
    env: { CWV_SKIP_DOTENV: '1' },
  },
});
