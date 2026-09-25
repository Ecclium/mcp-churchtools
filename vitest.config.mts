import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript source under this condition
// (ADR 0022). Tests resolve it first, so they run the source and never an
// earlier build.
const sourceCondition = '@ecclium/source';

export default defineConfig({
  ssr: {
    resolve: {
      conditions: [sourceCondition, ...defaultServerConditions],
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.mts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts'],
    },
  },
});
