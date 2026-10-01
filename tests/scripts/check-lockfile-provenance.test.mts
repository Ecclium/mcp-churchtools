import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addedPackages,
  checkPackages,
  evidenceOf,
  lockedPackages,
  lockfileVersion,
  registryIntegrity,
  splitEntry,
} from '../../scripts/ci/check-lockfile-provenance.mts';
import { createRepository, type Repository } from '../support/git.mts';
import { runCommand } from '../support/workflows.mts';

// The check asks the npm registry about every version a change adds to
// pnpm-lock.yaml (ADR 0021). These tests never reach the network: the
// lockfiles are synthetic, the registry is a function that answers from a
// table, and the run of the script goes through a proxy that refuses every
// connection.

const script = fileURLToPath(
  new URL('../../scripts/ci/check-lockfile-provenance.mts', import.meta.url),
);

const sha = 'sha512-AAAA';
const integrity = `resolution: {integrity: ${sha}}`;

/** A lockfile in the layout of pnpm 11, with the given packages. */
const lockfile = (
  packages: Readonly<Record<string, string>>,
  version = "'9.0'",
): string =>
  [
    `lockfileVersion: ${version}`,
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
    ...Object.entries(packages).flatMap(([key, resolution]) => [
      `  ${key}:`,
      `    ${resolution}`,
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
const attested = {
  integrity: sha,
  attestations: { provenance: { predicateType: 'slsa' } },
};
const trusted = { ...publisher, trustedPublisher: { id: 'github' } };

describe('lockfileVersion and lockedPackages', () => {
  it('read the version and the keys of the packages section with their resolution', () => {
    const text = lockfile({
      'vitest@5.0.3': integrity,
      "'@vitest/spy@5.0.3'": integrity,
    });
    expect(lockfileVersion(text)).toBe('9.0');
    expect([...lockedPackages(text)]).toEqual([
      ['vitest@5.0.3', integrity],
      ['@vitest/spy@5.0.3', integrity],
    ]);
  });

  it('read a lockfile with CRLF line endings the same way', () => {
    const text = lockfile({ 'vitest@5.0.3': integrity });
    expect(lockedPackages(text.replace(/\n/g, '\r\n'))).toEqual(
      lockedPackages(text),
    );
  });
});

describe('addedPackages', () => {
  it('lists new keys and keys whose resolution changed, not removed ones', () => {
    const base = lockfile({
      'vitest@5.0.2': integrity,
      'tinyspy@4.0.4': integrity,
      'ignore@7.0.9': integrity,
    });
    const tarball = 'resolution: {tarball: https://example.org/t.tgz}';
    const head = lockfile({
      'vitest@5.0.3': integrity,
      'tinyspy@4.0.4': tarball,
      'ignore@7.0.9': integrity,
    });
    expect(addedPackages(base, head)).toEqual([
      { key: 'tinyspy@4.0.4', resolution: tarball },
      { key: 'vitest@5.0.3', resolution: integrity },
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
    for (const name of [
      'JSONStream',
      'string_decoder',
      'lodash._basecopy',
      '@types/babel__core',
      '@scope/_private',
      '@-scope/run',
    ]) {
      expect(splitEntry(`${name}@1.0.0`), name).toEqual({
        name,
        version: '1.0.0',
      });
    }
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

  // The name goes into the path of the registry URL. None of these is a
  // package name, and some, such as `..`, `?` and `#`, would make the URL
  // ask about a different package. The long s and the Kelvin sign would
  // match `s` and `k` if the pattern ever ignored case for Unicode.
  it('refuses names that cannot go into the registry URL unchanged', () => {
    for (const entry of [
      '..@1.0.0',
      '.@1.0.0',
      '@scope/.x@1.0.0',
      '@./x@1.0.0',
      'x/y/../../vitest@5.0.3',
      '../vitest@5.0.3',
      '@scope/../vitest@5.0.3',
      '@scope/foo/bar@1.0.0',
      'foo/bar@1.0.0',
      '.hidden@1.0.0',
      'foo?x=1@1.0.0',
      'foo#x@1.0.0',
      'foo%2f..@1.0.0',
      'foo bar@1.0.0',
      '@/foo@1.0.0',
      '@scope/@1.0.0',
      '-foo@1.0.0',
      '_foo@1.0.0',
      'vit\u017Fest@5.0.3',
      'vite\u212A@1.0.0',
    ]) {
      expect(splitEntry(entry), entry).toBeUndefined();
    }
  });
});

describe('evidenceOf', () => {
  it('needs an attestation and a trusted publisher, each as an object', () => {
    expect(evidenceOf({ dist: attested, _npmUser: trusted })).toEqual({
      provenance: true,
      trustedPublisher: true,
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

describe('registryIntegrity', () => {
  it('reads dist.integrity only as a string', () => {
    expect(registryIntegrity({ dist: { integrity: sha } })).toBe(sha);
    expect(registryIntegrity({ dist: { integrity: [sha] } })).toBeUndefined();
    expect(registryIntegrity({ dist: {} })).toBeUndefined();
    expect(registryIntegrity('x')).toBeUndefined();
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
  const added = (key: string, resolution = integrity) => ({ key, resolution });

  it('passes when every added version has both kinds of evidence', async () => {
    const report = await checkPackages(
      [added('@vitest/spy@5.0.3')],
      registry({
        'https://registry.npmjs.org/@vitest%2fspy/5.0.3': {
          dist: attested,
          _npmUser: trusted,
        },
      }),
    );
    expect(report.failed).toBe(0);
    expect(report.lines).toEqual([
      '@vitest/spy@5.0.3: Herkunftsnachweis ja, vertrauenswürdiger Herausgeber ja',
    ]);
  });

  it('fails without either kind of evidence, for a foreign source and without the registry', async () => {
    const report = await checkPackages(
      [
        added('why-is-node-running@3.2.1'),
        added('prettier@3.9.9'),
        added('ignore@7.0.11'),
        added('foo@https://example.org/foo.tgz'),
        added('bar@1.0.0', 'resolution: {tarball: https://example.org/b.tgz}'),
        added('gone@1.0.0'),
      ],
      registry({
        'https://registry.npmjs.org/why-is-node-running/3.2.1': {
          dist: attested,
          _npmUser: publisher,
        },
        'https://registry.npmjs.org/prettier/3.9.9': {
          dist: { integrity: sha },
          _npmUser: trusted,
        },
        'https://registry.npmjs.org/ignore/7.0.11': {
          dist: { integrity: sha },
          _npmUser: publisher,
        },
        'https://registry.npmjs.org/bar/1.0.0': {
          dist: attested,
          _npmUser: trusted,
        },
      }),
    );
    expect(report.failed).toBe(6);
    expect(report.lines).toEqual([
      'why-is-node-running@3.2.1: Herkunftsnachweis ja, vertrauenswürdiger Herausgeber nein',
      'prettier@3.9.9: Herkunftsnachweis nein, vertrauenswürdiger Herausgeber ja',
      'ignore@7.0.11: Herkunftsnachweis nein, vertrauenswürdiger Herausgeber nein',
      'foo@https://example.org/foo.tgz: nicht aus der Registry',
      'bar@1.0.0: nicht aus der Registry',
      'gone@1.0.0: Registry nicht erreichbar',
    ]);
    const output = report.lines.join('\n');
    expect(output).not.toContain(publisher.name);
    expect(output).not.toContain(publisher.email);
  });

  // pnpm installs what matches the integrity in the lockfile. Evidence for
  // the version in the key says nothing about another tarball, such as an
  // older version named in the entry or one from another registry.
  it('fails when the integrity is not the one the registry lists', async () => {
    const report = await checkPackages(
      [
        added('vitest@5.0.2', 'resolution: {integrity: sha512-BBBB}'),
        added('ignore@7.0.11'),
      ],
      registry({
        'https://registry.npmjs.org/vitest/5.0.2': {
          dist: attested,
          _npmUser: trusted,
        },
        'https://registry.npmjs.org/ignore/7.0.11': {
          dist: { attestations: attested.attestations },
          _npmUser: trusted,
        },
      }),
    );
    expect(report.failed).toBe(2);
    expect(report.lines).toEqual([
      'vitest@5.0.2: Prüfsumme weicht von der Registry ab',
      'ignore@7.0.11: Prüfsumme weicht von der Registry ab',
    ]);
  });

  it('never asks the registry about a name that would leave its path', async () => {
    const asked: string[] = [];
    const report = await checkPackages(
      [added('x/y/../../vitest@5.0.3'), added('@scope/foo/bar@1.0.0')],
      (url) => {
        asked.push(url);
        return Promise.resolve({ dist: attested, _npmUser: trusted });
      },
    );
    expect(asked).toEqual([]);
    expect(report.failed).toBe(2);
    expect(report.lines).toEqual([
      'x/y/../../vitest@5.0.3: nicht aus der Registry',
      '@scope/foo/bar@1.0.0: nicht aus der Registry',
    ]);
  });
});

describe('check-lockfile-provenance', () => {
  let repository: Repository | undefined;

  afterEach(() => {
    repository?.remove();
    repository = undefined;
  });

  // Every connection goes to a port that refuses it, so no request can
  // leave the machine, and a version to check ends as unreachable.
  const offline = {
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '',
    no_proxy: '',
  };

  /** Commits `base` as pnpm-lock.yaml and leaves `head` in the tree. */
  const prepare = (base: string, head: string): Repository => {
    const created = createRepository();
    repository = created;
    writeFileSync(join(created.path, 'pnpm-lock.yaml'), base);
    created.git(['add', 'pnpm-lock.yaml']);
    created.git(['commit', '--quiet', '--message', 'chore: lock']);
    writeFileSync(join(created.path, 'pnpm-lock.yaml'), head);
    return created;
  };

  const run = (
    target: Repository,
    ...args: string[]
  ): { status: number | null; output: string } => {
    const result = target.run('node', [script, ...args], offline);
    return { status: result.status, output: result.stdout + result.stderr };
  };

  it('fails for a version it could not check and passes when versions only leave', () => {
    const one = lockfile({ 'vitest@5.0.3': integrity });
    const two = lockfile({
      'vitest@5.0.3': integrity,
      'ignore@7.0.11': integrity,
    });

    const result = run(prepare(one, two), 'HEAD');
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('ignore@7.0.11: Registry nicht erreichbar');
    expect(result.output).toContain('davon 1 nicht bestanden');
    repository?.remove();

    const counterpart = run(prepare(two, one), 'HEAD');
    expect(counterpart.status, counterpart.output).toBe(0);
    expect(counterpart.output).toContain('0 neue oder geänderte');
  });

  it('stops with code 2 when it cannot read the lockfile', () => {
    const known = lockfile({ 'vitest@5.0.3': integrity });
    const unknown = run(
      prepare(known, lockfile({ 'vitest@5.0.3': integrity }, "'10.0'")),
      'HEAD',
    );
    expect(unknown.status, unknown.output).toBe(2);
    expect(unknown.output).toContain('diese Prüfung liest nur 9.0');
    repository?.remove();

    const empty = run(prepare(known, lockfile({})), 'HEAD');
    expect(empty.status, empty.output).toBe(2);
    expect(empty.output).toContain('keine Pakete');
  });

  it('stops with code 2 on a wrong call or an unknown commit', () => {
    repository = createRepository();
    expect(run(repository).status).toBe(2);
    expect(run(repository, 'HEAD', 'extra').status).toBe(2);
    const unknown = run(repository, 'no-such-commit');
    expect(unknown.status).toBe(2);
    expect(unknown.output).toContain('lässt sich nicht lesen');
  });

  // The job must compare with the base of the test merge, run for every
  // pull request and really fail; a skipped or tolerated failure would let
  // Renovate merge.
  it('runs in CI against the base of the pull request', () => {
    expect(
      runCommand('ci.yml', 'Check the provenance of new lockfile entries'),
    ).toBe('node scripts/ci/check-lockfile-provenance.mts HEAD^1');
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const job = workflow.slice(workflow.indexOf('\n  lockfile-provenance:'));
    expect(job).toContain("if: github.event_name == 'pull_request'");
    expect(job).not.toContain('continue-on-error');
  });
});
