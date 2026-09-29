import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

import { loadBoundaries, workspaceRoot } from './boundaries.mts';

// The configuration uses no option that TypeScript 6.0 deprecates, so that
// moving to TypeScript 7 needs no rework (ADR 0020). `tsc -b` alone does not
// guarantee this: it does not check the options of the solution files that
// only reference other projects, it accepts removed options set to a false
// value, and ignoreDeprecations silences every warning of TypeScript 6.0 at
// once. This test reads every tsconfig file itself. It also checks that
// each package builds exactly its own src/ folder (ADR 0022).

/** The checks, each proven below by a file that breaks it. */
const checks = [
  'forbidden-option',
  'forbidden-value',
  'compiler-diagnostic',
  'root-dir',
] as const;
type Check = (typeof checks)[number];

/** Options that must not appear, whatever their value. */
const forbiddenOptions: ReadonlySet<string> = new Set([
  // Silences the warnings of TypeScript 6.0 about everything below.
  'ignoreDeprecations',
  // Deprecated in TypeScript 6.0, gone in TypeScript 7.
  'baseUrl',
  'downlevelIteration',
  'outFile',
  // Removed in TypeScript 5.5; TypeScript accepts some of them when false.
  'out',
  'importsNotUsedAsValues',
  'preserveValueImports',
  'keyofStringsOnly',
  'suppressImplicitAnyIndexErrors',
  'suppressExcessPropertyErrors',
  'noImplicitUseStrict',
  'noStrictGenericChecks',
  'charset',
]);

/** Values deprecated in TypeScript 6.0 or removed before. */
const forbiddenValues: Readonly<Record<string, readonly (string | boolean)[]>> =
  {
    esModuleInterop: [false],
    allowSyntheticDefaultImports: [false],
    alwaysStrict: [false],
    target: ['es3', 'es5'],
    moduleResolution: ['node', 'node10', 'classic'],
    module: ['none', 'amd', 'umd', 'system'],
  };

/** Diagnostics of TypeScript about deprecated or removed options. */
const deprecationCodes: ReadonlySet<number> = new Set([
  5101, 5102, 5103, 5107, 5108,
]);

const readFile = (path: string): string | undefined => ts.sys.readFile(path);

function readTsconfig(file: string): Record<string, unknown> {
  const read: { config?: unknown; error?: ts.Diagnostic } = ts.readConfigFile(
    file,
    readFile,
  );
  const { config, error } = read;
  if (error !== undefined || typeof config !== 'object' || config === null) {
    throw new Error(`cannot read ${file}`);
  }
  return config as Record<string, unknown>;
}

/**
 * Parses a tsconfig file with everything it extends. The file list does not
 * matter here, so the host lists no files instead of searching the tree.
 */
function parse(file: string): ts.ParsedCommandLine {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    readDirectory: () => [],
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      );
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, host);
  if (parsed === undefined) throw new Error(`cannot parse ${file}`);
  return parsed;
}

const skipped: ReadonlySet<string> = new Set([
  '.git',
  'brand',
  'coverage',
  'dist',
  'node_modules',
]);

/** Every tsconfig file of a tree, relative to its root. */
function tsconfigFiles(root: string, folder = ''): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        return skipped.has(entry.name) ? [] : tsconfigFiles(root, path);
      }
      return /^tsconfig(\..+)?\.json$/.test(entry.name) ? [path] : [];
    },
  );
}

function checkOptions(root: string): string[] {
  return tsconfigFiles(root).flatMap((file) => {
    const found = new Set<Check>();
    const raw = readTsconfig(join(root, file));
    const options = (raw['compilerOptions'] ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(options)) {
      if (forbiddenOptions.has(key)) found.add('forbidden-option');
      const normalized =
        typeof value === 'string' ? value.toLowerCase() : value;
      if (
        forbiddenValues[key]?.some((forbidden) => forbidden === normalized) ===
        true
      ) {
        found.add('forbidden-value');
      }
    }
    const references = (raw['references'] ?? []) as Record<string, unknown>[];
    if (references.some((reference) => 'prepend' in reference)) {
      found.add('forbidden-option');
    }
    // Ask TypeScript as well, which also follows extends and knows the
    // options this list may not name yet.
    const parsed = parse(join(root, file));
    const program = ts.createProgram({
      rootNames: [],
      options: parsed.options,
      ...(parsed.projectReferences === undefined
        ? {}
        : { projectReferences: parsed.projectReferences }),
    });
    if (
      program
        .getOptionsDiagnostics()
        .some((diagnostic) => deprecationCodes.has(diagnostic.code))
    ) {
      found.add('compiler-diagnostic');
    }
    return [...found].map((check) => `${file}: ${check}`);
  });
}

function checkRootDirs(root: string, dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) =>
    ['tsconfig.json', 'tsconfig.test.json'].flatMap((name) => {
      const file = join('packages', dir, name);
      const rootDir =
        parse(join(root, file)).options.rootDir ?? dirname(join(root, file));
      return relative(root, rootDir) === join('packages', dir, 'src')
        ? []
        : [`${file}: root-dir`];
    }),
  );
}

const temporaryFolders: string[] = [];
afterAll(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function writeTree(files: Readonly<Record<string, unknown>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-tsconfig-')));
  temporaryFolders.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

const cases: readonly {
  readonly name: string;
  readonly files: Readonly<Record<string, unknown>>;
  readonly found: readonly string[];
}[] = [
  {
    name: 'a removed option that TypeScript accepts when set to its off value',
    files: {
      'tsconfig.json': {
        files: [],
        compilerOptions: { importsNotUsedAsValues: 'remove' },
      },
    },
    found: ['tsconfig.json: forbidden-option'],
  },
  {
    name: 'a deprecated option in a solution file that tsc -b does not check',
    files: {
      'tsconfig.json': {
        files: [],
        references: [],
        compilerOptions: { baseUrl: '.' },
      },
    },
    found: [
      'tsconfig.json: compiler-diagnostic',
      'tsconfig.json: forbidden-option',
    ],
  },
  {
    name: 'ignoreDeprecations, which silences TypeScript about a deprecated value',
    files: {
      'tsconfig.json': {
        files: [],
        compilerOptions: { ignoreDeprecations: '6.0', alwaysStrict: false },
      },
    },
    found: [
      'tsconfig.json: forbidden-option',
      'tsconfig.json: forbidden-value',
    ],
  },
  {
    name: 'a deprecated value in capitals',
    files: {
      'tsconfig.json': { files: [], compilerOptions: { target: 'ES5' } },
    },
    found: [
      'tsconfig.json: compiler-diagnostic',
      'tsconfig.json: forbidden-value',
    ],
  },
  {
    name: 'a reference with prepend',
    files: {
      'tsconfig.json': {
        files: [],
        references: [{ path: './other', prepend: true }],
      },
      'other/tsconfig.json': {
        files: [],
        compilerOptions: { composite: true },
      },
    },
    found: [
      'tsconfig.json: compiler-diagnostic',
      'tsconfig.json: forbidden-option',
    ],
  },
  {
    name: 'a deprecated option inherited through extends',
    files: {
      'tsconfig.base.json': { compilerOptions: { downlevelIteration: true } },
      'tsconfig.json': { extends: './tsconfig.base.json', files: [] },
    },
    found: [
      'tsconfig.base.json: compiler-diagnostic',
      'tsconfig.base.json: forbidden-option',
      'tsconfig.json: compiler-diagnostic',
    ],
  },
];

describe('tsconfig files', () => {
  const files = tsconfigFiles(workspaceRoot);

  it('include the solution files and every package project', () => {
    const boundaries = loadBoundaries();
    expect(files).toEqual(
      expect.arrayContaining([
        'tsconfig.json',
        'tsconfig.build.json',
        'tsconfig.base.json',
        ...boundaries.packages.flatMap((pkg) => [
          `packages/${pkg.dir}/tsconfig.json`,
          `packages/${pkg.dir}/tsconfig.test.json`,
        ]),
      ]),
    );
  });

  it('use no deprecated or removed option', () => {
    expect(checkOptions(workspaceRoot)).toEqual([]);
  });

  it('let every package build exactly its own src/ folder', () => {
    const dirs = loadBoundaries().packages.map((pkg) => pkg.dir);
    expect(checkRootDirs(workspaceRoot, dirs)).toEqual([]);
  });

  it.each(cases)('refuse $name', ({ files: tree, found }) => {
    expect(checkOptions(writeTree(tree)).sort()).toEqual([...found].sort());
  });

  it('refuse a package whose rootDir is not its src/ folder', () => {
    const root = writeTree({
      'packages/core/tsconfig.json': { compilerOptions: { rootDir: '.' } },
      'packages/core/tsconfig.test.json': {
        compilerOptions: { rootDir: './src' },
      },
    });
    expect(checkRootDirs(root, ['core'])).toEqual([
      'packages/core/tsconfig.json: root-dir',
    ]);
  });

  it('have a failing example for every check', () => {
    const proven = new Set(
      [...cases.flatMap((c) => c.found), 'root-dir'].map(
        (entry) => entry.split(': ').pop() ?? '',
      ),
    );
    expect(proven).toEqual(new Set(checks));
  });
});
