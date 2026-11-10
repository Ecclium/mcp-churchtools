import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { getAvailableTranspilers } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

import { loadBoundaries, workspaceRoot } from './boundaries.mts';
import {
  allowedCases,
  assertInsideCopy,
  cases,
  casesOfFile,
  cruiseCopy,
  cruiseFolder,
  cruiseTimeout,
  options,
  partCount,
  partOfFile,
  rules,
  temporaryFoldersOfFile,
} from './dependency-cases.mts';

// The checks of the dependency rules that need no case: the configuration,
// the packages as they are, the copy of the workspace that every case uses,
// that every rule has a case and that every case runs in exactly one part.
// The cases run in dependency-rules-1.test.mts to dependency-rules-6.test.mts;
// dependency-cases.mts says why (ADR 0022).

const boundaries = loadBoundaries();
const temporaryFolders = temporaryFoldersOfFile();

// Paths of rules that match no module of the workspace. node:process and
// node:diagnostics_channel are refused everywhere, so their paths match
// nothing for as long as the packages keep the rules. The test below fails
// as soon as one of these paths matches.
const notYetMatched: readonly string[] = [
  'no-process-module.to: ^(node:)?process$',
  'no-diagnostics-channel.to: ^(node:)?diagnostics_channel$',
];

describe('the copy of the workspace', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-copy-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-outside-')));
  temporaryFolders.push(base, outside);
  mkdirSync(join(base, 'node_modules'));
  symlinkSync(outside, join(base, 'node_modules', 'linked'));
  writeFileSync(join(outside, 'file.js'), '');
  symlinkSync(join(outside, 'file.js'), join(base, 'link.js'));

  it('accepts a new file inside the copy', () => {
    expect(() => {
      assertInsideCopy(base, 'packages/core/src/new/file.ts');
    }).not.toThrow();
  });

  it.each(['node_modules/linked/file.js', 'node_modules/linked/new/file.js'])(
    'refuses %s, which lies in a linked folder',
    (path) => {
      expect(() => {
        assertInsideCopy(base, path);
      }).toThrow(/would be written outside the copy/);
    },
  );

  it('refuses a file that is a link', () => {
    expect(() => {
      assertInsideCopy(base, 'link.js');
    }).toThrow(/would be written outside the copy/);
  });
});

describe('dependency-cruiser rules', { timeout: cruiseTimeout }, () => {
  it('pass the packages as they are', async () => {
    const result = await cruiseFolder(workspaceRoot);
    expect(result.summary.violations).toEqual([]);
  });

  it('pass an unchanged copy of the packages', async () => {
    const result = await cruiseCopy({}, temporaryFolders);
    expect(result.summary.violations).toEqual([]);
  });

  it('leave no copy of the unchanged packages on disk', () => {
    const copies = temporaryFolders.filter((folder) =>
      folder.split(sep).at(-1)?.startsWith('ecclium-arch-'),
    );
    expect(copies).toHaveLength(1);
    expect(copies.filter((folder) => existsSync(folder))).toEqual([]);
  });

  it('have a failing example for every rule', () => {
    const proven = new Set(cases.map((c) => c.rule));
    expect(rules.map((rule) => rule.name).sort()).toEqual([...proven].sort());
  });
});

describe('the parts of the cases', () => {
  const folder = import.meta.dirname;
  const partFiles = readdirSync(folder)
    .filter((file) => file.startsWith('dependency-rules-'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const parts = Array.from({ length: partCount }, (_, index) => index + 1);

  it('have one test file for each part, which runs the part of its name', () => {
    expect(partFiles).toEqual(
      parts.map((part) => `dependency-rules-${String(part)}.test.mts`),
    );
    for (const file of partFiles) {
      expect(readFileSync(join(folder, file), 'utf8'), file).toContain(
        'describePart(import.meta.filename);',
      );
    }
  });

  // A case that no part file runs would drop out without a failure, and
  // "a failing example for every rule" would stay green.
  it.each(['refused', 'allowed'] as const)(
    'give each of the %s cases to exactly one part file',
    (kind) => {
      const list: readonly object[] = kind === 'refused' ? cases : allowedCases;
      const places = partFiles
        .flatMap(
          (file): readonly object[] => casesOfFile(join(folder, file))[kind],
        )
        .map((entry) => list.indexOf(entry))
        .sort((a, b) => a - b);
      expect(places).toEqual(list.map((_entry, index) => index));
    },
  );

  it('reads the part from the name of its file', () => {
    expect(
      partOfFile(join(import.meta.dirname, 'dependency-rules-6.test.mts')),
    ).toBe(6);
  });

  it.each([
    'dependency-rules.test.mts',
    'dependency-rules-0.test.mts',
    'dependency-rules-7.test.mts',
    'dependency-rules-1.test.ts',
    'dependency-rules-1a.test.mts',
  ])('refuses %s as the file of a part', (file) => {
    expect(() => partOfFile(file)).toThrow(/names no part/);
  });
});

describe('dependency-cruiser configuration', () => {
  // Each of these settings, if wrong, lets real violations pass without a
  // failure: a rule with severity warn exits with code 0; exclude and
  // includeOnly drop the edges into what they leave out; without
  // tsPreCompilationDeps type-only imports disappear; without the source
  // condition every import falls back to a build or does not resolve.
  it('reports every rule as an error and names its ADR', () => {
    for (const rule of rules) {
      expect(rule.severity, rule.name).toBe('error');
      expect(rule.comment, rule.name).toMatch(/^ADR \d{4}: /);
    }
  });

  it('keeps every edge and reads type-only imports', () => {
    expect(options).not.toHaveProperty('exclude');
    expect(options).not.toHaveProperty('includeOnly');
    expect(options.doNotFollow).toEqual({
      path: ['(^|/)node_modules/', '^packages/[^/]+/dist/'],
    });
    expect(options.tsPreCompilationDeps).toBe(true);
    expect(options.validate).toBe(true);
  });

  it('resolves workspace packages to their source first', () => {
    expect(options.enhancedResolveOptions?.conditionNames?.[0]).toBe(
      '@ecclium/source',
    );
    expect(options.enhancedResolveOptions?.exportsFields).toEqual(['exports']);
  });

  it('finds a TypeScript version it can read', () => {
    // Without one, dependency-cruiser finds no module and reports success.
    const typescript = getAvailableTranspilers().find(
      (transpiler) => transpiler.name === 'typescript',
    );
    expect(typescript?.available).toBe(true);
  });
});

describe('dependency-cruiser on the packages as they are', () => {
  const sourceFiles = boundaries.packages.flatMap((pkg) =>
    readdirSync(join(workspaceRoot, 'packages', pkg.dir, 'src'), {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((file) => /\.[cm]?ts$/.test(file))
      .map((file) => join('packages', pkg.dir, 'src', file)),
  );
  const run = cruiseFolder(workspaceRoot);

  it('reads and follows every source file of every package', async () => {
    const followed = new Set(
      (await run).modules
        .filter((module) => module.followable !== false)
        .map((module) => module.source),
    );
    expect(sourceFiles.filter((file) => !followed.has(file))).toEqual([]);
  });

  it('finds no folder named dist or node_modules among the sources', () => {
    // ESLint skips every dist/ folder, so code in such a folder would escape
    // the rules for output.
    const hidden = sourceFiles.filter((file) =>
      /\/src\/(.+\/)?(dist|node_modules)\//.test(file),
    );
    expect(hidden).toEqual([]);
  });

  it('resolves every import between packages to the source', async () => {
    const crossing = (await run).modules.flatMap((module) =>
      module.dependencies
        .filter((dependency) => dependency.resolved.startsWith('packages/'))
        .filter(
          (dependency) =>
            dependency.resolved.split('/')[1] !== module.source.split('/')[1],
        )
        .map((dependency) => dependency.resolved),
    );
    expect(crossing.length).toBeGreaterThan(0);
    expect(
      crossing.filter((path) => !/^packages\/[^/]+\/src\//.test(path)),
    ).toEqual([]);
  });

  it('matches at least one module with every path of every rule', async () => {
    // A rule whose path matches nothing checks nothing, for example after a
    // folder was renamed. $1 stands for the package folder of the importer.
    // Only the paths in notYetMatched may match nothing, and they must.
    const modules = (await run).modules.map((module) => module.source);
    const empty = rules.flatMap((rule) => {
      const sides = { from: rule.from, to: 'to' in rule ? rule.to : undefined };
      return Object.entries(sides).flatMap(([side, restriction]) =>
        [restriction?.path ?? []].flat().flatMap((pattern) => {
          const regex = new RegExp(pattern.replaceAll('$1', '[^/]+'));
          return modules.some((module) => regex.test(module))
            ? []
            : [`${rule.name ?? ''}.${side}: ${pattern}`];
        }),
      );
    });
    expect(empty).toEqual(notYetMatched);
  });
});
