import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { workspaceRoot } from './boundaries.mts';

// The dependency rule egress-internals keeps revealSecret on the outbound
// path, but dependency-cruiser checks only the packages: code under tests/
// and scripts/ is not cruised, and a fixture there may import the module of
// the secret directly (ADR 0054). This test refuses the name in every tracked
// file of code outside the outbound path, so that no test or script turns a
// secret back into its value.

const outbound = 'packages/core/src/http/';

/** Files that may name the function, each with its reason. */
const exceptions: ReadonlyMap<string, string> = new Map([
  [
    'tests/architecture/dependency-rules.test.mts',
    'example sources for the rule, written to a temporary folder',
  ],
  ['tests/architecture/reveal-secret.test.mts', 'this test'],
]);

describe('revealSecret', () => {
  it('is named only on the outbound path', () => {
    const listed = spawnSync(
      'git',
      [
        'ls-files',
        '-z',
        '--',
        '*.ts',
        '*.mts',
        '*.cts',
        '*.js',
        '*.mjs',
        '*.cjs',
      ],
      { cwd: workspaceRoot, encoding: 'utf8' },
    );
    expect(listed.status).toBe(0);
    const files = listed.stdout.split('\0').filter((file) => file !== '');
    expect(files).toContain('packages/core/src/http/secret.ts');
    const offenders = files.filter(
      (file) =>
        !file.startsWith(outbound) &&
        !exceptions.has(file) &&
        readFileSync(join(workspaceRoot, file), 'utf8').includes(
          'revealSecret',
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('is named in each excepted file, so that no exception is stale', () => {
    for (const file of exceptions.keys()) {
      expect(readFileSync(join(workspaceRoot, file), 'utf8'), file).toContain(
        'revealSecret',
      );
    }
  });
});
