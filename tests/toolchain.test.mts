import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The Node.js and pnpm versions are named in several files, each read by a
// different tool: mise, nvm, pnpm, Corepack and npm. These tests keep them
// in step, so that an update of one file cannot leave another one behind
// (ADR 0019, ADR 0020).

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

interface Manifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const manifest = (path: string): Manifest => JSON.parse(read(path)) as Manifest;

const root = manifest('package.json');

/** Reads a quoted value from a TOML line such as `node = "24.21.0"`. */
const tomlValue = (toml: string, key: string): string | undefined =>
  new RegExp(`^"?${key}"?\\s*=\\s*"([^"]+)"`, 'm').exec(toml)?.[1];

const major = (version: string): number => Number(version.split('.')[0]);

const developmentNode = tomlValue(read('mise.toml'), 'node') ?? '';
const compatNode = tomlValue(read('mise.compat.toml'), 'node') ?? '';

describe('Node.js', () => {
  it('uses the same development version for mise and nvm', () => {
    expect(developmentNode).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read('.nvmrc').trim()).toBe(developmentNode);
  });

  it('keeps the development version within the supported range', () => {
    const minimum = /^\^(\d+\.\d+\.\d+) \|\| >=(\d+)\.0\.0$/.exec(
      root.engines?.['node'] ?? '',
    );
    expect(minimum).not.toBeNull();
    const [, lowest = '', next = ''] = minimum ?? [];
    expect(major(lowest)).toBe(major(developmentNode));
    expect(
      lowest.localeCompare(developmentNode, 'en', { numeric: true }),
    ).toBeLessThanOrEqual(0);
    expect(major(compatNode)).toBe(Number(next));
  });

  it('checks the next line in the compatibility environment', () => {
    expect(major(compatNode)).toBeGreaterThan(major(developmentNode));
  });

  it('types only the APIs of the development line', () => {
    const types = root.devDependencies?.['@types/node'] ?? '';
    expect(major(types)).toBe(major(developmentNode));
  });
});

describe('pnpm', () => {
  it('uses the same version for mise and Corepack, pinned by hash', () => {
    const version = tomlValue(read('mise.toml'), 'aqua:pnpm/pnpm');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(root.packageManager).toMatch(
      new RegExp(`^pnpm@${String(version)}\\+sha512\\.[0-9a-f]{128}$`),
    );
  });
});

describe('dependencies', () => {
  const manifests = [
    root,
    ...readdirSync(new URL('../packages/', import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => manifest(`packages/${entry.name}/package.json`)),
  ];

  it('pins every external dependency to an exact version', () => {
    for (const {
      name = 'workspace root',
      dependencies,
      devDependencies,
    } of manifests) {
      for (const [dependency, spec] of Object.entries({
        ...dependencies,
        ...devDependencies,
      })) {
        if (!spec.startsWith('workspace:')) {
          expect(spec, `${name}: ${dependency}`).toMatch(/^\d+\.\d+\.\d+$/);
        }
      }
    }
  });
});
