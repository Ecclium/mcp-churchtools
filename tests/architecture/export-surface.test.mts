import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

import { workspaceRoot } from './boundaries.mts';

// dependency-cruiser sees only which module imports which. If the entry point
// of core re-exported the raw ChurchTools client or the mount, every package
// could use them through `@ecclium/mcp-churchtools-core` without a single
// forbidden import (ADR 0024). This test follows each export of the entry
// point to its declaration with the TypeScript checker.

/** Where exports of the entry point of core must not come from. */
const hidden = [
  /^packages\/core\/src\/churchtools\//,
  /^packages\/core\/src\/mcp\//,
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

const hiddenOrigins = (root: string): string[] =>
  exportOrigins(root, 'packages/core/src/index.ts').filter((origin) =>
    hidden.some((pattern) => pattern.test(origin)),
  );

const temporaryFolders: string[] = [];
afterAll(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function writeCore(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-surface-')));
  temporaryFolders.push(root);
  const all = {
    'packages/core/package.json': '{ "type": "module" }\n',
    'packages/core/src/churchtools/index.ts':
      'export const rawClient = { get: (): void => undefined };\n',
    'packages/core/src/mcp/mount.ts':
      'export const mount = (): void => undefined;\n',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('entry point of core', () => {
  it('exports nothing from the raw client, the mount or the MCP SDK', () => {
    expect(hiddenOrigins(workspaceRoot)).toEqual([]);
  });

  const leaks: readonly {
    readonly name: string;
    readonly files: Readonly<Record<string, string>>;
  }[] = [
    {
      name: 'the raw client through another module',
      files: {
        'packages/core/src/index.ts': "export * from './relay.js';\n",
        'packages/core/src/relay.ts':
          "export { rawClient } from './churchtools/index.js';\n",
      },
    },
    {
      name: 'the raw client imported and exported again',
      files: {
        'packages/core/src/index.ts':
          "import { rawClient } from './churchtools/index.js';\nexport { rawClient };\n",
      },
    },
    {
      name: 'the mount under another name',
      files: {
        'packages/core/src/index.ts':
          "export { mount as register } from './mcp/mount.js';\n",
      },
    },
  ];

  it.each(leaks)('refuses to export $name', ({ files }) => {
    expect(hiddenOrigins(writeCore(files))).not.toEqual([]);
  });

  it('accepts an export declared in core itself', () => {
    const root = writeCore({
      'packages/core/src/index.ts': 'export const version = 1;\n',
    });
    expect(exportOrigins(root, 'packages/core/src/index.ts')).toEqual([
      'packages/core/src/index.ts',
    ]);
    expect(hiddenOrigins(root)).toEqual([]);
  });
});
