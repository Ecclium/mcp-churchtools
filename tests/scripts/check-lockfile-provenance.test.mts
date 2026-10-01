import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addedPackages,
  checkPackages,
  evidenceOf,
  lockedPackages,
  splitEntry,
} from '../../scripts/ci/check-lockfile-provenance.mts';
import { createRepository, type Repository } from '../support/git.mts';

// The check asks the npm registry about every version a change adds to
// pnpm-lock.yaml (ADR 0021). These tests never reach the network: the
// lockfiles are synthetic and the registry is a function that answers from
// a table.

const script = fileURLToPath(
  new URL('../../scripts/ci/check-lockfile-provenance.mts', import.meta.url),
);

/** A lockfile in the layout of pnpm 11, with the given package keys. */
const lockfile = (keys: readonly string[]): string =>
  [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      vitest:',
    '        specifier: 5.0.3',
    '        version: 5.0.3(typescript@6.0.3)',
    '',
    'packages:',
    '',
    ...keys.flatMap((key) => [
      `  ${key}:`,
      '    resolution: {integrity: sha512-AAAA}',
      '',
    ]),
    'snapshots:',
    '',
    '  vitest@5.0.3(typescript@6.0.3):',
    '    dependencies:',
    '      tinyspy: 4.0.4',
    '',
  ].join('\n');

// A registry document carries more than the evidence, among it the name and
// address of the person who published it. These values must never appear in
// the output of the check.
const publisher = { name: 'Erika Musterfrau', email: 'erika@example.org' };

const withEvidence = {
  name: 'vitest',
  dist: { attestations: { provenance: { predicateType: 'slsa' } } },
  _npmUser: { ...publisher, trustedPublisher: { id: 'github' } },
};

describe('lockedPackages', () => {
  it('reads only the keys of the packages section, without quotes', () => {
    const keys = lockedPackages(
      lockfile(['vitest@5.0.3', "'@vitest/spy@5.0.3'", 'tinyspy@4.0.4']),
    );
    expect([...keys].sort()).toEqual([
      '@vitest/spy@5.0.3',
      'tinyspy@4.0.4',
      'vitest@5.0.3',
    ]);
  });
});

describe('addedPackages', () => {
  it('lists the keys that are new, not the ones that left', () => {
    const base = lockfile(['vitest@5.0.2', 'tinyspy@4.0.4']);
    const head = lockfile(['vitest@5.0.3', 'tinyspy@4.0.4', 'ignore@7.0.11']);
    expect(addedPackages(base, head)).toEqual([
      'ignore@7.0.11',
      'vitest@5.0.3',
    ]);
  });
});

describe('splitEntry', () => {
  it('splits plain and scoped names at the last @', () => {
    expect(splitEntry('vitest@5.0.3')).toEqual({
      name: 'vitest',
      version: '5.0.3',
    });
    expect(splitEntry('@vitest/spy@5.0.3-beta.1')).toEqual({
      name: '@vitest/spy',
      version: '5.0.3-beta.1',
    });
  });

  it('refuses keys that name no registry version', () => {
    for (const entry of [
      'foo@https://example.org/foo.tgz',
      'foo@file:../foo',
      'foo@git+https://example.org/foo.git#abc',
      '@scope/foo',
      'foo',
    ]) {
      expect(splitEntry(entry), entry).toBeUndefined();
    }
  });
});

describe('evidenceOf', () => {
  it('needs an attestation and a trusted publisher, each as an object', () => {
    expect(evidenceOf(withEvidence)).toEqual({
      provenance: true,
      trustedPublisher: true,
    });
    expect(evidenceOf({ dist: {}, _npmUser: publisher })).toEqual({
      provenance: false,
      trustedPublisher: false,
    });
    expect(
      evidenceOf({
        dist: { attestations: { provenance: true } },
        _npmUser: { trustedPublisher: 'github' },
      }),
    ).toEqual({ provenance: false, trustedPublisher: false });
    expect(evidenceOf(null)).toEqual({
      provenance: false,
      trustedPublisher: false,
    });
  });
});

describe('checkPackages', () => {
  const registry =
    (documents: Readonly<Record<string, unknown>>) =>
    (url: string): Promise<unknown> => {
      const document = documents[url];
      return document === undefined
        ? Promise.reject(new Error('HTTP 404'))
        : Promise.resolve(document);
    };

  it('passes when every added version has both kinds of evidence', async () => {
    const report = await checkPackages(
      ['@vitest/spy@5.0.3'],
      registry({
        'https://registry.npmjs.org/@vitest%2fspy/5.0.3': withEvidence,
      }),
    );
    expect(report.failed).toBe(0);
    expect(report.lines).toEqual([
      '@vitest/spy@5.0.3: Herkunftsnachweis ja, vertrauenswürdiger Herausgeber ja',
    ]);
  });

  it('fails for missing evidence, a foreign source and an unreachable registry', async () => {
    const report = await checkPackages(
      [
        'why-is-node-running@3.2.1',
        'ignore@7.0.11',
        'foo@https://example.org/foo.tgz',
        'gone@1.0.0',
      ],
      registry({
        'https://registry.npmjs.org/why-is-node-running/3.2.1': {
          dist: withEvidence.dist,
          _npmUser: publisher,
        },
        'https://registry.npmjs.org/ignore/7.0.11': {
          dist: {},
          _npmUser: publisher,
        },
      }),
    );
    expect(report.failed).toBe(4);
    expect(report.lines).toEqual([
      'why-is-node-running@3.2.1: Herkunftsnachweis ja, vertrauenswürdiger Herausgeber nein',
      'ignore@7.0.11: Herkunftsnachweis nein, vertrauenswürdiger Herausgeber nein',
      'foo@https://example.org/foo.tgz: nicht aus der Registry',
      'gone@1.0.0: Registry nicht erreichbar',
    ]);
    const output = report.lines.join('\n');
    expect(output).not.toContain(publisher.name);
    expect(output).not.toContain(publisher.email);
  });
});

describe('check-lockfile-provenance', () => {
  let repository: Repository | undefined;

  afterEach(() => {
    repository?.remove();
    repository = undefined;
  });

  const run = (
    target: Repository,
    ...args: string[]
  ): { status: number | null; output: string } => {
    const result = target.run('node', [script, ...args]);
    return { status: result.status, output: result.stdout + result.stderr };
  };

  // Without an added version the check asks the registry nothing, so this
  // runs without a network.
  it('passes without a request when the lockfile adds nothing', () => {
    repository = createRepository();
    writeFileSync(
      join(repository.path, 'pnpm-lock.yaml'),
      lockfile(['vitest@5.0.3']),
    );
    repository.git(['add', 'pnpm-lock.yaml']);
    repository.git(['commit', '--quiet', '--message', 'chore: lock']);
    writeFileSync(
      join(repository.path, 'pnpm-lock.yaml'),
      lockfile(['vitest@5.0.3']).replace('sha512-AAAA', 'sha512-BBBB'),
    );

    const result = run(repository, 'HEAD');
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('0 neue Paketversionen');
  });

  it('stops with code 2 on a wrong call or an unknown commit', () => {
    repository = createRepository();
    expect(run(repository).status).toBe(2);
    expect(run(repository, 'HEAD', 'extra').status).toBe(2);
    const unknown = run(repository, 'no-such-commit');
    expect(unknown.status).toBe(2);
    expect(unknown.output).toContain('lässt sich nicht lesen');
  });
});
