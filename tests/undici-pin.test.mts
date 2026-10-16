import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// undici brings code into core that the lockfile does not show: the HTTP
// parsers llhttp and Milo as WASM, each in a JavaScript file (ADR 0056).
// This test pins the version and those files and reads the list in the
// section Umsetzung of ADR 0056. A new version of undici turns it red
// until a person has checked the bundled code and updated both the list
// and the digests here. It also shows that undici reads the variables of a
// proxy only in the dispatcher that follows them, which the transport
// never builds.

const core = fileURLToPath(
  new URL('../packages/core/package.json', import.meta.url),
);
const undici = dirname(createRequire(core).resolve('undici/package.json'));

const version = (
  JSON.parse(readFileSync(join(undici, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const digest = (path: string): string =>
  createHash('sha256')
    .update(readFileSync(join(undici, path)))
    .digest('hex');

const advice =
  'Check the bundled code of undici for advisories, then update the list in the section Umsetzung of ADR 0056 and the digests in this test.';

// The full digests of the files that ADR 0056 lists with a prefix.
const pinned: Readonly<Record<string, string>> = Object.freeze({
  'lib/llhttp/llhttp-wasm.js':
    '5d8313d6fe8145d832e6af9959b2810523c9a6993d5b93cee09bd7e5f1f2c085',
  'lib/llhttp/llhttp_simd-wasm.js':
    'a3f30f3307ab3c191720cb636d570febb3610c420bc7077f2e225dacfcad3295',
  'lib/milo/no-simd.js':
    'ece090d1e2e962e0de7428bf542b900b373876e5cf1d7eda43e5cd08a92bf9b7',
  'lib/milo/simd.js':
    '3bc5b7120aa8732d6a1fb2692714d549d4025aa27482ba3b47e7b80ff74f23cc',
});

/** The version and the files with their digest prefix in ADR 0056. */
interface Listed {
  readonly version: string;
  readonly files: ReadonlyMap<string, string>;
}

// Reads the list from the section Umsetzung: the version from its heading,
// then each row of the table with a file in backticks in the fourth
// column and a prefix of at least 16 hex digits with ... in the fifth.
const listedIn = (text: string): Listed => {
  const section = text.split(/^## Umsetzung$/m)[1] ?? '';
  const version =
    /\*\*Gebündelter Code von undici (\d+\.\d+\.\d+),\*\*/.exec(section)?.[1] ??
    '';
  const files = new Map<string, string>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const file = /^`([^`]+)`$/.exec(cells[3] ?? '')?.[1];
    const prefix = /^`([0-9a-f]{16,})\.\.\.`$/.exec(cells[4] ?? '')?.[1];
    if (file !== undefined && prefix !== undefined) files.set(file, prefix);
  }
  return { version, files };
};

// What does not fit between the list and the pinned version and digests.
const differences = (listed: Listed, installed: string): string[] => {
  const found: string[] = [];
  if (listed.version !== installed) {
    found.push(`version ${listed.version || 'missing'}`);
  }
  if (listed.files.size === 0) found.push('no file listed');
  for (const [file, prefix] of listed.files) {
    const full = pinned[file];
    if (full === undefined) found.push(`${file} is not pinned`);
    else if (!full.startsWith(prefix)) found.push(`${file} has another digest`);
  }
  for (const file of Object.keys(pinned)) {
    if (!listed.files.has(file)) found.push(`${file} is not listed`);
  }
  return found;
};

const adr = readFileSync(
  fileURLToPath(
    new URL('../docs/adr/0056-ausgehender-weg.md', import.meta.url),
  ),
  'utf8',
);

const sources = (folder: string): string[] =>
  readdirSync(join(undici, folder), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(folder, name));

describe('undici in core', () => {
  it('is the version that ADR 0056 lists', () => {
    expect(version, advice).toBe('8.12.2');
    expect(listedIn(adr).version, advice).toBe(version);
  });

  it('bundles exactly the parsers that ADR 0056 lists', () => {
    expect(
      Object.fromEntries(
        Object.keys(pinned).map((file) => [file, digest(file)]),
      ),
      advice,
    ).toEqual(pinned);
    expect(differences(listedIn(adr), version), advice).toEqual([]);
  });

  it('notices a list that no longer fits', () => {
    const listed = (text: string) => differences(listedIn(text), version);
    expect(
      listed(adr.replace('`5d8313d6fe8145d8...`', '`0000000000000000...`')),
    ).toEqual(['lib/llhttp/llhttp-wasm.js has another digest']);
    expect(
      listed(adr.replace('`lib/milo/simd.js`', '`lib/milo/other.js`')),
    ).toEqual([
      'lib/milo/other.js is not pinned',
      'lib/milo/simd.js is not listed',
    ]);
    expect(listed(adr.replace('undici 8.12.2,**', 'undici 8.12.3,**'))).toEqual(
      ['version 8.12.3'],
    );
    expect(listed('## Umsetzung\n')).toEqual([
      'version missing',
      'no file listed',
      ...Object.keys(pinned).map((file) => `${file} is not listed`),
    ]);
  });

  it('reads the variables of a proxy only in the dispatcher that follows them', () => {
    const names = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'NODE_USE_ENV_PROXY',
    ];
    const readers = sources('lib').filter((path) => {
      const text = readFileSync(join(undici, path), 'utf8');
      return names.some(
        (name) => text.includes(name) || text.includes(name.toLowerCase()),
      );
    });
    expect(readers.map((path) => relative('.', path))).toEqual([
      'lib/dispatcher/env-http-proxy-agent.js',
    ]);
  });
});
