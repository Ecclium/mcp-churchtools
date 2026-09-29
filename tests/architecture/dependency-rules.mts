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

/**
 * Test files, which may use test helpers that other code may not. The same
 * pattern as the tests Vitest runs and the files the build leaves out, so a
 * file that ships is never treated as a test.
 */
const testFile = String.raw`\.test\.ts$`;

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
      comment:
        'ADR 0022: code of a package imports only npm packages its own package.json declares for run time. The workspace root declares the development tools, which would otherwise be importable from everywhere. Tests are exempt: they use the test tools of the root.',
      from: { path: '^packages/', pathNot: testFile },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown', 'npm-dev'] },
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
      name: 'plugins-only-plugin-api',
      severity: 'error',
      comment: `${adr('plugins')}: a plugin imports only the plugin API, as a plugin of a third party must. Its tests may use the testkit.`,
      from: { path: at('plugins'), pathNot: testFile },
      to: {
        path: '^packages/',
        pathNot: [`^packages/${pluginApi}/`, ...at('plugins')],
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
