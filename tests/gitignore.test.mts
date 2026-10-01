import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Exports that may hold personal data of a congregation never belong in
// this repository (ADR 0014). .gitignore keeps them out of `git add -A`,
// and the hooks and CI refuse binary files outside brand/ as well. This
// test asks Git itself which paths .gitignore covers.

const workspace = fileURLToPath(new URL('../', import.meta.url));

const ignored = (path: string): boolean =>
  spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', path], {
    cwd: workspace,
  }).status === 0;

describe('.gitignore', () => {
  it('ignores the usual export formats anywhere', () => {
    for (const path of [
      'members.csv',
      'exports/members.xlsx',
      'docs/dienstplan.pdf',
      'packages/core/kontakte.vcf',
      'session.har',
      'backup/churchtools.sqlite',
      'dump/all.zip',
      'tests/members.csv',
    ]) {
      expect(ignored(path), path).toBe(true);
    }
  });

  it('keeps synthetic fixtures, the brand package and ordinary files', () => {
    for (const path of [
      'tests/fixtures/persons.csv',
      'tests/fixtures/spike/groups.csv',
      'brand/guide.pdf',
      'brand/png/logo.png',
      'docs/STATUS.md',
      'packages/core/src/index.ts',
    ]) {
      expect(ignored(path), path).toBe(false);
    }
  });
});
