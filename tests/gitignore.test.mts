import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { gitEnvironment } from './support/git.mts';

// Exports that may hold personal data of a congregation never belong in
// this repository (ADR 0014). .gitignore keeps them out of `git add -A`,
// and the hooks and CI refuse binary files and export formats outside
// brand/ as well. This test asks Git itself which paths .gitignore covers,
// without the global configuration and personal exclude files of the
// machine it runs on.

const workspace = fileURLToPath(new URL('../', import.meta.url));

const ignored = (path: string): boolean =>
  spawnSync(
    'git',
    [
      '-c',
      'core.excludesFile=/dev/null',
      'check-ignore',
      '--quiet',
      '--no-index',
      '--',
      path,
    ],
    { cwd: workspace, env: gitEnvironment() },
  ).status === 0;

// Every format the export block of .gitignore names.
const exportFormats = [
  'csv',
  'xlsx',
  'xlsm',
  'xls',
  'ods',
  'odt',
  'docx',
  'doc',
  'pdf',
  'vcf',
  'har',
  'eml',
  'msg',
  'mbox',
  'pcap',
  'pcapng',
  'sqlite',
  'sqlite3',
  'db',
  'dump',
  'bak',
  'zip',
  '7z',
  'rar',
  'tar',
  'tgz',
  'gz',
];

describe('.gitignore', () => {
  it('ignores every export format anywhere', () => {
    for (const format of exportFormats) {
      expect(ignored(`exports/members.${format}`), format).toBe(true);
    }
    expect(ignored('tests/members.csv')).toBe(true);
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

  // The exception for brand/ covers the export formats only. Local and
  // generated files stay ignored there as everywhere else.
  it('still ignores local and generated files in brand/', () => {
    for (const path of [
      'brand/.DS_Store',
      'brand/.env',
      'brand/src/node_modules/sharp/index.js',
      'brand/render.log',
    ]) {
      expect(ignored(path), path).toBe(true);
    }
  });
});
