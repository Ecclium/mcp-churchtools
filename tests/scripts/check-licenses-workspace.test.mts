import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findViolations,
  readReport,
  runtimeLicences,
} from '../../scripts/check-licenses.mts';
import { runPnpm } from '../../scripts/lib/pnpm.mts';

// The licence check must see the dependencies of a package under packages/,
// not only those of the root package (ADR 0021). This builds a throwaway
// workspace in which the only dependency, under a licence that is not
// allowed at run time, belongs to such a package. It is written at run time
// so that no scanner or update tool mistakes it for part of this workspace.
// The dependency resolves to a folder, so pnpm reads its manifest from disk
// and needs neither the network nor node_modules.

const timeout = 30_000;

const files: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "fixture-root", "private": true }\n',
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'packages/a/package.json': JSON.stringify({
    name: 'a',
    version: '0.0.0',
    private: true,
    dependencies: { copyleft: 'file:../../vendor/copyleft' },
  }),
  'vendor/copyleft/package.json': JSON.stringify({
    name: 'copyleft',
    version: '1.0.0',
    license: 'GPL-3.0-only',
  }),
  // Written by hand in the form pnpm 11 writes. Without the version line
  // pnpm reports the version of a folder dependency as null.
  'pnpm-lock.yaml': [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .: {}',
    '',
    '  packages/a:',
    '    dependencies:',
    '      copyleft:',
    '        specifier: file:../../vendor/copyleft',
    '        version: file:vendor/copyleft',
    '',
    'packages:',
    '',
    '  copyleft@file:vendor/copyleft:',
    '    resolution: {directory: vendor/copyleft, type: directory}',
    '    version: 1.0.0',
    '',
    'snapshots:',
    '',
    '  copyleft@file:vendor/copyleft: {}',
    '',
  ].join('\n'),
};

let root = '';
let env: NodeJS.ProcessEnv = {};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-licences-')));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  // pnpm creates its store even for a listing; keep it inside the fixture.
  env = { ...process.env, pnpm_config_store_dir: join(root, 'store') };
});

afterAll(() => {
  if (root !== '') {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('readReport in a workspace', () => {
  it(
    'reports a dependency of a package under packages/',
    () => {
      const report = readReport('--prod', { dir: root, env });
      expect(findViolations(report, runtimeLicences)).toEqual([
        'copyleft@1.0.0 (GPL-3.0-only)',
      ]);
      expect(readReport('--dev', { dir: root, env })).toEqual({});
    },
    timeout,
  );

  it(
    'needs -r: pnpm alone reads only the root package',
    () => {
      // The call the check made before -r. It finds nothing in the same
      // workspace, so the test above fails if -r goes missing.
      const output = runPnpm(
        ['--dir', root, 'licenses', 'list', '--json', '--prod'],
        env,
      );
      expect(output.trimStart().startsWith('{')).toBe(false);
    },
    timeout,
  );
});
