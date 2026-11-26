import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The tests in tests/architecture/ run once, in the job architecture; check,
// compat and minimum run every other test (ADR 0019). These tests keep both
// halves of that split on the same folder, so that no test file drops out of
// CI when one half changes and the other does not, and keep `pnpm check`
// running every test on a developer machine. That ci.yml has the job and runs
// it without network checks tests/workflows/network-namespace.test.mts.

const workspace = fileURLToPath(new URL('../../', import.meta.url));

/** The folder of the architecture tests, from the root of the workspace. */
const folder = 'tests/architecture';

/**
 * The scripts that the split needs, each with the one command it must run.
 * `ci:check` runs the checks of the check jobs without the architecture
 * tests, `ci:architecture` runs only those.
 */
const expected: Readonly<Record<string, string>> = {
  test: 'vitest run',
  'test:architecture': `vitest run ${folder}/`,
  'test:without-architecture': `vitest run --exclude '${folder}/**'`,
  'ci:architecture': 'pnpm run test:architecture',
  'ci:check':
    'pnpm run build && node scripts/ci/check-docs-index-build.mts && pnpm run check:static && pnpm run test:without-architecture',
  check: 'pnpm run check:static && pnpm run test',
};

/**
 * Every way the scripts could lose a test file from CI or from `pnpm check`:
 * a script of the split that runs something else, or `ci:local` without the
 * architecture tests.
 *
 * @param scripts - The scripts of the root package.json.
 * @returns One line per finding, empty when the split holds.
 */
function splitViolations(
  scripts: Readonly<Record<string, string | undefined>>,
): string[] {
  const found: string[] = [];
  for (const [name, command] of Object.entries(expected)) {
    if (scripts[name] !== command) found.push(`${name}: runs another command`);
  }
  if (!(scripts['ci:local'] ?? '').includes('pnpm run ci:architecture')) {
    found.push('ci:local: runs no architecture tests');
  }
  return found;
}

describe('the job architecture', () => {
  const { scripts } = JSON.parse(
    readFileSync(`${workspace}package.json`, 'utf8'),
  ) as { scripts: Record<string, string> };

  it('runs the tests in tests/architecture/ and the check jobs run all others', () => {
    expect(splitViolations(scripts)).toEqual([]);
  });

  it.each([
    [
      'another folder for the architecture tests',
      'test:architecture',
      'vitest run tests/arch/',
    ],
    [
      'a wider exclusion in the check jobs',
      'test:without-architecture',
      "vitest run --exclude 'tests/**'",
    ],
    ['an architecture run that runs nothing', 'ci:architecture', 'true'],
    [
      'check jobs without tests',
      'ci:check',
      'pnpm run build && node scripts/ci/check-docs-index-build.mts && pnpm run check:static',
    ],
    [
      'a local check without the architecture tests',
      'check',
      'pnpm run check:static && pnpm run test:without-architecture',
    ],
    [
      'a local test run without the architecture tests',
      'test',
      "vitest run --exclude 'tests/architecture/**'",
    ],
    [
      'a local run of CI without the architecture tests',
      'ci:local',
      'pnpm run ci:check',
    ],
  ])('reports %s', (_name, script, command) => {
    expect(scripts[script]).not.toBe(command);
    expect(splitViolations({ ...scripts, [script]: command })).not.toEqual([]);
  });
});
