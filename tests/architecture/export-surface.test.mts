import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

import { loadBoundaries, workspaceRoot } from './boundaries.mts';
import { pathPattern } from './dependency-rules.mts';

// dependency-cruiser sees only which module imports which. If an entry point
// re-exported the raw ChurchTools client, the mount or the MCP SDK, other
// packages could use them through a permitted import (ADR 0024). This test
// follows each export of every entry point to its declaration with the
// TypeScript checker. The entry point of the mount itself, the subpath ./mcp
// of core, is the one place allowed to export the mount.

const boundaries = loadBoundaries();
const { rawClient, mcpMount } = boundaries.places;
const toPattern = (path: string): RegExp => new RegExp(pathPattern(path));

/** Where no export of an entry point may come from. */
const hidden: readonly RegExp[] = [
  ...rawClient.paths.map(toPattern),
  ...mcpMount.paths.map(toPattern),
  /(^|\/)node_modules\/@modelcontextprotocol\//,
];

const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2025,
  customConditions: ['@ecclium/source'],
  strict: true,
  noEmit: true,
  types: [],
};

/** Files that declare what the given module exports, relative to root. */
function exportOrigins(root: string, entry: string): string[] {
  const file = join(root, entry);
  const program = ts.createProgram([file], compilerOptions);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`cannot read ${entry}`);
  const module = checker.getSymbolAtLocation(source);
  if (module === undefined) return [];
  return checker.getExportsOfModule(module).flatMap((symbol) => {
    const target =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    return (target.declarations ?? []).map((declaration) =>
      relative(root, declaration.getSourceFile().fileName),
    );
  });
}

const hiddenOrigins = (root: string, entry: string): string[] =>
  exportOrigins(root, entry).filter((origin) =>
    hidden.some((pattern) => pattern.test(origin)),
  );

/** The source behind every export of every package, except the mount. */
const entryPoints = boundaries.packages.flatMap((pkg) => {
  const manifest = JSON.parse(
    readFileSync(
      join(workspaceRoot, 'packages', pkg.dir, 'package.json'),
      'utf8',
    ),
  ) as { exports: Record<string, Record<string, string>> };
  return Object.values(manifest.exports)
    .flatMap((conditions) => conditions['@ecclium/source'] ?? [])
    .map((source) => join('packages', pkg.dir, source))
    .filter(
      (entry) => !mcpMount.paths.some((path) => toPattern(path).test(entry)),
    );
});

const temporaryFolders: string[] = [];
afterAll(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-surface-')));
  temporaryFolders.push(root);
  const all = {
    'packages/core/package.json': '{ "type": "module" }\n',
    'packages/server/package.json': '{ "type": "module" }\n',
    'packages/core/src/churchtools/index.ts':
      'export const rawClient = { get: (): void => undefined };\n',
    'packages/core/src/mcp/mount.ts':
      'export const mount = (): void => undefined;\n',
    'node_modules/@modelcontextprotocol/server/package.json':
      '{ "name": "@modelcontextprotocol/server", "type": "module", "exports": { ".": { "types": "./index.d.ts" } } }\n',
    'node_modules/@modelcontextprotocol/server/index.d.ts':
      'export declare const McpServer: unknown;\n',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const coreEntry = 'packages/core/src/index.ts';

const leaks: readonly {
  readonly name: string;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}[] = [
  {
    name: 'the raw client through another module',
    entry: coreEntry,
    files: {
      [coreEntry]: "export * from './relay.js';\n",
      'packages/core/src/relay.ts':
        "export { rawClient } from './churchtools/index.js';\n",
    },
  },
  {
    name: 'the raw client imported and exported again',
    entry: coreEntry,
    files: {
      [coreEntry]:
        "import { rawClient } from './churchtools/index.js';\nexport { rawClient };\n",
    },
  },
  {
    name: 'the mount under another name',
    entry: coreEntry,
    files: {
      [coreEntry]: "export { mount as register } from './mcp/mount.js';\n",
    },
  },
  {
    name: 'a type of the MCP SDK',
    entry: coreEntry,
    files: {
      [coreEntry]:
        "export { McpServer } from '@modelcontextprotocol/server';\n",
    },
  },
  {
    name: 'the mount, passed on by the server',
    entry: 'packages/server/src/index.ts',
    files: {
      'packages/server/src/index.ts':
        "export { mount } from '../../core/src/mcp/mount.js';\n",
    },
  },
];

// Each test builds a TypeScript program and needs well under a second.
// Under heavy load, such as several checks running at once, one took longer
// than the default limit of five seconds.
const timeout = 30_000;

describe('entry points of the packages', { timeout }, () => {
  it('include every package', () => {
    expect(entryPoints).toEqual(
      expect.arrayContaining(
        boundaries.packages.map((pkg) => `packages/${pkg.dir}/src/index.ts`),
      ),
    );
  });

  it.each(entryPoints)(
    '%s exports nothing from the raw client, the mount or the MCP SDK',
    (entry) => {
      expect(hiddenOrigins(workspaceRoot, entry)).toEqual([]);
    },
  );

  it.each(leaks)('refuse to export $name', ({ entry, files }) => {
    expect(hiddenOrigins(writeTree(files), entry)).not.toEqual([]);
  });

  it('have a failing example for every forbidden origin', () => {
    const origins = leaks.flatMap(({ entry, files }) =>
      exportOrigins(writeTree(files), entry),
    );
    for (const pattern of hidden) {
      expect(
        origins.some((origin) => pattern.test(origin)),
        String(pattern),
      ).toBe(true);
    }
  });

  it('accept an export declared in the package itself', () => {
    const root = writeTree({ [coreEntry]: 'export const version = 1;\n' });
    expect(exportOrigins(root, coreEntry)).toEqual([coreEntry]);
    expect(hiddenOrigins(root, coreEntry)).toEqual([]);
  });
});
