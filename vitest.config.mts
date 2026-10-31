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
    // Every test process runs with the network guard: connections only to
    // 127.0.0.1 and ::1 as IP literals, no name resolution (ADR 0052).
    setupFiles: ['tests/support/no-network.setup.mts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // The test double of the outbound path is code for tests, not for the
      // product, and has its own tests.
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/core/src/http/compose-mock.ts',
      ],
      // They apply only with coverage on, as in the job
      // coverage-security-core: every line and branch of redaction and of
      // the outbound path, at least 80 percent of core (ADR 0024), and
      // every line and branch of the audit and the pipeline, which hold
      // back the result of a tool without its audit line (ADR 0028), and
      // of the operation catalog, which decides what the escape hatch may
      // read (ADR 0067), and of the keys, which hold the secret behind the
      // pseudonyms (ADR 0069).
      thresholds: {
        'packages/core/src/**': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'packages/core/src/redaction/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/core/src/http/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/core/src/audit/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/core/src/pipeline/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/core/src/churchtools/catalog/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/core/src/keys/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
