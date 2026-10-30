import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  IConfiguration,
  ICruiseOptions,
  IForbiddenRuleType,
} from 'dependency-cruiser';

import type { Boundaries, PlaceKey } from './boundaries.mts';

// The dependency-cruiser rules, generated from boundaries.json. The command
// `pnpm check:arch` and the architecture tests load them through
// .dependency-cruiser.mjs, so both check with the same configuration.

/** Name of the package that plugins may import. */
const pluginApi = 'plugin-api';

/** Name of the package that the docs tools read. */
const docsIndex = 'docs-index';

/**
 * Test files, which may use test helpers that other code may not. The same
 * pattern as the tests Vitest runs and the files the build leaves out, so a
 * file that ships is never treated as a test.
 */
const testFile = String.raw`\.test\.ts$`;

/**
 * What opens or resolves network connections: the built-in modules for HTTP,
 * sockets, TLS, UDP, DNS and the inspector, and the HTTP client undici.
 * dependency-cruiser drops the prefix node: of a built-in module, the pattern
 * allows it all the same.
 */
export const networkTargets: readonly string[] = [
  '^(node:)?(http|https|http2|net|tls|dgram|dns|inspector)(/promises)?$',
  '(^|/)node_modules/undici/',
];

/**
 * The source behind the subpath ./composition of core, which hands the
 * composition root the stderr writer, the logger and the audit sink.
 */
const compositionEntry = 'packages/core/src/composition.ts';

/** The executable of the command line. */
const binEntry = 'packages/cli/src/bin.ts';

/** What the executable imports statically: the takeover of the environment. */
const binImports: readonly string[] = ['packages/cli/src/environment.ts'];

/**
 * What the executable loads with import(): the command line and the start
 * over stdio.
 */
const binLoads: readonly string[] = [
  'packages/cli/src/main.ts',
  'packages/cli/src/stdio/index.ts',
];

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Turns a path from boundaries.json into a pattern for dependency-cruiser:
 * a folder covers everything below it, a file only itself.
 *
 * @param path - Path from the workspace root; a folder ends in `/`.
 * @returns A regular expression as a string.
 */
export const pathPattern = (path: string): string =>
  `^${escape(path)}${path.endsWith('/') ? '' : '$'}`;

/**
 * Files that other packages may import: the source behind each subpath in
 * `exports` of every package, in addition to the main entry `src/index.ts`.
 */
function exportedEntries(boundaries: Boundaries, root: string): string[] {
  return boundaries.packages.flatMap((pkg) => {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', pkg.dir, 'package.json'), 'utf8'),
    ) as { exports?: Record<string, Record<string, string>> };
    return Object.values(manifest.exports ?? {}).flatMap((conditions) => {
      const source = conditions['@ecclium/source'];
      return source === undefined
        ? []
        : [pathPattern(join('packages', pkg.dir, source))];
    });
  });
}

/**
 * Builds the forbidden rules. Each rule names in its comment the ADR that
 * gives the reason.
 *
 * @param boundaries - The checked content of boundaries.json.
 * @param root - Workspace root, to read the exports of every package.
 * @returns The rules, all with severity `error`.
 */
export function dependencyRules(
  boundaries: Boundaries,
  root: string,
): IForbiddenRuleType[] {
  const { places, testOnly } = boundaries;
  const dirs = boundaries.packages.map((pkg) => pkg.dir);
  const at = (key: PlaceKey): string[] => places[key].paths.map(pathPattern);
  const adr = (key: PlaceKey): string => `ADR ${places[key].adr}`;
  if (!dirs.includes(pluginApi)) {
    throw new Error(`boundaries.json: the package ${pluginApi} is missing`);
  }

  const tableRules = boundaries.packages.flatMap((pkg) => {
    const allowed = [pkg.dir, testOnly, ...pkg.imports];
    // A package that may import every other one has nothing to forbid; the
    // rule no-unknown-package still covers folders the table does not know.
    if (dirs.every((dir) => allowed.includes(dir))) return [];
    const list = pkg.imports.length > 0 ? pkg.imports.join(', ') : 'none';
    return [
      {
        name: `imports-of-${pkg.dir}`,
        severity: 'error',
        comment: `ADR 0022: code in ${pkg.dir} imports only these packages: ${list}. Tests may also import ${testOnly}.`,
        from: { path: `^packages/${escape(pkg.dir)}/` },
        to: {
          path: '^packages/[^/]+/',
          pathNot: `^packages/(${allowed.map(escape).join('|')})/`,
        },
      } satisfies IForbiddenRuleType,
    ];
  });

  return [
    {
      name: 'no-cycles',
      severity: 'error',
      comment:
        'ADR 0022: no module imports itself through a chain of imports, inside a package or across packages.',
      from: {},
      to: { circular: true },
    },
    ...tableRules,
    {
      name: 'no-unknown-package',
      severity: 'error',
      comment:
        'ADR 0022: every folder under packages/ is listed in boundaries.json, otherwise no import rule would apply to it.',
      from: {},
      to: {
        path: '^packages/[^/]+/',
        pathNot: `^packages/(${dirs.map(escape).join('|')})/`,
      },
    },
    {
      name: 'testkit-dev-only',
      severity: 'error',
      comment: `ADR 0022: only tests import ${testOnly}, so it never ships.`,
      from: {
        path: '^packages/',
        pathNot: [testFile, `^packages/${escape(testOnly)}/`],
      },
      to: { path: `^packages/${escape(testOnly)}/` },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'ADR 0022: every import resolves. An import that does not resolve would escape every other rule.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-npm',
      severity: 'error',
      comment: `ADR 0022: code of a package imports only npm packages its own package.json declares for run time. The workspace root declares the development tools, which would otherwise be importable from everywhere. Tests are exempt: they use the test tools of the root. ${pluginApi} has its own rule.`,
      from: {
        path: '^packages/',
        pathNot: [testFile, `^packages/${escape(pluginApi)}/`],
      },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown', 'npm-dev'] },
    },
    {
      // A peer dependency also sits under devDependencies, so that the
      // package can be built and tested in the workspace. dependency-cruiser
      // then reports both types, and only the peer type makes it allowed.
      name: 'plugin-api-peers-only',
      severity: 'error',
      comment: `ADR 0022: code of ${pluginApi} imports npm packages only as peer dependencies, which every plugin brings itself, so that core and plugins share one copy. A dependency for run time would ship a second copy with the published package. It imports no built-in module of Node.js either: the contract does no input or output of its own. Tests are exempt.`,
      from: { path: `^packages/${escape(pluginApi)}/`, pathNot: testFile },
      to: {
        dependencyTypes: [
          'core',
          'npm',
          'npm-optional',
          'npm-no-pkg',
          'npm-unknown',
          'npm-dev',
        ],
        dependencyTypesNot: ['npm-peer'],
      },
    },
    {
      name: 'no-import-outside-packages',
      severity: 'error',
      comment:
        'ADR 0022: code of a package imports no file of the repository outside packages/ by a relative path. Such a file would be missing from the published package.',
      from: { path: '^packages/' },
      to: {
        pathNot: ['^packages/', '(^|/)node_modules/'],
        dependencyTypes: ['local'],
      },
    },
    {
      name: 'no-relative-cross-package',
      severity: 'error',
      comment:
        'ADR 0022: another package is imported by its name, never by a relative path into its folder.',
      from: { path: '^packages/([^/]+)/' },
      to: {
        path: '^packages/',
        pathNot: '^packages/$1/',
        dependencyTypes: ['local'],
      },
    },
    {
      name: 'no-deep-package-imports',
      severity: 'error',
      comment:
        'ADR 0022: another package is entered only through a file its exports name.',
      from: { path: '^packages/([^/]+)/' },
      to: {
        path: '^packages/[^/]+/',
        pathNot: [
          '^packages/$1/',
          String.raw`^packages/[^/]+/src/index\.ts$`,
          ...exportedEntries(boundaries, root),
        ],
      },
    },
    {
      name: 'network-only-in-egress',
      severity: 'error',
      comment: `${adr('egress')}: only the outbound path in core opens network connections, after it checks the host allow-list (draft ADR 0009). Imports for types only count as well.`,
      from: { path: '^packages/', pathNot: at('egress') },
      to: { path: [...networkTargets] },
    },
    {
      name: 'egress-internals',
      severity: 'error',
      comment:
        'ADR 0054: only modules of the outbound path import its modules other than its entry points: index.ts, compose.ts and compose-mock.ts, the subpaths ./http and ./http/testing of core, whose importers transport-only-from-composition-root and mocked-transport-only-in-testkit narrow (ADR 0056). One of the other modules turns a secret back into its value, which no other module may do. Tests in the packages are not exempt. Code outside the packages is not cruised; tests/architecture/reveal-secret.test.mts covers it.',
      from: { pathNot: at('egress') },
      to: {
        path: at('egress'),
        pathNot: [
          pathPattern(`${places.egress.paths[0] ?? ''}index.ts`),
          pathPattern(`${places.egress.paths[0] ?? ''}compose.ts`),
          pathPattern(`${places.egress.paths[0] ?? ''}compose-mock.ts`),
        ],
      },
    },
    {
      name: 'transport-only-from-composition-root',
      severity: 'error',
      comment: `${adr('transportBuilders')}: only the composition root builds an HTTP transport, through the subpath ./http of core, so that no tool builds one with an origin of its own. Tests in the packages are not exempt.`,
      from: { pathNot: [...at('egress'), ...at('transportBuilders')] },
      to: {
        path: pathPattern(`${places.egress.paths[0] ?? ''}compose.ts`),
      },
    },
    {
      name: 'composition-only-from-composition-root',
      severity: 'error',
      comment:
        'ADR 0054: only the composition root, the place transportBuilders, imports the subpath ./composition of core with the stderr writer, the logger and the audit sink, so that no tool, plugin or workflow can write any text to stderr. Tests in the packages are not exempt: the tests of core import the modules behind it.',
      from: { pathNot: at('transportBuilders') },
      to: { path: pathPattern(compositionEntry) },
    },
    {
      name: 'mocked-transport-only-in-testkit',
      severity: 'error',
      comment: `${adr('httpDouble')}: only the test double in testkit builds the transport on a MockAgent, through the subpath ./http/testing of core, so that no module that ships builds one. The module itself is part of the build of core, and only tests import testkit.`,
      from: { pathNot: [...at('egress'), ...at('httpDouble')] },
      to: {
        path: pathPattern(`${places.egress.paths[0] ?? ''}compose-mock.ts`),
      },
    },
    {
      name: 'raw-client-only-in-core',
      severity: 'error',
      comment: `${adr('rawClient')}: only the listed core modules import the raw ChurchTools client; the entry point of core does not pass it on.`,
      from: { pathNot: [...at('rawClient'), ...at('rawClientImporters')] },
      to: { path: at('rawClient') },
    },
    {
      name: 'mcp-mount-only-in-server',
      severity: 'error',
      comment: `${adr('mcpMount')}: only the server uses the mount, the one registration with the MCP SDK.`,
      from: { pathNot: [...at('mcpMount'), ...at('mcpMountImporters')] },
      to: { path: at('mcpMount') },
    },
    {
      name: 'no-stdout-in-stdio-paths',
      severity: 'error',
      comment: `${adr('stdioEntries')}: in the stdio mode stdout carries only the MCP protocol, so no module reachable from its start may write to stdout. Tests there are exempt: they reach the command line through the testkit.`,
      from: { path: at('stdioEntries'), pathNot: testFile },
      to: { path: at('stdout'), reachable: true },
    },
    {
      name: 'no-stdout-from-stdio-modules',
      severity: 'error',
      comment: `${adr('stdioReachable')}: the start notices and their texts are there for the start over stdio, so they never reach a module that writes to stdout, even before that start imports them. Tests there are exempt.`,
      from: { path: at('stdioReachable'), pathNot: testFile },
      to: { path: at('stdout'), reachable: true },
    },
    {
      name: 'no-util-module',
      severity: 'error',
      comment: `${adr('utilModule')}: loading node:util as an ES module makes fd 2 non-blocking, so no module of the packages imports it or its old name node:sys, apart from the files of the place utilModule and the tests. Imports for types only count as well; node:util/types stays allowed.`,
      from: { path: '^packages/', pathNot: [testFile, ...at('utilModule')] },
      to: { path: '^(node:)?(util|sys)$' },
    },
    {
      name: 'no-process-module',
      severity: 'error',
      comment: `${adr('utilModule')}: loading node:process as an ES module makes fd 1 and fd 2 non-blocking, so no module of the packages imports it, tests included. Imports for types only count as well.`,
      from: { path: '^packages/' },
      to: { path: '^(node:)?process$' },
    },
    {
      name: 'docs-files-only-in-place',
      severity: 'error',
      comment: `${adr('docsFiles')}: the docs index loads node:fs only in the modules of the place docsFiles, which load the built index and build it. Every other module of docs-index works on data it is given, so that no lookup of a tool reaches the file system. Tests are exempt.`,
      from: {
        path: '^packages/docs-index/src/',
        pathNot: [testFile, ...at('docsFiles')],
      },
      to: { path: '^(node:)?fs(/promises)?$' },
    },
    {
      name: 'no-diagnostics-channel',
      severity: 'error',
      comment:
        'ADR 0056: undici publishes the headers of every request on diagnostics channels, the Authorization header with the token among them, and the answers as well. A subscriber would read them past the Secret, so no module of the packages imports node:diagnostics_channel, tests included. Imports for types only count as well.',
      from: { path: '^packages/' },
      to: { path: '^(node:)?diagnostics_channel$' },
    },
    {
      name: 'no-util-module-in-stdio-paths',
      severity: 'error',
      comment: `${adr('utilModule')}: the start over stdio never reaches a file of the place utilModule, which loads node:util and so makes fd 2 non-blocking. Tests there are exempt.`,
      from: {
        path: [...at('stdioEntries'), ...at('stdioReachable')],
        pathNot: testFile,
      },
      to: { path: at('utilModule'), reachable: true },
    },
    {
      name: 'bin-imports-only-environment',
      severity: 'error',
      comment: `${adr('environment')}: the executable of the command line imports statically only the module that takes over the environment, so that the token has left the environment before any other module loads. Imports for types only count as well.`,
      from: { path: pathPattern(binEntry) },
      to: { dynamic: false, pathNot: binImports.map(pathPattern) },
    },
    {
      name: 'bin-loads-only-main-or-stdio',
      severity: 'error',
      comment: `${adr('utilModule')}: the executable of the command line loads with import() only the command line and the start over stdio, so that the start over stdio never loads the command line, whose node:util makes fd 2 non-blocking before the start notices go out.`,
      from: { path: pathPattern(binEntry) },
      to: { dynamic: true, pathNot: binLoads.map(pathPattern) },
    },
    {
      name: 'plugins-only-plugin-api',
      severity: 'error',
      comment: `${adr('plugins')}: a plugin imports only the plugin API, as a plugin of a third party must. Its tests may use the testkit. The plugin of the core may add the docs tools, which read the docs index (${adr('docsTools')}).`,
      from: { path: at('plugins'), pathNot: testFile },
      to: {
        path: '^packages/',
        pathNot: [
          `^packages/${pluginApi}/`,
          ...at('plugins'),
          ...at('docsTools'),
        ],
      },
    },
    {
      name: 'docs-tools-only-plugin-api-and-docs-index',
      severity: 'error',
      comment: `${adr('docsTools')}: the docs tools import, of the workspace, only the plugin API, the modules of the plugins and the docs index they read. Their tests may use the testkit.`,
      from: { path: at('docsTools'), pathNot: testFile },
      to: {
        path: '^packages/',
        pathNot: [
          `^packages/${pluginApi}/`,
          `^packages/${docsIndex}/`,
          ...at('plugins'),
          ...at('docsTools'),
        ],
      },
    },
  ];
}

/**
 * How dependency-cruiser reads the code. The tests check each of these
 * settings, because a wrong one lets real violations pass without notice.
 */
export const cruiseOptions: ICruiseOptions = {
  // Stop at node_modules and dist/ but keep the edges into them. exclude and
  // includeOnly would drop those edges, and with them the violations of an
  // import that falls back to a build instead of the source.
  // Both patterns are anchored, so that a source folder that happens to be
  // named dist or node_modules is still followed.
  doNotFollow: { path: ['(^|/)node_modules/', '^packages/[^/]+/dist/'] },
  // Type-only imports cross package boundaries just like runtime imports.
  tsPreCompilationDeps: true,
  // Resolve workspace packages to their TypeScript source, like TypeScript
  // and Vitest do, so the check never depends on an earlier build (ADR 0022).
  enhancedResolveOptions: {
    exportsFields: ['exports'],
    conditionNames: ['@ecclium/source', 'import', 'require', 'node', 'default'],
  },
};

/**
 * The whole configuration for dependency-cruiser.
 *
 * @param boundaries - The checked content of boundaries.json.
 * @param root - Workspace root.
 * @returns Rules and options.
 */
export const dependencyCruiserConfig = (
  boundaries: Boundaries,
  root: string,
): IConfiguration => ({
  forbidden: dependencyRules(boundaries, root),
  options: cruiseOptions,
});
