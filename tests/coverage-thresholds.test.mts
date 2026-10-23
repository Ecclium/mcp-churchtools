import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import config from '../vitest.config.mts';

// The job coverage-security-core fails when the security core loses
// coverage (ADR 0024). These tests keep the thresholds it relies on from
// being lowered or narrowed without a review of this file.

const workspace = fileURLToPath(new URL('../', import.meta.url));
const full = { statements: 100, branches: 100, functions: 100, lines: 100 };

describe('the thresholds of coverage', () => {
  const coverage = config.test?.coverage;

  it('ask all of redaction, the outbound path, audit and pipeline and 80 percent of core', () => {
    expect(coverage).toMatchObject({ provider: 'v8' });
    expect(
      coverage !== undefined && 'thresholds' in coverage
        ? coverage.thresholds
        : undefined,
    ).toEqual({
      'packages/core/src/**': {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
      'packages/core/src/redaction/**': full,
      'packages/core/src/http/**': full,
      'packages/core/src/audit/**': full,
      'packages/core/src/pipeline/**': full,
    });
  });

  it('measure every source file of the packages but tests and the double', () => {
    expect(coverage).toMatchObject({
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/core/src/http/compose-mock.ts',
      ],
    });
  });

  it('apply in the scripts the job runs', () => {
    const { scripts } = JSON.parse(
      readFileSync(`${workspace}package.json`, 'utf8'),
    ) as { scripts: Record<string, string> };
    // The architecture tests run no code of the packages and, under the
    // instrumentation of coverage, run past their own time limits; the
    // check jobs run them.
    expect(scripts['coverage:security']).toBe(
      "vitest run --coverage --exclude 'tests/architecture/**'",
    );
    expect(scripts['ci:coverage']).toBe(
      'pnpm run build && pnpm run coverage:security',
    );
  });
});
