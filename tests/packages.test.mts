import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

// Every workspace package loads by its package name, and its exports lead to
// the TypeScript source first. Tests and type checks therefore never depend
// on an earlier build (ADR 0022).

interface Manifest {
  readonly name: string;
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const packagesDir = new URL('../packages/', import.meta.url);
const entries = await readdir(packagesDir, { withFileTypes: true });
const manifests: readonly Manifest[] = await Promise.all(
  entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const file = new URL(`${entry.name}/package.json`, packagesDir);
      return JSON.parse(await readFile(file, 'utf8')) as Manifest;
    }),
);

describe('workspace packages', () => {
  it.each(manifests)('$name exports its source first', ({ exports }) => {
    expect(exports['.']?.['@ecclium/source']).toBe('./src/index.ts');
    for (const [subpath, conditions] of Object.entries(exports)) {
      expect(Object.keys(conditions)[0], subpath).toBe('@ecclium/source');
      expect(conditions['@ecclium/source'], subpath).toMatch(
        /^\.\/src\/.+\.ts$/,
      );
    }
  });

  it.each(manifests)(
    '$name loads by its package name',
    async ({ name, exports }) => {
      for (const subpath of Object.keys(exports)) {
        const specifier = `${name}${subpath.slice(1)}`;
        await expect(import(specifier), specifier).resolves.toBeTypeOf(
          'object',
        );
      }
    },
  );
});
