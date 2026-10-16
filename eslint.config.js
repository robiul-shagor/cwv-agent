import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'runs', 'reports', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Browser UI (plain JS, no build step).
    files: ['src/web/**/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'window',
          'document',
          'location',
          'history',
          'fetch',
          'EventSource',
          'FormData',
          'Node',
          'URL',
          'URLSearchParams',
          'setInterval',
          'setTimeout',
          'navigator',
          'crypto',
          'clearInterval',
          'localStorage',
        ].map((g) => [g, 'readonly']),
      ),
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
