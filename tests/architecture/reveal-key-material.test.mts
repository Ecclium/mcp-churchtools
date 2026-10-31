import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { workspaceRoot } from './boundaries.mts';

// The dependency rule keys-internals keeps revealKeyMaterial in the folder
// of the keys, but dependency-cruiser checks only the packages: code under
// tests/ and scripts/ is not cruised, and a fixture there may import the
// module of the key directly (ADR 0069). This test refuses the name in every
// tracked file of code outside the folder, so that no test or script turns
// the secret for pseudonyms back into its bytes.

const outbound = 'packages/core/src/keys/';

/** Files that may name the function, each with its reason. */
const exceptions: ReadonlyMap<string, string> = new Map([
  [
    'tests/architecture/dependency-rules.test.mts',
    'example sources for the rule, written to a temporary folder',
  ],
  ['tests/architecture/reveal-key-material.test.mts', 'this test'],
]);

describe('revealKeyMaterial', () => {
  it('is named only in the folder of the keys', () => {
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
    expect(files).toContain('packages/core/src/keys/key-material.ts');
    const offenders = files.filter(
      (file) =>
        !file.startsWith(outbound) &&
        !exceptions.has(file) &&
        readFileSync(join(workspaceRoot, file), 'utf8').includes(
          'revealKeyMaterial',
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('is named in each excepted file, so that no exception is stale', () => {
    for (const file of exceptions.keys()) {
      expect(readFileSync(join(workspaceRoot, file), 'utf8'), file).toContain(
        'revealKeyMaterial',
      );
    }
  });
});
