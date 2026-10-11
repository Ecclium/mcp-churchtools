import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The MCP SDK bundles code of other packages into its own files. That code
// has no entry in the lockfile, so neither the licence check nor
// deps-review nor Renovate sees it. ADR 0053 lists it, with licence and
// known advisories, and this test keeps the list in line with the
// installed package. It lives in testkit, the only package that depends on
// the SDK, because pnpm installs it nowhere else.
//
// The bundled code is found by the paths the build tool of the SDK writes:
// a comment //#region with node_modules/.pnpm/... before every bundled
// part, and the same paths in the sources of the source maps. Neither is a
// contract, so an empty result fails instead of passing.

const adrFile = fileURLToPath(
  new URL(
    '../../../../docs/adr/0053-mcp-sdk-und-instanzmodell.md',
    import.meta.url,
  ),
);

const advice =
  'Update the list in the Umsetzung section of ADR 0053, check the bundled packages for known advisories and check the registration names of [arch:mcp-register] against the new version (ADR 0024).';

/** A bundled package as name@version. */
type Bundled = string;

// node_modules/.pnpm/<dir>/node_modules/<name>/, where <dir> is the name
// with / as +, then @version, then an optional _peer suffix.
const pnpmPath =
  /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

function fromPath(path: string): Bundled | undefined {
  const match = pnpmPath.exec(path);
  if (match === null) return undefined;
  const [, dir = '', name = ''] = match;
  const prefix = `${name.replace('/', '+')}@`;
  if (!dir.startsWith(prefix)) return undefined;
  const version = dir.slice(prefix.length).split('_')[0] ?? '';
  return `${name}@${version}`;
}

/** Every bundled package that the files under dist/ name. */
function bundledIn(root: string): ReadonlySet<Bundled> {
  const found = new Set<Bundled>();
  const files = readdirSync(join(root, 'dist'), { recursive: true }).map(
    String,
  );
  for (const file of files) {
    const path = join(root, 'dist', file);
    if (/\.(?:mjs|cjs|d\.mts|d\.cts)$/.test(file)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.startsWith('//#region ')) {
          const bundled = fromPath(line);
          if (bundled !== undefined) found.add(bundled);
        }
      }
    } else if (file.endsWith('.map')) {
      const map = JSON.parse(readFileSync(path, 'utf8')) as {
        readonly sources?: readonly string[];
      };
      for (const source of map.sources ?? []) {
        const bundled = fromPath(source);
        if (bundled !== undefined) found.add(bundled);
      }
    }
  }
  return found;
}

/** A row of the table of bundled code in ADR 0053. */
interface Listed {
  readonly name: string;
  readonly version: string;
  readonly licence: string;
}

/** The section Umsetzung of ADR 0053: pinned version and the table. */
function listedInAdr(text: string): {
  readonly pinned: string | undefined;
  readonly rows: readonly Listed[];
} {
  const section = text.split(/^## Umsetzung$/m)[1] ?? '';
  const pinned =
    /Gepinnt ist `@modelcontextprotocol\/server` (\d+\.\d+\.\d+)/.exec(
      section,
    )?.[1];
  const rows = section
    .split('\n')
    .map((line) =>
      line
        .trim()
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => /^`[^`]+`$/.test(cells[1] ?? ''))
    .map((cells) => ({
      name: (cells[1] ?? '').slice(1, -1),
      version: cells[2] ?? '',
      licence: cells[3] ?? '',
    }));
  return { pinned, rows };
}

/**
 * Compares the bundled packages with the listed ones.
 *
 * @returns One line per difference, empty if both agree.
 */
function differences(
  found: ReadonlySet<Bundled>,
  listed: readonly Listed[],
): string[] {
  const expected = new Set(listed.map((row) => `${row.name}@${row.version}`));
  return [
    ...[...found]
      .filter((entry) => !expected.has(entry))
      .map((entry) => `bundled but not listed: ${entry}`),
    ...[...expected]
      .filter((entry) => !found.has(entry))
      .map((entry) => `listed but not bundled: ${entry}`),
  ].sort();
}

const serverRoot = dirname(
  dirname(fileURLToPath(import.meta.resolve('@modelcontextprotocol/server'))),
);

const manifest = (root: string): Readonly<Record<string, unknown>> =>
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Readonly<
    Record<string, unknown>
  >;

describe('bundled code of the MCP SDK', () => {
  const adr = listedInAdr(readFileSync(adrFile, 'utf8'));
  const found = bundledIn(serverRoot);

  it('is the version that testkit pins and ADR 0053 names', () => {
    const testkit = manifest(fileURLToPath(new URL('../../', import.meta.url)));
    const pin = (testkit['dependencies'] as Readonly<Record<string, string>>)[
      '@modelcontextprotocol/server'
    ];
    expect(manifest(serverRoot)['version'], advice).toBe(pin);
    expect(adr.pinned, advice).toBe(pin);
  });

  it('finds bundled code at all', () => {
    // Without the markers of the build tool this check would see nothing.
    expect(found.size).toBeGreaterThan(0);
    expect(adr.rows.length).toBeGreaterThan(0);
  });

  it('matches the list in ADR 0053', () => {
    expect(differences(found, adr.rows), advice).toEqual([]);
  });

  it('reports a list with a missing row or a wrong version', () => {
    const [first, ...rest] = adr.rows;
    if (first === undefined) throw new Error('the table of ADR 0053 is empty');
    expect(differences(found, rest)).toEqual([
      `bundled but not listed: ${first.name}@${first.version}`,
    ]);
    expect(
      differences(found, [{ ...first, version: '0.0.0' }, ...rest]),
    ).toEqual([
      `bundled but not listed: ${first.name}@${first.version}`,
      `listed but not bundled: ${first.name}@0.0.0`,
    ]);
  });

  it('leaves the core package of the SDK without bundled code', () => {
    // With the isolated layout of pnpm, the core package that the server
    // uses lies next to it.
    const coreRoot = realpathSync(join(serverRoot, '..', 'core'));
    const core = manifest(coreRoot);
    expect(core['name']).toBe('@modelcontextprotocol/core');
    expect(core['version']).toBe(
      (
        manifest(serverRoot)['dependencies'] as Readonly<Record<string, string>>
      )['@modelcontextprotocol/core'],
    );
    expect([...bundledIn(coreRoot)]).toEqual([]);
  });
});
