import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  cruise,
  getAvailableTranspilers,
  type ICruiseResult,
  type IForbiddenRuleType,
} from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import { afterAll, describe, expect, it } from 'vitest';

import { loadBoundaries, workspaceRoot } from './boundaries.mts';

// Each dependency-cruiser rule is proven by a forbidden example: the test
// copies the packages into a temporary folder, adds one file that breaks
// exactly this rule and expects exactly this rule to fire. The same
// configuration as `pnpm check:arch` is loaded, from .dependency-cruiser.mjs
// (ADR 0022).

const options = await extractDepcruiseOptions(
  join(workspaceRoot, '.dependency-cruiser.mjs'),
);
const rules: readonly IForbiddenRuleType[] = options.ruleSet?.forbidden ?? [];
const boundaries = loadBoundaries();
const nameOf = (dir: string): string => {
  const pkg = boundaries.packages.find((entry) => entry.dir === dir);
  if (pkg === undefined) throw new Error(`unknown package ${dir}`);
  return pkg.name;
};

const temporaryFolders: string[] = [];
afterAll(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

const folders = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

/**
 * Links the npm packages of a node_modules folder of the workspace into the
 * copy, each to its real location. Workspace packages are left out, because
 * the copy links its own.
 */
function linkNpmPackages(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.') || entry === '@ecclium') continue;
    symlinkSync(realpathSync(join(from, entry)), join(to, entry));
  }
}

/**
 * Copies package.json and src/ of every package into a new temporary folder
 * and adds the given files. The npm packages of the root and of each package
 * are linked to their real location, and every folder under packages/ of the
 * copy is linked by its package name, as pnpm does in the workspace. The
 * folder name is resolved first: on macOS the temporary folder lies behind a
 * symbolic link, and paths through it would match none of the rules.
 */
function copyWorkspace(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-arch-')));
  temporaryFolders.push(root);
  for (const dir of folders(join(workspaceRoot, 'packages'))) {
    for (const part of ['package.json', 'src']) {
      cpSync(
        join(workspaceRoot, 'packages', dir, part),
        join(root, 'packages', dir, part),
        { recursive: true },
      );
    }
    linkNpmPackages(
      join(workspaceRoot, 'packages', dir, 'node_modules'),
      join(root, 'packages', dir, 'node_modules'),
    );
  }
  const modules = join(root, 'node_modules');
  linkNpmPackages(join(workspaceRoot, 'node_modules'), modules);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const dir of folders(join(root, 'packages'))) {
    const { name } = JSON.parse(
      readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'),
    ) as { name: string };
    const link = join(modules, name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), join(root, 'packages', dir)), link);
  }
  return root;
}

async function cruiseFolder(baseDir: string): Promise<ICruiseResult> {
  const { output } = await cruise(
    ['packages'],
    { ...options, baseDir },
    { bustTheCache: true },
  );
  if (typeof output === 'string') throw new Error('expected a cruise result');
  return output;
}

const firedRules = (result: ICruiseResult): string[] =>
  [...new Set(result.summary.violations.map((v) => v.rule.name))].sort();

interface Case {
  readonly rule: string;
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}

// One case per import-table rule, generated from boundaries.json: the
// package imports the first package it may not import.
const tableCases: readonly Case[] = boundaries.packages.flatMap((pkg) => {
  const allowed = new Set([pkg.dir, boundaries.testOnly, ...pkg.imports]);
  const forbidden = boundaries.packages.find(
    (other) => !allowed.has(other.dir),
  );
  return forbidden === undefined
    ? []
    : [
        {
          rule: `imports-of-${pkg.dir}`,
          name: `${pkg.dir} imports ${forbidden.dir}`,
          files: {
            [`packages/${pkg.dir}/src/forbidden.ts`]: `import '${forbidden.name}';\nexport {};\n`,
          },
        },
      ];
});

const coreManifest = JSON.parse(
  readFileSync(join(workspaceRoot, 'packages/core/package.json'), 'utf8'),
) as {
  exports: Record<string, Record<string, string>>;
  devDependencies?: Record<string, string>;
};

const cases: readonly Case[] = [
  ...tableCases,
  {
    rule: 'imports-of-core',
    name: 'core imports tools for types only',
    files: {
      'packages/core/src/forbidden.ts': `import type * as Tools from '${nameOf('tools')}';\nexport type ToolsModule = typeof Tools;\n`,
    },
  },
  {
    rule: 'imports-of-core',
    name: 'core imports tools at run time with import()',
    files: {
      'packages/core/src/forbidden.ts': `export const load = async (): Promise<unknown> => import('${nameOf('tools')}');\n`,
    },
  },
  {
    rule: 'no-cycles',
    name: 'two modules of core import each other',
    files: {
      'packages/core/src/cycle-a.ts': "import './cycle-b.js';\nexport {};\n",
      'packages/core/src/cycle-b.ts': "import './cycle-a.js';\nexport {};\n",
    },
  },
  {
    rule: 'no-unknown-package',
    name: 'cli imports a package that boundaries.json does not list',
    files: {
      'packages/extra/package.json': `${JSON.stringify({
        name: '@ecclium/mcp-churchtools-extra',
        type: 'module',
        exports: { '.': { '@ecclium/source': './src/index.ts' } },
      })}\n`,
      'packages/extra/src/index.ts': 'export {};\n',
      'packages/cli/src/forbidden.ts': `import '@ecclium/mcp-churchtools-extra';\nexport {};\n`,
    },
  },
  {
    rule: 'testkit-dev-only',
    name: 'code of core that is not a test imports the testkit',
    files: {
      'packages/core/src/forbidden.ts': `import '${nameOf('testkit')}';\nexport {};\n`,
    },
  },
  {
    rule: 'testkit-dev-only',
    name: 'core reaches the testkit through a file named like a test that ships',
    files: {
      'packages/core/src/forbidden.ts':
        "import './helper.test.mjs';\nexport {};\n",
      'packages/core/src/helper.test.mts': `import '${nameOf('testkit')}';\nexport {};\n`,
    },
  },
  {
    rule: 'not-to-unresolvable',
    name: 'core imports a package that is not installed',
    files: {
      'packages/core/src/forbidden.ts':
        "import 'ecclium-example-not-installed';\nexport {};\n",
    },
  },
  {
    rule: 'no-undeclared-npm',
    name: 'tools imports an installed npm package it does not declare',
    files: {
      'node_modules/ecclium-example-undeclared/package.json':
        '{ "name": "ecclium-example-undeclared", "version": "1.0.0", "main": "index.js" }\n',
      'node_modules/ecclium-example-undeclared/index.js':
        'module.exports = {};\n',
      'packages/tools/src/forbidden.ts':
        "import 'ecclium-example-undeclared';\nexport {};\n",
    },
  },
  {
    rule: 'no-undeclared-npm',
    name: 'core imports an npm package it declares only for development',
    files: {
      'node_modules/ecclium-example-dev/package.json':
        '{ "name": "ecclium-example-dev", "version": "1.0.0", "main": "index.js" }\n',
      'node_modules/ecclium-example-dev/index.js': 'module.exports = {};\n',
      'packages/core/package.json': `${JSON.stringify({
        ...coreManifest,
        devDependencies: {
          ...coreManifest.devDependencies,
          'ecclium-example-dev': '1.0.0',
        },
      })}\n`,
      'packages/core/src/forbidden.ts':
        "import 'ecclium-example-dev';\nexport {};\n",
    },
  },
  {
    rule: 'no-import-outside-packages',
    name: 'core imports a file of the repository outside packages/',
    files: {
      'tests/example.json': '{ "value": 1 }\n',
      'packages/core/src/forbidden.ts':
        "import data from '../../../tests/example.json' with { type: 'json' };\nexport const value = data;\n",
    },
  },
  {
    rule: 'no-relative-cross-package',
    name: 'tools imports core through a relative path',
    files: {
      'packages/tools/src/forbidden.ts':
        "import '../../core/src/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'no-deep-package-imports',
    name: 'tools imports a file of core that core exports only by accident',
    files: {
      // A wildcard export makes the file resolvable at all, so only this
      // rule stops it.
      'packages/core/package.json': `${JSON.stringify({
        ...coreManifest,
        exports: {
          ...coreManifest.exports,
          './*': { '@ecclium/source': './src/*.ts' },
        },
      })}\n`,
      'packages/core/src/internal.ts': 'export {};\n',
      'packages/tools/src/forbidden.ts': `import '${nameOf('core')}/internal';\nexport {};\n`,
    },
  },
  {
    rule: 'raw-client-only-in-core',
    name: 'a core module that is not listed imports the raw client',
    files: {
      'packages/core/src/forbidden.ts':
        "import './churchtools/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'mcp-mount-only-in-server',
    name: 'tools imports the mount',
    files: {
      'packages/tools/src/forbidden.ts': `import '${nameOf('core')}/mcp';\nexport {};\n`,
    },
  },
  {
    rule: 'no-stdout-in-stdio-paths',
    name: 'the stdio start of the command line imports its output module',
    files: {
      'packages/cli/src/stdio/forbidden.ts':
        "import '../output/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'no-stdout-in-stdio-paths',
    name: 'the stdio start of the command line reaches its output module through another module',
    files: {
      'packages/cli/src/stdio/forbidden.ts':
        "import '../helper.js';\nexport {};\n",
      'packages/cli/src/helper.ts': "import './output/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'the example plugin imports core',
    files: {
      'packages/testkit/src/plugins/example/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
];

// Imports the rules must let pass.
const allowedCases: readonly Omit<Case, 'rule'>[] = [
  {
    name: 'a test of core imports the testkit',
    files: {
      'packages/core/src/allowed.test.ts': `import '${nameOf('testkit')}';\nexport {};\n`,
    },
  },
  {
    name: 'a test of the stdio start imports the output module',
    files: {
      'packages/cli/src/stdio/allowed.test.ts':
        "import '../output/index.js';\nexport {};\n",
    },
  },
  {
    name: 'the server imports the mount',
    files: {
      'packages/server/src/allowed.ts': `import '${nameOf('core')}/mcp';\nexport {};\n`,
    },
  },
  {
    name: 'the example plugin imports the plugin API',
    files: {
      'packages/testkit/src/plugins/example/allowed.ts': `import '${nameOf('plugin-api')}';\nexport {};\n`,
    },
  },
  {
    name: 'a module inside the client folder imports the client',
    files: {
      'packages/core/src/churchtools/allowed.ts':
        "import './index.js';\nexport {};\n",
    },
  },
];

describe('dependency-cruiser rules', () => {
  it('pass the packages as they are', async () => {
    const result = await cruiseFolder(workspaceRoot);
    expect(result.summary.violations).toEqual([]);
  });

  it('pass an unchanged copy of the packages', async () => {
    const result = await cruiseFolder(copyWorkspace({}));
    expect(result.summary.violations).toEqual([]);
  });

  it.each(cases)('$rule: refuses that $name', async ({ rule, files }) => {
    const result = await cruiseFolder(copyWorkspace(files));
    expect(firedRules(result)).toEqual([rule]);
  });

  it.each(allowedCases)('allow that $name', async ({ files }) => {
    const result = await cruiseFolder(copyWorkspace(files));
    expect(result.summary.violations).toEqual([]);
  });

  it('have a failing example for every rule', () => {
    const proven = new Set(cases.map((c) => c.rule));
    expect(rules.map((rule) => rule.name).sort()).toEqual([...proven].sort());
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
    expect(empty).toEqual([]);
  });
});
