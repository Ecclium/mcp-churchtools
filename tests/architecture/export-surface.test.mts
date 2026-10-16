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
// of core, is the one place allowed to export the mount. No entry point may
// pass on the factory of the stderr writer either: tools and workflows import
// core and could then write any text to stderr (ADR 0054). Its type
// LineWriter stays allowed, because the context of a call needs it. The
// factory of the HTTP transport leaves core only through its own subpath
// ./http, whose importers a rule of dependency-cruiser limits to the
// composition root, and the build path of the transport, which takes a
// dispatcher and a socket, leaves it through no entry at all (ADR 0056).
// The entry point of the outbound path inside core is checked as well,
// because every module of core may import it.

const boundaries = loadBoundaries();
const { rawClient, mcpMount } = boundaries.places;
const toPattern = (path: string): RegExp => new RegExp(pathPattern(path));

/** Where no export of an entry point may come from. */
const hidden: readonly RegExp[] = [
  ...rawClient.paths.map(toPattern),
  ...mcpMount.paths.map(toPattern),
  /(^|\/)node_modules\/@modelcontextprotocol\//,
];

const lineWriter = 'packages/core/src/logger/line-writer.ts';
const transportModule = 'packages/core/src/http/transport.ts';
const composeModule = 'packages/core/src/http/compose.ts';
const mockModule = 'packages/core/src/http/compose-mock.ts';
const egressEntry = 'packages/core/src/http/index.ts';

/**
 * Single exports that no entry point may pass on, by file and name, except
 * the entry points named in `allowedIn`.
 */
const hiddenSymbols: readonly {
  readonly file: RegExp;
  readonly names: readonly string[];
  readonly allowedIn?: readonly string[];
}[] = [
  {
    file: toPattern(lineWriter),
    names: ['createStderrWriter', 'StderrLineWriter'],
  },
  {
    file: toPattern(transportModule),
    names: ['createTransport', 'createAgent'],
  },
  {
    file: toPattern(composeModule),
    names: ['createHttpTransport'],
    allowedIn: [composeModule],
  },
  {
    file: toPattern(mockModule),
    names: ['createMockedHttpTransport'],
    allowedIn: [mockModule],
  },
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

interface Declaration {
  /** The file of the declaration, relative to root. */
  readonly file: string;
  /** The name under which it is declared, not the exported alias. */
  readonly name: string;
}

/** Declarations behind what the given module exports. */
function exportDeclarations(root: string, entry: string): Declaration[] {
  const file = join(root, entry);
  const program = ts.createProgram([file], compilerOptions);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`cannot read ${entry}`);
  const module = checker.getSymbolAtLocation(source);
  if (module === undefined) return [];
  const visited = new Set<ts.Symbol>([module]);
  const declarationsOf = (symbols: readonly ts.Symbol[]): Declaration[] =>
    symbols.flatMap((symbol) => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      const own = (target.declarations ?? []).map((declaration) => ({
        file: relative(root, declaration.getSourceFile().fileName),
        name: target.getName(),
      }));
      // A namespace export such as `export * as logger from ...` passes on
      // every export of that module, so those count as well.
      if (!(target.flags & ts.SymbolFlags.ValueModule) || visited.has(target)) {
        return own;
      }
      visited.add(target);
      return [...own, ...declarationsOf(checker.getExportsOfModule(target))];
    });
  return declarationsOf(checker.getExportsOfModule(module));
}

/** Files that declare what the given module exports, relative to root. */
const exportOrigins = (root: string, entry: string): string[] =>
  exportDeclarations(root, entry).map(({ file }) => file);

/** Exports that the module must not have, as file or as file and name. */
const hiddenOrigins = (root: string, entry: string): string[] =>
  exportDeclarations(root, entry).flatMap(({ file, name }) => [
    ...(hidden.some((pattern) => pattern.test(file)) ? [file] : []),
    ...(hiddenSymbols.some(
      (symbol) =>
        symbol.file.test(file) &&
        symbol.names.includes(name) &&
        !(symbol.allowedIn ?? []).includes(entry),
    )
      ? [`${file}#${name}`]
      : []),
  ]);

/**
 * The source behind every export of every package, except the mount, and
 * the entry point of the outbound path inside core.
 */
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
entryPoints.push(egressEntry);

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
    [lineWriter]: [
      'export interface LineWriter { write(line: string): boolean }',
      'export interface StderrLineWriter extends LineWriter { stats(): number }',
      'export const createStderrWriter = (): StderrLineWriter => ({ write: () => true, stats: () => 0 });',
      '',
    ].join('\n'),
    [transportModule]: [
      'export interface HttpTransport { close(): Promise<void> }',
      'export const createAgent = (): unknown => undefined;',
      'export const createTransport = (): HttpTransport => ({ close: () => Promise.resolve() });',
      '',
    ].join('\n'),
    [composeModule]: [
      "import { createTransport, type HttpTransport } from './transport.js';",
      "export type { HttpTransport } from './transport.js';",
      'export const createHttpTransport = (): HttpTransport => createTransport();',
      '',
    ].join('\n'),
    [mockModule]: [
      "import { createTransport, type HttpTransport } from './transport.js';",
      'export const createMockedHttpTransport = (): HttpTransport => createTransport();',
      '',
    ].join('\n'),
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
    name: 'the factory of the stderr writer',
    entry: coreEntry,
    files: {
      [coreEntry]:
        "export { createStderrWriter } from './logger/line-writer.js';\n",
    },
  },
  {
    name: 'the factory of the stderr writer in a namespace',
    entry: coreEntry,
    files: {
      [coreEntry]: "export * as writer from './logger/line-writer.js';\n",
    },
  },
  {
    name: 'the factory of the stderr writer in the namespace of an entry',
    entry: coreEntry,
    files: {
      [coreEntry]: "export * as logger from './logger/index.js';\n",
      'packages/core/src/logger/index.ts':
        "export { createStderrWriter } from './line-writer.js';\n",
    },
  },
  {
    name: 'the stderr writer imported as a namespace and exported again',
    entry: coreEntry,
    files: {
      [coreEntry]:
        "import * as writer from './logger/line-writer.js';\nexport { writer };\n",
    },
  },
  {
    name: 'the type of the stderr writer under another name',
    entry: coreEntry,
    files: {
      [coreEntry]:
        "export type { StderrLineWriter as Writer } from './logger/line-writer.js';\n",
    },
  },
  {
    name: 'the factory of the transport through the entry point of core',
    entry: coreEntry,
    files: {
      [coreEntry]:
        "export { createHttpTransport as transport } from './http/compose.js';\n",
    },
  },
  {
    name: 'the build path of the transport through the outbound path',
    entry: egressEntry,
    files: {
      [egressEntry]: "export { createTransport } from './transport.js';\n",
    },
  },
  {
    name: 'the agent of the transport through the subpath of the factory',
    entry: composeModule,
    files: {
      [composeModule]: "export { createAgent } from './transport.js';\n",
    },
  },
  {
    name: 'the factory of the transport through the outbound path',
    entry: egressEntry,
    files: {
      [egressEntry]: "export * from './compose.js';\n",
    },
  },
  {
    name: 'the transport on a MockAgent through the entry point of testkit',
    entry: 'packages/testkit/src/index.ts',
    files: {
      'packages/testkit/src/index.ts':
        "export { createMockedHttpTransport } from '../../core/src/http/compose-mock.js';\n",
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
    expect(entryPoints).toEqual(
      expect.arrayContaining([composeModule, mockModule, egressEntry]),
    );
  });

  it.each(entryPoints)(
    '%s exports nothing from the raw client, the mount, the MCP SDK or the stderr writer',
    (entry) => {
      expect(hiddenOrigins(workspaceRoot, entry)).toEqual([]);
    },
  );

  it.each(leaks)('refuse to export $name', ({ entry, files }) => {
    expect(hiddenOrigins(writeTree(files), entry)).not.toEqual([]);
  });

  it('have a failing example for every forbidden origin and name', () => {
    const declarations = leaks.flatMap(({ entry, files }) =>
      exportDeclarations(writeTree(files), entry),
    );
    for (const pattern of hidden) {
      expect(
        declarations.some(({ file }) => pattern.test(file)),
        String(pattern),
      ).toBe(true);
    }
    for (const symbol of hiddenSymbols) {
      for (const name of symbol.names) {
        expect(
          declarations.some(
            (declaration) =>
              symbol.file.test(declaration.file) && declaration.name === name,
          ),
          name,
        ).toBe(true);
      }
    }
  });

  it('accept the type of the line writer, which the context of a call needs', () => {
    const root = writeTree({
      [coreEntry]:
        "export type { LineWriter } from './logger/line-writer.js';\n",
    });
    expect(exportOrigins(root, coreEntry)).toEqual([lineWriter]);
    expect(hiddenOrigins(root, coreEntry)).toEqual([]);
  });

  it('accept the factory of the transport in its own subpath and its type in the outbound path', () => {
    const root = writeTree({
      [egressEntry]: "export type { HttpTransport } from './transport.js';\n",
    });
    expect(hiddenOrigins(root, composeModule)).toEqual([]);
    expect(exportOrigins(root, egressEntry)).toEqual([transportModule]);
    expect(hiddenOrigins(root, egressEntry)).toEqual([]);
  });

  it('accept an export declared in the package itself', () => {
    const root = writeTree({ [coreEntry]: 'export const version = 1;\n' });
    expect(exportOrigins(root, coreEntry)).toEqual([coreEntry]);
    expect(hiddenOrigins(root, coreEntry)).toEqual([]);
  });
});
