import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// undici brings code into core that the lockfile does not show: the HTTP
// parsers llhttp and Milo as WASM, each in a JavaScript file (ADR 0056).
// This test pins the version and those files. A new version of undici
// turns it red until ADR 0056 lists the bundled code again and a person has
// checked it. It also shows that undici reads the variables of a proxy only
// in the dispatcher that follows them, which the transport never builds.

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

const sources = (folder: string): string[] =>
  readdirSync(join(undici, folder), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(folder, name));

describe('undici in core', () => {
  it('is the version that ADR 0056 lists', () => {
    expect(version).toBe('8.12.2');
  });

  it('bundles exactly the parsers that ADR 0056 lists', () => {
    expect({
      'lib/llhttp/llhttp-wasm.js': digest('lib/llhttp/llhttp-wasm.js'),
      'lib/llhttp/llhttp_simd-wasm.js': digest(
        'lib/llhttp/llhttp_simd-wasm.js',
      ),
      'lib/milo/no-simd.js': digest('lib/milo/no-simd.js'),
      'lib/milo/simd.js': digest('lib/milo/simd.js'),
    }).toEqual({
      'lib/llhttp/llhttp-wasm.js':
        '5d8313d6fe8145d832e6af9959b2810523c9a6993d5b93cee09bd7e5f1f2c085',
      'lib/llhttp/llhttp_simd-wasm.js':
        'a3f30f3307ab3c191720cb636d570febb3610c420bc7077f2e225dacfcad3295',
      'lib/milo/no-simd.js':
        'ece090d1e2e962e0de7428bf542b900b373876e5cf1d7eda43e5cd08a92bf9b7',
      'lib/milo/simd.js':
        '3bc5b7120aa8732d6a1fb2692714d549d4025aa27482ba3b47e7b80ff74f23cc',
    });
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
