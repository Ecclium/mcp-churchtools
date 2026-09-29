import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

import {
  type Boundaries,
  loadBoundaries,
  workspaceRoot,
} from './boundaries.mts';

// The package cut is enforced three times: the dependencies in each
// package.json, the TypeScript project references and dependency-cruiser
// (ADR 0022). This test keeps the first two in line with boundaries.json,
// the table dependency-cruiser checks against. tsconfig files contain
// comments, so they are read with the TypeScript API, not with JSON.parse.

interface Finding {
  readonly check: string;
  readonly detail: string;
}

/** The checks, each proven below by a change that breaks only it. */
const checks = [
  'declared-imports',
  'testkit-dev-only',
  'build-references',
  'test-references',
  'solution-build',
  'solution-root',
  'solution-tests',
] as const;

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const readFile = (path: string): string | undefined => ts.sys.readFile(path);

/** Reads a tsconfig file, comments included. */
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

/** Referenced config files, relative to root. A folder means its tsconfig.json. */
function references(root: string, file: string): string[] {
  const found = (readTsconfig(join(root, file))['references'] ?? []) as {
    path: string;
  }[];
  return found.map((reference) => {
    const target = resolve(dirname(join(root, file)), reference.path);
    return relative(
      root,
      target.endsWith('.json') ? target : join(target, 'tsconfig.json'),
    );
  });
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

function checkWorkspaceGraph(root: string, boundaries: Boundaries): Finding[] {
  const findings: Finding[] = [];
  const report = (check: (typeof checks)[number], detail: string): void => {
    findings.push({ check, detail });
  };
  const dirByName = new Map(
    boundaries.packages.map((pkg) => [pkg.name, pkg.dir]),
  );
  const testOnly = boundaries.testOnly;
  const workspaceDirs = (deps: Readonly<Record<string, string>> = {}) =>
    Object.keys(deps).flatMap((name) => dirByName.get(name) ?? []);

  for (const pkg of boundaries.packages) {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', pkg.dir, 'package.json'), 'utf8'),
    ) as Manifest;
    const runtime = [
      ...workspaceDirs(manifest.dependencies),
      ...workspaceDirs(manifest.peerDependencies),
      ...workspaceDirs(manifest.optionalDependencies),
    ];
    const outside = runtime.filter(
      (dir) => dir !== testOnly && !pkg.imports.includes(dir),
    );
    if (outside.length > 0) {
      report('declared-imports', `${pkg.dir} depends on ${outside.join(', ')}`);
    }
    const devOnly = workspaceDirs(manifest.devDependencies).filter(
      (dir) => dir !== testOnly,
    );
    if (runtime.includes(testOnly) || devOnly.length > 0) {
      report(
        'testkit-dev-only',
        `${pkg.dir}: ${testOnly} belongs under devDependencies, and nothing else from the workspace does`,
      );
    }
    const build = references(root, `packages/${pkg.dir}/tsconfig.json`);
    const expectedBuild = runtime
      .filter((dir) => dir !== testOnly)
      .map((dir) => `packages/${dir}/tsconfig.json`);
    if (!sameSet(build, expectedBuild)) {
      report('build-references', `${pkg.dir}: ${build.join(', ')}`);
    }
    const test = references(root, `packages/${pkg.dir}/tsconfig.test.json`);
    const expectedTest = [
      `packages/${pkg.dir}/tsconfig.json`,
      ...(pkg.dir === testOnly ? [] : [`packages/${testOnly}/tsconfig.json`]),
    ];
    if (!sameSet(test, expectedTest)) {
      report('test-references', `${pkg.dir}: ${test.join(', ')}`);
    }
  }

  const every = (file: string) =>
    boundaries.packages.map((pkg) => `packages/${pkg.dir}/${file}`);
  const missing = (found: readonly string[], wanted: readonly string[]) =>
    wanted.filter((file) => !found.includes(file));
  const build = references(root, 'tsconfig.build.json');
  if (!sameSet(build, every('tsconfig.json'))) {
    report('solution-build', build.join(', '));
  }
  const rootMissing = missing(references(root, 'tsconfig.json'), [
    'tsconfig.build.json',
    ...every('tsconfig.test.json'),
  ]);
  if (rootMissing.length > 0) {
    report('solution-root', `missing ${rootMissing.join(', ')}`);
  }
  const testsMissing = missing(
    references(root, 'tests/tsconfig.json'),
    every('tsconfig.json'),
  );
  if (testsMissing.length > 0) {
    report('solution-tests', `missing ${testsMissing.join(', ')}`);
  }
  return findings;
}

const boundaries = loadBoundaries();

const temporaryFolders: string[] = [];
afterAll(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

/** The manifests and tsconfig files of the workspace, in a temporary folder. */
function copyGraph(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-graph-')));
  temporaryFolders.push(root);
  const files = [
    'tsconfig.json',
    'tsconfig.build.json',
    'tests/tsconfig.json',
    ...boundaries.packages.flatMap((pkg) =>
      ['package.json', 'tsconfig.json', 'tsconfig.test.json'].map(
        (file) => `packages/${pkg.dir}/${file}`,
      ),
    ),
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(workspaceRoot, file), join(root, file));
  }
  return root;
}

/** Changes a JSON or tsconfig file of the copy; comments are dropped. */
function edit(
  root: string,
  file: string,
  change: (content: Record<string, unknown>) => void,
): void {
  const config = readTsconfig(join(root, file));
  change(config);
  writeFileSync(join(root, file), `${JSON.stringify(config, null, 2)}\n`);
}

type Refs = { path: string }[];
type Deps = Record<string, string>;
const refsOf = (config: Record<string, unknown>): Refs =>
  config['references'] as Refs;
const depsOf = (config: Record<string, unknown>, key: string): Deps => {
  const deps = (config[key] ?? {}) as Deps;
  config[key] = deps;
  return deps;
};

const cases: readonly {
  readonly check: (typeof checks)[number];
  readonly name: string;
  readonly change: (root: string) => void;
}[] = [
  {
    check: 'declared-imports',
    name: 'core depends on tools, with a reference to match',
    change: (root) => {
      edit(root, 'packages/core/package.json', (c) => {
        depsOf(c, 'dependencies')['@ecclium/mcp-churchtools-tools'] =
          'workspace:*';
      });
      edit(root, 'packages/core/tsconfig.json', (c) => {
        refsOf(c).push({ path: '../tools' });
      });
    },
  },
  {
    check: 'testkit-dev-only',
    name: 'core lists another workspace package under devDependencies',
    change: (root) => {
      edit(root, 'packages/core/package.json', (c) => {
        depsOf(c, 'devDependencies')['@ecclium/mcp-churchtools-tools'] =
          'workspace:*';
      });
    },
  },
  {
    check: 'testkit-dev-only',
    name: 'core lists the testkit as a runtime dependency',
    change: (root) => {
      edit(root, 'packages/core/package.json', (c) => {
        const dev = depsOf(c, 'devDependencies');
        const testkit = '@ecclium/mcp-churchtools-testkit';
        depsOf(c, 'dependencies')[testkit] = dev[testkit] ?? 'workspace:*';
        c['devDependencies'] = Object.fromEntries(
          Object.entries(dev).filter(([name]) => name !== testkit),
        );
      });
    },
  },
  {
    check: 'build-references',
    name: 'the build project of core misses its dependency',
    change: (root) => {
      edit(root, 'packages/core/tsconfig.json', (c) => {
        c['references'] = [];
      });
    },
  },
  {
    check: 'test-references',
    name: 'the test project of core references tools',
    change: (root) => {
      edit(root, 'packages/core/tsconfig.test.json', (c) => {
        refsOf(c).push({ path: '../tools' });
      });
    },
  },
  {
    check: 'solution-build',
    name: 'the build solution leaves out core',
    change: (root) => {
      edit(root, 'tsconfig.build.json', (c) => {
        c['references'] = refsOf(c).filter(
          (ref) => ref.path !== './packages/core',
        );
      });
    },
  },
  {
    check: 'solution-root',
    name: 'the root project leaves out the tests of core',
    change: (root) => {
      edit(root, 'tsconfig.json', (c) => {
        c['references'] = refsOf(c).filter(
          (ref) => ref.path !== './packages/core/tsconfig.test.json',
        );
      });
    },
  },
  {
    check: 'solution-tests',
    name: 'the workspace tests leave out core',
    change: (root) => {
      edit(root, 'tests/tsconfig.json', (c) => {
        c['references'] = refsOf(c).filter(
          (ref) => ref.path !== '../packages/core',
        );
      });
    },
  },
];

describe('workspace graph', () => {
  it('matches boundaries.json', () => {
    expect(checkWorkspaceGraph(workspaceRoot, boundaries)).toEqual([]);
  });

  it('matches boundaries.json in an unchanged copy', () => {
    expect(checkWorkspaceGraph(copyGraph(), boundaries)).toEqual([]);
  });

  it.each(cases)('$check: refuses that $name', ({ check, change }) => {
    const root = copyGraph();
    change(root);
    const found = checkWorkspaceGraph(root, boundaries).map((f) => f.check);
    expect([...new Set(found)]).toEqual([check]);
  });

  it('has a failing example for every check', () => {
    expect(new Set(cases.map((c) => c.check))).toEqual(new Set(checks));
  });
});
