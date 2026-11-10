import {
  cpSync,
  existsSync,
  lstatSync,
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
import { basename, dirname, join, relative, sep } from 'node:path';

import {
  cruise,
  type ICruiseResult,
  type IForbiddenRuleType,
} from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import { afterAll, describe, expect, it } from 'vitest';

import { loadBoundaries, workspaceRoot } from './boundaries.mts';

// Each dependency-cruiser rule is proven by a forbidden example: a case
// copies the packages into a temporary folder, adds one file that breaks
// exactly this rule and expects exactly this rule to fire. The same
// configuration as `pnpm check:arch` is loaded, from .dependency-cruiser.mjs
// (ADR 0022).
//
// Every case copies the sources of every package and cruises the whole copy.
// Vitest runs test files side by side but the tests of one file one after the
// other, and in a single file the cases kept a runner of CI busy for minutes
// after every other test file was done. So the cases run in six test files,
// dependency-rules-1.test.mts to dependency-rules-6.test.mts, each with every
// sixth case. Each case is unchanged: a full copy and a full cruise. The
// checks that need no case stay in dependency-rules.test.mts.

export const options = await extractDepcruiseOptions(
  join(workspaceRoot, '.dependency-cruiser.mjs'),
);
export const rules: readonly IForbiddenRuleType[] =
  options.ruleSet?.forbidden ?? [];
const boundaries = loadBoundaries();
const nameOf = (dir: string): string => {
  const pkg = boundaries.packages.find((entry) => entry.dir === dir);
  if (pkg === undefined) throw new Error(`unknown package ${dir}`);
  return pkg.name;
};

/**
 * Returns a list of temporary folders that a hook removes after all tests of
 * the test file that calls this function. Each test file calls it once, so
 * the list and the hook belong to that file, also where test files share
 * their modules.
 */
export function temporaryFoldersOfFile(): string[] {
  const temporaryFolders: string[] = [];
  afterAll(() => {
    for (const folder of temporaryFolders) {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  return temporaryFolders;
}

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
 * Refuses a file of a case that would land outside the copy. The npm packages
 * of the copy are links to their real location, so a case that writes into
 * one of them would change the real package.
 *
 * @param root - The resolved folder of the copy.
 * @param path - The path of the file from the root of the copy.
 * @throws {Error} When the file or its nearest existing folder resolves to a
 *   location outside the copy, or the file is a link.
 */
export function assertInsideCopy(root: string, path: string): void {
  let folder = dirname(join(root, path));
  while (!existsSync(folder)) folder = dirname(folder);
  const real = realpathSync(folder);
  const linked =
    lstatSync(join(root, path), { throwIfNoEntry: false })?.isSymbolicLink() ??
    false;
  if ((real !== root && !real.startsWith(`${root}${sep}`)) || linked) {
    throw new Error(`${path} would be written outside the copy`);
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
function copyWorkspace(
  files: Readonly<Record<string, string>>,
  temporaryFolders: string[],
): string {
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
    assertInsideCopy(root, path);
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

/**
 * Cruises a copy with the given files and removes the copy as soon as the
 * cruise is done, so that at most one copy of a test file lies on disk. Kept
 * until the end, the copies of all cases came to about 150 folders with some
 * 70'000 files, and removing them in the one hook after all tests took longer
 * than its limit of ten seconds on a loaded runner of CI. A copy that fails
 * halfway stays in the list of temporary folders for that hook.
 *
 * @param files - The files to add to the copy, by their path in the copy.
 * @param temporaryFolders - The list of the calling test file, from
 *   temporaryFoldersOfFile.
 * @returns The result of the cruise.
 */
export async function cruiseCopy(
  files: Readonly<Record<string, string>>,
  temporaryFolders: string[],
): Promise<ICruiseResult> {
  const root = copyWorkspace(files, temporaryFolders);
  try {
    return await cruiseFolder(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Cruises the packages of a folder with the configuration of the workspace.
 *
 * @param baseDir - The workspace or a copy of it.
 * @returns The result of the cruise.
 */
export async function cruiseFolder(baseDir: string): Promise<ICruiseResult> {
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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const pluginApiManifest = JSON.parse(
  readFileSync(join(workspaceRoot, 'packages/plugin-api/package.json'), 'utf8'),
) as Record<string, unknown> & {
  devDependencies?: Record<string, string>;
};

/** An installed npm package that no manifest of the workspace names. */
const examplePackage = (name: string): Record<string, string> => ({
  [`node_modules/${name}/package.json`]: `${JSON.stringify({ name, version: '1.0.0', main: 'index.js' })}\n`,
  [`node_modules/${name}/index.js`]: 'module.exports = {};\n',
});

export const cases: readonly Case[] = [
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
    // Only the plugin API may rely on a peer dependency.
    rule: 'no-undeclared-npm',
    name: 'core imports an npm package it declares as peer and for development',
    files: {
      ...examplePackage('ecclium-example-peer'),
      'packages/core/package.json': `${JSON.stringify({
        ...coreManifest,
        devDependencies: {
          ...coreManifest.devDependencies,
          'ecclium-example-peer': '1.0.0',
        },
        peerDependencies: { 'ecclium-example-peer': '^1.0.0' },
      })}\n`,
      'packages/core/src/forbidden.ts':
        "import 'ecclium-example-peer';\nexport {};\n",
    },
  },
  {
    rule: 'plugin-api-peers-only',
    name: 'the plugin API imports an npm package it declares only for development',
    files: {
      ...examplePackage('ecclium-example-dev'),
      'packages/plugin-api/package.json': `${JSON.stringify({
        ...pluginApiManifest,
        devDependencies: {
          ...pluginApiManifest.devDependencies,
          'ecclium-example-dev': '1.0.0',
        },
      })}\n`,
      'packages/plugin-api/src/forbidden.ts':
        "import 'ecclium-example-dev';\nexport {};\n",
    },
  },
  {
    rule: 'plugin-api-peers-only',
    name: 'the plugin API imports an npm package it declares for run time',
    files: {
      ...examplePackage('ecclium-example-runtime'),
      'packages/plugin-api/package.json': `${JSON.stringify({
        ...pluginApiManifest,
        dependencies: { 'ecclium-example-runtime': '1.0.0' },
      })}\n`,
      'packages/plugin-api/src/forbidden.ts':
        "import 'ecclium-example-runtime';\nexport {};\n",
    },
  },
  {
    rule: 'plugin-api-peers-only',
    name: 'the plugin API imports an npm package it declares as optional',
    files: {
      ...examplePackage('ecclium-example-optional'),
      'packages/plugin-api/package.json': `${JSON.stringify({
        ...pluginApiManifest,
        optionalDependencies: { 'ecclium-example-optional': '1.0.0' },
      })}\n`,
      'packages/plugin-api/src/forbidden.ts':
        "import 'ecclium-example-optional';\nexport {};\n",
    },
  },
  {
    rule: 'plugin-api-peers-only',
    name: 'the plugin API imports a built-in module of Node.js',
    files: {
      'packages/plugin-api/src/forbidden.ts': "import 'node:fs';\nexport {};\n",
    },
  },
  {
    rule: 'plugin-api-peers-only',
    name: 'the plugin API imports an installed npm package it does not declare',
    files: {
      ...examplePackage('ecclium-example-undeclared'),
      'packages/plugin-api/src/forbidden.ts':
        "import 'ecclium-example-undeclared';\nexport {};\n",
    },
  },
  ...(
    [
      [
        'a module of core',
        'packages/core/src/forbidden.ts',
        "import { revealSecret } from './http/secret.js';\nexport const read = revealSecret;\n",
      ],
      [
        'a module of core for types only',
        'packages/core/src/forbidden.ts',
        "import type { revealSecret } from './http/secret.js';\nexport type Read = typeof revealSecret;\n",
      ],
      [
        'a module of core at run time with import()',
        'packages/core/src/forbidden.ts',
        "export const load = async (): Promise<unknown> => import('./http/secret.js');\n",
      ],
      [
        'a test of core outside the folder',
        'packages/core/src/forbidden.test.ts',
        "import './http/secret.js';\nexport {};\n",
      ],
      [
        'a folder next to the outbound path',
        'packages/core/src/httpx/forbidden.ts',
        "import '../http/secret.js';\nexport {};\n",
      ],
    ] as const
  ).map(([who, path, source]) => ({
    rule: 'egress-internals',
    name: `${who} imports a module of the outbound path other than its entry point`,
    files: { [path]: source },
  })),
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
  ...[
    'http',
    'https',
    'http2',
    'net',
    'tls',
    'dgram',
    'dns',
    'dns/promises',
    'inspector',
    'inspector/promises',
  ].map((name) => ({
    rule: 'network-only-in-egress',
    name: `tools imports node:${name}`,
    files: {
      'packages/tools/src/forbidden.ts': `import 'node:${name}';\nexport {};\n`,
    },
  })),
  {
    rule: 'network-only-in-egress',
    name: 'a folder next to the outbound path imports node:https',
    files: {
      'packages/core/src/httpx/forbidden.ts':
        "import 'node:https';\nexport {};\n",
    },
  },
  {
    rule: 'network-only-in-egress',
    name: 'core outside the outbound path imports net for types only',
    files: {
      'packages/core/src/forbidden.ts':
        "import type { Socket } from 'net';\nexport type Connection = Socket;\n",
    },
  },
  {
    rule: 'network-only-in-egress',
    name: 'core outside the outbound path imports dns/promises with import()',
    files: {
      'packages/core/src/forbidden.ts':
        "export const load = async (): Promise<unknown> => import('node:dns/promises');\n",
    },
  },
  {
    rule: 'network-only-in-egress',
    name: 'core outside the outbound path imports undici, which it declares',
    files: {
      'node_modules/undici/package.json':
        '{ "name": "undici", "version": "1.0.0", "main": "index.js" }\n',
      'node_modules/undici/index.js': 'module.exports = {};\n',
      'packages/core/package.json': `${JSON.stringify({
        ...coreManifest,
        dependencies: { ...coreManifest.dependencies, undici: '1.0.0' },
      })}\n`,
      'packages/core/src/forbidden.ts': "import 'undici';\nexport {};\n",
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
    rule: 'operation-catalog-only-in-client',
    name: 'a listed importer of the raw client imports the operation catalog',
    files: {
      'packages/core/src/pipeline/read-api.ts':
        "import '../churchtools/catalog/catalog.js';\nexport {};\n",
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
    rule: 'no-stdout-from-stdio-modules',
    name: 'the start notices import the output module',
    files: {
      'packages/cli/src/notices/forbidden.ts':
        "import '../output/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'no-stdout-from-stdio-modules',
    name: 'the catalog of texts reaches the output module through another module',
    files: {
      'packages/cli/src/messages/forbidden.ts':
        "import '../helper.js';\nexport {};\n",
      'packages/cli/src/helper.ts': "import './output/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'no-stdout-in-stdio-paths',
    name: 'the start of the elicitation spike reaches the output module of the command line',
    files: {
      'packages/testkit/src/mcp-spike/stdio.ts': `import '${nameOf('cli')}';\nexport {};\n`,
      'packages/cli/src/index.ts': "import './output/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'no-util-module',
    name: 'core imports node:util',
    files: {
      'packages/core/src/forbidden.ts':
        "import { types } from 'node:util';\nexport const checks = types;\n",
    },
  },
  {
    rule: 'no-process-module',
    name: 'tools imports process',
    files: {
      'packages/tools/src/forbidden.ts':
        "import { platform } from 'process';\nexport const name = platform;\n",
    },
  },
  {
    rule: 'transport-only-from-composition-root',
    name: 'tools builds a transport through the subpath of core',
    files: {
      'packages/tools/src/forbidden.ts': `import { createHttpTransport } from '${nameOf('core')}/http';\nexport const build = createHttpTransport;\n`,
    },
  },
  {
    rule: 'transport-only-from-composition-root',
    name: 'a module of core next to the outbound path builds a transport',
    files: {
      'packages/core/src/churchtools/forbidden.ts':
        "import { createHttpTransport } from '../http/compose.js';\nexport const build = createHttpTransport;\n",
    },
  },
  {
    rule: 'transport-only-from-composition-root',
    name: 'a test of the command line outside the composition root builds a transport',
    files: {
      'packages/cli/src/forbidden.test.ts': `import { createHttpTransport } from '${nameOf('core')}/http';\nexport const build = createHttpTransport;\n`,
    },
  },
  {
    rule: 'composition-only-from-composition-root',
    name: 'tools builds the stderr writer through the subpath of core',
    files: {
      'packages/tools/src/forbidden.ts': `import { createStderrWriter } from '${nameOf('core')}/composition';\nexport const build = createStderrWriter;\n`,
    },
  },
  {
    rule: 'composition-only-from-composition-root',
    name: 'the server builds the logger through the subpath of core',
    files: {
      'packages/server/src/forbidden.ts': `import { createLogger } from '${nameOf('core')}/composition';\nexport const build = createLogger;\n`,
    },
  },
  {
    rule: 'composition-only-from-composition-root',
    name: 'a test of core imports the subpath by a relative path',
    files: {
      'packages/core/src/forbidden.test.ts':
        "import { createStderrWriter } from './composition.js';\nexport const build = createStderrWriter;\n",
    },
  },
  {
    rule: 'composition-only-from-composition-root',
    name: 'a test of the command line outside the composition root imports the subpath',
    files: {
      'packages/cli/src/forbidden.test.ts': `import { createAuditSink } from '${nameOf('core')}/composition';\nexport const build = createAuditSink;\n`,
    },
  },
  {
    rule: 'audit-files-only-in-audit-commands',
    name: 'tools reads the audit files through the subpath of core',
    files: {
      'packages/tools/src/forbidden.ts': `import { openAuditFolder } from '${nameOf('core')}/audit';\nexport const read = openAuditFolder;\n`,
    },
  },
  {
    rule: 'audit-files-only-in-audit-commands',
    name: 'the start over stdio reads the audit files',
    files: {
      'packages/cli/src/stdio/forbidden.ts': `import { verifyAuditFiles } from '${nameOf('core')}/audit';\nexport const check = verifyAuditFiles;\n`,
    },
  },
  {
    rule: 'audit-files-only-in-audit-commands',
    name: 'a module of core imports the subpath by a relative path',
    files: {
      'packages/core/src/pipeline/forbidden.ts':
        "import { openAuditFolder } from '../audit-commands.js';\nexport const read = openAuditFolder;\n",
    },
  },
  {
    rule: 'aes-gcm-siv-only-in-pseudonyms',
    name: 'a module of the redaction next to the pseudonyms builds the cipher',
    files: {
      'packages/core/src/redaction/forbidden.ts':
        "import { gcmsiv } from '@noble/ciphers/aes.js';\nexport const cipher = gcmsiv;\n",
    },
  },
  {
    rule: 'aes-gcm-siv-only-in-pseudonyms',
    name: 'a test of core builds the cipher past the module',
    files: {
      'packages/core/src/redaction/forbidden.test.ts':
        "import { gcmsiv } from '@noble/ciphers/aes.js';\nexport const cipher = gcmsiv;\n",
    },
  },
  {
    rule: 'aes-gcm-siv-only-in-pseudonyms',
    name: 'a module of core imports another cipher of the library for types only',
    files: {
      'packages/core/src/keys/forbidden.ts':
        "import type { Cipher } from '@noble/ciphers/utils.js';\nexport type Seal = Cipher;\n",
    },
  },
  {
    rule: 'yaml-only-in-config-reader',
    name: 'a module of the policy parses YAML past the reader',
    files: {
      'packages/core/src/policy/forbidden.ts':
        "import { parse } from 'yaml';\nexport const read = parse;\n",
    },
  },
  {
    rule: 'yaml-only-in-config-reader',
    name: 'a test of core parses YAML past the reader',
    files: {
      'packages/core/src/config/forbidden.test.ts':
        "import { parseDocument } from 'yaml';\nexport const read = parseDocument;\n",
    },
  },
  {
    rule: 'yaml-only-in-config-reader',
    name: 'the loader of the configuration imports a type of the library',
    files: {
      'packages/core/src/config/forbidden.ts':
        "import type { Document } from 'yaml';\nexport type Policy = Document;\n",
    },
  },
  {
    rule: 'markdown-it-only-in-differential-test',
    name: 'a test of the write guard reads Markdown with the second parser',
    files: {
      'packages/core/src/write/forbidden.test.ts':
        "import MarkdownIt from 'markdown-it';\nexport const parser = new MarkdownIt();\n",
    },
  },
  {
    rule: 'markdown-it-only-in-differential-test',
    name: 'another test of the content policy uses the second parser',
    files: {
      'packages/core/src/content/forbidden.test.ts':
        "import MarkdownIt from 'markdown-it';\nexport const parser = new MarkdownIt();\n",
    },
  },
  {
    rule: 'marked-only-in-content-lexer',
    name: 'the serializer of the content policy renders with the library',
    files: {
      'packages/core/src/content/forbidden.ts':
        "import { marked } from 'marked';\nexport const render = marked;\n",
    },
  },
  {
    rule: 'marked-only-in-content-lexer',
    name: 'a test of the write guard lexes Markdown past the content policy',
    files: {
      'packages/core/src/write/forbidden.test.ts':
        "import { Lexer } from 'marked';\nexport const lex = Lexer.lex;\n",
    },
  },
  {
    rule: 'marked-only-in-content-lexer',
    name: 'the write guard imports a type of the library',
    files: {
      'packages/core/src/write/forbidden.ts':
        "import type { Token } from 'marked';\nexport type Part = Token;\n",
    },
  },
  {
    rule: 'keys-internals',
    name: 'the configuration reads the bytes of a key',
    files: {
      'packages/core/src/config/forbidden.ts':
        "import { revealKeyMaterial } from '../keys/key-material.js';\nexport const read = revealKeyMaterial;\n",
    },
  },
  {
    rule: 'keys-internals',
    name: 'a test of the redaction reads the bytes of a key',
    files: {
      'packages/core/src/redaction/forbidden.test.ts':
        "import { revealKeyMaterial } from '../keys/key-material.js';\nexport const read = revealKeyMaterial;\n",
    },
  },
  {
    rule: 'key-provider-only-from-composition-root',
    name: 'the pipeline builds the provider of keys',
    files: {
      'packages/core/src/pipeline/forbidden.ts':
        "import { createFileKeyProvider } from '../keys/file-provider.js';\nexport const build = createFileKeyProvider;\n",
    },
  },
  {
    rule: 'key-provider-only-from-composition-root',
    name: 'the pipeline builds the day keys',
    files: {
      'packages/core/src/pipeline/forbidden.ts':
        "import { createFileDayKeys } from '../keys/day-keys.js';\nexport const build = createFileDayKeys;\n",
    },
  },
  {
    rule: 'pseudonyms-only-in-pipeline',
    name: 'the audit seals a pseudonym',
    files: {
      'packages/core/src/audit/forbidden.ts':
        "import { sealGcmSiv } from '../redaction/pseudonym.js';\nexport const seal = sealGcmSiv;\n",
    },
  },
  {
    rule: 'pseudonyms-only-in-pipeline',
    name: 'another module of the redaction opens the pseudonyms',
    files: {
      'packages/core/src/redaction/forbidden.ts':
        "import { openPseudonyms } from './pseudonym.js';\nexport const open = openPseudonyms;\n",
    },
  },
  {
    rule: 'redacted-mark-only-in-pipeline',
    name: 'a tool marks its own result as redacted',
    files: {
      'packages/tools/src/forbidden.ts': `import { sealRedacted } from '${nameOf('core')}/redaction/testing';\nexport const seal = sealRedacted;\n`,
    },
  },
  {
    rule: 'redacted-mark-only-in-pipeline',
    name: 'the mount outside its serialisation marks a result',
    files: {
      'packages/core/src/mcp/forbidden.ts':
        "import { sealRedacted } from '../redaction/redacted.js';\nexport const seal = sealRedacted;\n",
    },
  },
  {
    rule: 'redacted-mark-only-in-pipeline',
    name: 'testkit outside its stand-in outcomes marks a result',
    files: {
      'packages/testkit/src/forbidden.ts': `import { sealRedacted } from '${nameOf('core')}/redaction/testing';\nexport const seal = sealRedacted;\n`,
    },
  },
  {
    rule: 'write-guard-only-from-pipeline',
    name: 'the mount reaches the write guard',
    files: {
      'packages/core/src/mcp/forbidden.ts':
        "import { checkKillSwitches } from '../write/kill-switch.js';\nexport const check = checkKillSwitches;\n",
    },
  },
  {
    rule: 'write-guard-only-from-pipeline',
    name: 'the read access of the pipeline reaches the write guard',
    files: {
      'packages/core/src/pipeline/forbidden.ts':
        "import { rulesOf } from '../write/rules.js';\nexport const rules = rulesOf;\n",
    },
  },
  {
    rule: 'write-guard-seals-internal',
    name: 'the pipeline issues a proof itself',
    files: {
      'packages/core/src/pipeline/pipeline.ts':
        "import { issueProof } from '../write/proof.js';\nexport const issue = issueProof;\n",
    },
  },
  {
    rule: 'write-guard-only-from-pipeline',
    name: 'the composition root reaches past the stores into the write guard',
    files: {
      'packages/core/src/composition.ts':
        "export { checkKillSwitches } from './write/kill-switch.js';\n",
    },
  },
  {
    rule: 'write-guard-stores-from-composition-root',
    name: 'the pipeline builds the store of plans itself',
    files: {
      'packages/core/src/pipeline/pipeline.ts':
        "import { createMemoryPlanStore } from '../write/plan-store.js';\nexport const build = createMemoryPlanStore;\n",
    },
  },
  {
    rule: 'write-guard-stores-from-composition-root',
    name: 'the mount builds the store of nonces',
    files: {
      'packages/core/src/mcp/forbidden.ts':
        "import { createMemoryNonceStore } from '../write/nonce-store.js';\nexport const build = createMemoryNonceStore;\n",
    },
  },
  {
    rule: 'mocked-transport-only-in-testkit',
    name: 'tools builds the transport on a MockAgent',
    files: {
      'packages/tools/src/forbidden.ts': `import { createMockedHttpTransport } from '${nameOf('core')}/http/testing';\nexport const build = createMockedHttpTransport;\n`,
    },
  },
  {
    rule: 'mocked-transport-only-in-testkit',
    name: 'testkit outside its double builds the transport on a MockAgent',
    files: {
      'packages/testkit/src/forbidden.ts': `import { createMockedHttpTransport } from '${nameOf('core')}/http/testing';\nexport const build = createMockedHttpTransport;\n`,
    },
  },
  {
    rule: 'egress-internals',
    name: 'a module of core imports the build path of the transport',
    files: {
      'packages/core/src/churchtools/forbidden.ts':
        "import { createTransport } from '../http/transport.js';\nexport const build = createTransport;\n",
    },
  },
  {
    rule: 'no-diagnostics-channel',
    name: 'tools subscribes to a diagnostics channel',
    files: {
      'packages/tools/src/forbidden.ts':
        "import { subscribe } from 'node:diagnostics_channel';\nexport const listen = subscribe;\n",
    },
  },
  {
    rule: 'no-diagnostics-channel',
    name: 'the outbound path imports diagnostics_channel as well',
    files: {
      'packages/core/src/http/forbidden.ts':
        "import diagnostics from 'diagnostics_channel';\nexport const channels = diagnostics;\n",
    },
  },
  {
    rule: 'no-diagnostics-channel',
    name: 'a test of a package imports its types',
    files: {
      'packages/core/src/forbidden.test.ts':
        "import type { Channel } from 'node:diagnostics_channel';\nexport type Seen = Channel;\n",
    },
  },
  {
    rule: 'no-util-module',
    name: 'the start notices import sys with import()',
    files: {
      'packages/cli/src/notices/forbidden.ts':
        "export const load = async (): Promise<unknown> => import('node:sys');\n",
    },
  },
  {
    rule: 'no-process-module',
    name: 'the command imports node:process as well',
    files: {
      'packages/cli/src/main.ts':
        "import { platform } from 'node:process';\nexport const name = platform;\n",
    },
  },
  {
    rule: 'no-process-module',
    name: 'a test of core imports node:process',
    files: {
      'packages/core/src/forbidden.test.ts':
        "import { platform } from 'node:process';\nexport const name = platform;\n",
    },
  },
  {
    rule: 'no-util-module-in-stdio-paths',
    name: 'the stdio start of the command line imports the command',
    files: {
      // An empty command, so that the rule for stdout does not fire too.
      'packages/cli/src/main.ts': 'export {};\n',
      'packages/cli/src/stdio/forbidden.ts':
        "import '../main.js';\nexport {};\n",
    },
  },
  {
    rule: 'no-util-module-in-stdio-paths',
    name: 'the start notices reach the command through another module',
    files: {
      'packages/cli/src/main.ts': 'export {};\n',
      'packages/cli/src/notices/forbidden.ts':
        "import '../helper.js';\nexport {};\n",
      'packages/cli/src/helper.ts': "import './main.js';\nexport {};\n",
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'the example plugin imports core',
    files: {
      'packages/testkit/src/plugins/example/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the core imports core',
    files: {
      'packages/tools/src/base/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a search tool for persons imports core',
    files: {
      'packages/tools/src/persons/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a search tool for groups imports core',
    files: {
      'packages/tools/src/groups/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the wiki imports core',
    files: {
      'packages/tools/src/wiki/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the events imports core',
    files: {
      'packages/tools/src/events/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the services imports core',
    files: {
      'packages/tools/src/services/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the calendars imports core',
    files: {
      'packages/tools/src/calendars/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the appointments imports core',
    files: {
      'packages/tools/src/appointments/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the resources imports core',
    files: {
      'packages/tools/src/resources/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the bookings imports core',
    files: {
      'packages/tools/src/bookings/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a tool of the songs imports core',
    files: {
      'packages/tools/src/songs/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'the global search imports core',
    files: {
      'packages/tools/src/search/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'a prompt imports core',
    files: {
      'packages/tools/src/prompts/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'the plugin of the core imports core',
    files: {
      'packages/tools/src/core-plugin.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'plugins-only-plugin-api',
    name: 'the plugin of the core imports the docs index itself',
    files: {
      'packages/tools/src/core-plugin.ts': `import '${nameOf('docs-index')}';\nexport {};\n`,
    },
  },
  {
    rule: 'docs-tools-only-plugin-api-and-docs-index',
    name: 'a docs tool imports core',
    files: {
      'packages/tools/src/docs/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'docs-tools-only-plugin-api-and-docs-index',
    name: 'a docs tool imports a tool of the escape hatch',
    files: {
      'packages/tools/src/docs/forbidden.ts':
        "import '../api/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'api-tools-only-plugin-api-docs-index-and-docs-tools',
    name: 'a tool of the escape hatch imports core',
    files: {
      'packages/tools/src/api/forbidden.ts': `import '${nameOf('core')}';\nexport {};\n`,
    },
  },
  {
    rule: 'bin-imports-only-environment',
    name: 'the executable imports the command line statically',
    files: {
      'packages/cli/src/bin.ts':
        "import './environment.js';\nimport './main.js';\nexport {};\n",
    },
  },
  {
    rule: 'bin-imports-only-environment',
    name: 'the executable imports the types of the command line',
    files: {
      'packages/cli/src/bin.ts':
        "import type { RunOptions } from './main.js';\nexport type Options = RunOptions;\n",
    },
  },
  {
    rule: 'bin-imports-only-environment',
    name: 'the executable imports the output module statically',
    files: {
      'packages/cli/src/bin.ts': "import './output/index.js';\nexport {};\n",
    },
  },
  {
    rule: 'bin-loads-only-main-or-stdio',
    name: 'the executable loads the output module with import()',
    files: {
      'packages/cli/src/bin.ts':
        "export const load = async (): Promise<unknown> => import('./output/index.js');\n",
    },
  },
  {
    rule: 'bin-loads-only-main-or-stdio',
    name: 'the executable loads the second stage of the stdio start with import()',
    files: {
      'packages/cli/src/bin.ts':
        "export const load = async (): Promise<unknown> => import('./stdio/serve.js');\n",
    },
  },
  {
    rule: 'docs-files-only-in-place',
    name: 'the search of the docs index reads a file',
    files: {
      'packages/docs-index/src/search/forbidden.ts':
        "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n",
    },
  },
  {
    rule: 'docs-files-only-in-place',
    name: 'a module of the docs index writes through fs/promises',
    files: {
      'packages/docs-index/src/forbidden.ts':
        "import { writeFile } from 'fs/promises';\nexport const write = writeFile;\n",
    },
  },
  {
    rule: 'croner-only-in-schedule',
    name: 'another module of the schedule reckons triggers past the reader',
    files: {
      'packages/core/src/schedule/forbidden.ts':
        "import { Cron } from 'croner';\nexport const read = Cron;\n",
    },
  },
  {
    rule: 'croner-only-in-schedule',
    name: 'a test of the schedule runs a job with croner',
    files: {
      'packages/core/src/schedule/forbidden.test.ts':
        "import { Cron } from 'croner';\nexport const job = new Cron('0 6 * * MON', () => undefined);\n",
    },
  },
  {
    rule: 'croner-only-in-schedule',
    name: 'a module of core imports a type of the library',
    files: {
      'packages/core/src/quota/forbidden.ts':
        "import type { CronOptions } from 'croner';\nexport type Options = CronOptions;\n",
    },
  },
];

// Imports the rules must let pass.
export const allowedCases: readonly Omit<Case, 'rule'>[] = [
  {
    name: 'the composition root builds the store of plans',
    files: {
      'packages/core/src/composition.ts':
        "export { createMemoryPlanStore } from './write/plan-store.js';\n",
    },
  },
  {
    name: 'a module of the write guard reads a sealed plan',
    files: {
      'packages/core/src/write/allowed.ts':
        "import { readPlan } from './sealed-plan.js';\nexport const read = readPlan;\n",
    },
  },
  {
    name: 'a test of the pipeline issues a proof',
    files: {
      'packages/core/src/pipeline/allowed.test.ts':
        "import { issueProof } from '../write/proof.js';\nexport const issue = issueProof;\n",
    },
  },
  {
    name: 'the pipeline opens the pseudonyms',
    files: {
      'packages/core/src/pipeline/allowed.ts':
        "import { openPseudonyms } from '../redaction/pseudonym.js';\nexport const open = openPseudonyms;\n",
    },
  },
  {
    name: 'a test of the redaction builds the provider of keys',
    files: {
      'packages/core/src/redaction/allowed.test.ts':
        "import { createFileKeyProvider } from '../keys/file-provider.js';\nexport const build = createFileKeyProvider;\n",
    },
  },
  {
    name: 'a module of the raw client imports the operation catalog',
    files: {
      'packages/core/src/churchtools/allowed.ts':
        "import './catalog/catalog.js';\nexport {};\n",
    },
  },
  {
    name: 'a test of core imports the testkit',
    files: {
      'packages/core/src/allowed.test.ts': `import '${nameOf('testkit')}';\nexport {};\n`,
    },
  },
  {
    name: 'core imports node:util/types',
    files: {
      'packages/core/src/allowed.ts':
        "import { isProxy } from 'node:util/types';\nexport const check = isProxy;\n",
    },
  },
  {
    name: 'a test of core imports node:util',
    files: {
      'packages/core/src/allowed.test.ts':
        "import { inspect } from 'node:util';\nexport const show = inspect;\n",
    },
  },
  {
    name: 'the output module imports the catalog of texts',
    files: {
      'packages/cli/src/output/allowed.ts':
        "import '../messages/index.js';\nexport {};\n",
    },
  },
  {
    name: 'a test of the start notices imports the output module',
    files: {
      'packages/cli/src/notices/allowed.test.ts':
        "import '../output/index.js';\nexport {};\n",
    },
  },
  {
    name: 'the stdio start of the command line imports the start notices',
    files: {
      'packages/cli/src/stdio/allowed.ts':
        "import '../notices/index.js';\nexport {};\n",
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
    name: 'the composition root builds a transport through the subpath of core',
    files: {
      'packages/cli/src/stdio/allowed.ts': `import { createHttpTransport } from '${nameOf('core')}/http';\nexport const build = createHttpTransport;\n`,
    },
  },
  {
    name: 'the composition root builds the stderr writer through the subpath of core',
    files: {
      'packages/cli/src/stdio/allowed.ts': `import { createStderrWriter } from '${nameOf('core')}/composition';\nexport const build = createStderrWriter;\n`,
    },
  },
  {
    name: 'a test of the composition root imports the subpath of core',
    files: {
      'packages/cli/src/stdio/allowed.test.ts': `import { createLogger } from '${nameOf('core')}/composition';\nexport const build = createLogger;\n`,
    },
  },
  {
    name: 'a command of the command line reads the audit files through the subpath of core',
    files: {
      'packages/cli/src/commands/allowed.ts': `import { openAuditFolder } from '${nameOf('core')}/audit';\nexport const read = openAuditFolder;\n`,
    },
  },
  {
    name: 'the double in testkit builds the transport on a MockAgent',
    files: {
      'packages/testkit/src/http-double/allowed.ts': `import { createMockedHttpTransport } from '${nameOf('core')}/http/testing';\nexport const build = createMockedHttpTransport;\n`,
    },
  },
  {
    name: 'a module of core imports the type of the transport',
    files: {
      'packages/core/src/churchtools/allowed.ts':
        "import type { HttpTransport } from '../http/index.js';\nexport type Transport = HttpTransport;\n",
    },
  },
  {
    name: 'the server imports the mount',
    files: {
      'packages/server/src/allowed.ts': `import '${nameOf('core')}/mcp';\nexport {};\n`,
    },
  },
  {
    name: 'the plugin API imports zod, its peer dependency',
    files: {
      'packages/plugin-api/src/allowed.ts':
        "import type { ZodType } from 'zod';\nimport { z } from 'zod';\nexport type Schema = ZodType;\nexport const schema = z;\n",
    },
  },
  {
    name: 'the example plugin imports the plugin API',
    files: {
      'packages/testkit/src/plugins/example/allowed.ts': `import '${nameOf('plugin-api')}';\nexport {};\n`,
    },
  },
  {
    name: 'a tool of the core imports zod and the plugin API',
    files: {
      'packages/tools/src/base/allowed.ts': `import { z } from 'zod';\nimport '${nameOf('plugin-api')}';\nexport const schema = z;\n`,
    },
  },
  {
    name: 'a test of a tool of the core imports core and the testkit',
    files: {
      'packages/tools/src/base/allowed.test.ts': `import '${nameOf('core')}';\nimport '${nameOf('testkit')}';\nexport {};\n`,
    },
  },
  {
    name: 'a module inside the client folder imports the client',
    files: {
      'packages/core/src/churchtools/allowed.ts':
        "import './index.js';\nexport {};\n",
    },
  },
  {
    name: 'a module of core imports the entry point of the outbound path',
    files: {
      'packages/core/src/allowed.ts':
        "import { Secret } from './http/index.js';\nexport const make = (v: string): Secret => new Secret(v);\n",
    },
  },
  {
    name: 'a module of the outbound path imports the secret module',
    files: {
      'packages/core/src/http/allowed.ts':
        "import { revealSecret } from './secret.js';\nexport const read = revealSecret;\n",
    },
  },
  {
    name: 'the outbound path imports node:https and dns',
    files: {
      'packages/core/src/http/allowed.ts':
        "import 'node:https';\nimport 'dns';\nexport {};\n",
    },
  },
  {
    name: 'a test of the docs index reads a file',
    files: {
      'packages/docs-index/src/search/allowed.test.ts':
        "import 'node:fs';\nexport {};\n",
    },
  },
  {
    name: 'core imports node:fs, which opens no connection',
    files: {
      'packages/core/src/allowed.ts': "import 'node:fs';\nexport {};\n",
    },
  },
];

// Each case copies the sources of every package and cruises the copy, which
// grows with the code. On the slowest runner of CI, a case took longer than
// the default of five seconds, so the cruises get a bound of their own.
export const cruiseTimeout = 30_000;

/** The number of test files that share the cases. */
export const partCount = 6;

/**
 * Returns the entries of a list that one part runs: every partCount-th entry,
 * starting at the place of the part.
 *
 * @param list - The cases or the allowed cases.
 * @param part - The number of the part, from 1 to partCount.
 * @returns The entries of the part, in the order of the list.
 */
export const casesOfPart = <T,>(list: readonly T[], part: number): T[] =>
  list.filter((_, index) => index % partCount === part - 1);

/**
 * Reads the number of a part from the name of its test file. The six files
 * are the same, so none can run the part of another or a part twice.
 *
 * @param file - The path of a test file.
 * @returns The number of its part.
 * @throws {Error} When the name is not dependency-rules-N.test.mts with N from
 *   1 to partCount.
 */
export function partOfFile(file: string): number {
  const name = basename(file);
  const part = Number(/^dependency-rules-(\d+)\.test\.mts$/.exec(name)?.[1]);
  if (!Number.isInteger(part) || part < 1 || part > partCount) {
    throw new Error(`${name} names no part of the dependency cases`);
  }
  return part;
}

/**
 * Returns the cases that the test file of a part runs.
 *
 * @param file - The path of the test file of a part.
 * @returns The number of the part and its refused and allowed cases.
 * @throws {Error} When the name of the file names no part.
 */
export function casesOfFile(file: string): {
  readonly part: number;
  readonly refused: readonly Case[];
  readonly allowed: readonly Omit<Case, 'rule'>[];
} {
  const part = partOfFile(file);
  return {
    part,
    refused: casesOfPart(cases, part),
    allowed: casesOfPart(allowedCases, part),
  };
}

/**
 * Registers the cases of one part in the calling test file. Each copy goes
 * right after its case, and the part checks at its end that none is left.
 *
 * @param file - The path of the calling test file, import.meta.filename.
 * @throws {Error} When the name of the file names no part.
 */
export function describePart(file: string): void {
  const { part, refused, allowed } = casesOfFile(file);
  const temporaryFolders = temporaryFoldersOfFile();

  describe(
    `dependency-cruiser rules, part ${String(part)}`,
    { timeout: cruiseTimeout },
    () => {
      it.each(refused)('$rule: refuses that $name', async ({ rule, files }) => {
        const result = await cruiseCopy(files, temporaryFolders);
        expect(firedRules(result)).toEqual([rule]);
      });

      it.each(allowed)('allow that $name', async ({ files }) => {
        const result = await cruiseCopy(files, temporaryFolders);
        expect(result.summary.violations).toEqual([]);
      });

      it('leave no copy of an earlier case on disk', () => {
        const copies = temporaryFolders.filter((folder) =>
          folder.split(sep).at(-1)?.startsWith('ecclium-arch-'),
        );
        expect(copies).toHaveLength(refused.length + allowed.length);
        expect(copies.filter((folder) => existsSync(folder))).toEqual([]);
      });
    },
  );
}
