import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadBoundaries,
  parseBoundaries,
  workspaceRoot,
} from './boundaries.mts';

// boundaries.json describes the package boundaries for every architecture
// check (ADR 0022). These tests show that it matches the workspace and that
// its loader refuses a broken file instead of letting a rule check nothing.

interface RawPlace {
  adr: string;
  description: string;
  paths: string[];
}

interface RawManifest {
  [key: string]: unknown;
  packages: { dir: string; name: string; imports: string[] }[];
  testOnly: string;
  places: Record<string, RawPlace>;
}

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(join(workspaceRoot, path), 'utf8'));

const manifest = readJson('tests/architecture/boundaries.json') as RawManifest;

const packageFolders = readdirSync(join(workspaceRoot, 'packages'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('boundaries.json', () => {
  const boundaries = loadBoundaries();

  it('lists exactly the folders under packages/', () => {
    expect(boundaries.packages.map((pkg) => pkg.dir).sort()).toEqual(
      packageFolders,
    );
  });

  it.each(boundaries.packages)('uses the package name of $dir', (pkg) => {
    const packageJson = readJson(`packages/${pkg.dir}/package.json`) as {
      name: string;
    };
    expect(packageJson.name).toBe(pkg.name);
  });
});

describe('loading boundaries.json', () => {
  const place = (m: RawManifest, key: string): RawPlace => {
    const found = m.places[key];
    if (found === undefined) throw new Error(`no place ${key}`);
    return found;
  };
  const pkg = (
    m: RawManifest,
    dir: string,
  ): RawManifest['packages'][number] => {
    const found = m.packages.find((entry) => entry.dir === dir);
    if (found === undefined) throw new Error(`no package ${dir}`);
    return found;
  };

  // Each change breaks the file in exactly one way.
  const cases: readonly {
    readonly name: string;
    readonly change: (m: RawManifest) => void;
    readonly message: RegExp;
  }[] = [
    {
      name: 'an unknown key at the top level',
      change: (m) => {
        m['rules'] = [];
      },
      message: /top level: unknown key "rules"/,
    },
    {
      name: 'an unknown place',
      change: (m) => {
        m.places['logging'] = { ...place(m, 'stdout') };
      },
      message: /places: unknown key "logging"/,
    },
    {
      name: 'a missing place',
      change: (m) => {
        Reflect.deleteProperty(m.places, 'stdout');
      },
      message: /places: missing key "stdout"/,
    },
    {
      name: 'a path outside the sources of a package',
      change: (m) => {
        place(m, 'stdout').paths = ['packages/cli/output/'];
      },
      message: /"packages\/cli\/output\/" is not inside/,
    },
    {
      name: 'a path in an unknown package',
      change: (m) => {
        place(m, 'stdout').paths = ['packages/shell/src/'];
      },
      message: /"packages\/shell\/src\/" is not inside/,
    },
    {
      name: 'a path with ..',
      change: (m) => {
        place(m, 'stdout').paths = ['packages/cli/src/../src/output/'];
      },
      message: /is not a plain path/,
    },
    {
      name: 'a path that does not exist',
      change: (m) => {
        place(m, 'stdout').paths = ['packages/cli/src/printer/'];
      },
      message: /"packages\/cli\/src\/printer\/" does not exist/,
    },
    {
      name: 'a folder without a trailing slash',
      change: (m) => {
        place(m, 'stdout').paths = ['packages/cli/src/output'];
      },
      message: /is a folder and must end in \//,
    },
    {
      name: 'a file with a trailing slash',
      change: (m) => {
        place(m, 'stdout').paths = ['packages/cli/src/output/index.ts/'];
      },
      message: /ends in \/ but is not a folder/,
    },
    {
      name: 'a place without a path',
      change: (m) => {
        place(m, 'stdout').paths = [];
      },
      message: /places\.stdout: names no path/,
    },
    {
      name: 'an ADR number that is not four digits',
      change: (m) => {
        place(m, 'stdout').adr = '18';
      },
      message: /places\.stdout: adr must be the four-digit number/,
    },
    {
      name: 'an import of an unknown package',
      change: (m) => {
        pkg(m, 'core').imports.push('shell');
      },
      message: /core: imports the unknown package "shell"/,
    },
    {
      name: 'a package that imports itself',
      change: (m) => {
        pkg(m, 'core').imports.push('core');
      },
      message: /core: lists itself/,
    },
    {
      name: 'the test package as a runtime import',
      change: (m) => {
        pkg(m, 'core').imports.push('testkit');
      },
      message: /core: testkit is for tests only/,
    },
    {
      name: 'a cycle between packages',
      change: (m) => {
        pkg(m, 'plugin-api').imports.push('core');
      },
      message: /the imports form a cycle: .*plugin-api -> core -> plugin-api/,
    },
    {
      name: 'a package listed twice',
      change: (m) => {
        m.packages.push({ ...pkg(m, 'core') });
      },
      message: /a folder is listed twice/,
    },
    {
      name: 'a package name listed twice',
      change: (m) => {
        pkg(m, 'tools').name = pkg(m, 'core').name;
      },
      message: /a name is listed twice/,
    },
    {
      name: 'an import listed twice',
      change: (m) => {
        pkg(m, 'core').imports.push('plugin-api');
      },
      message: /core: an import is listed twice/,
    },
    {
      name: 'a path listed twice',
      change: (m) => {
        const stdout = place(m, 'stdout');
        stdout.paths = [...stdout.paths, ...stdout.paths];
      },
      message: /places\.stdout: a path is listed twice/,
    },
    {
      name: 'an empty description',
      change: (m) => {
        place(m, 'stdout').description = ' ';
      },
      message: /places\.stdout: description must not be empty/,
    },
    {
      name: 'a package folder that is not a plain name',
      change: (m) => {
        pkg(m, 'core').dir = 'Core';
      },
      message: /dir must be the name of a folder/,
    },
    {
      name: 'a package name outside the scope',
      change: (m) => {
        pkg(m, 'core').name = 'mcp-churchtools-core';
      },
      message: /name must be a package name under @ecclium\//,
    },
    {
      name: 'packages that are not a list',
      change: (m) => {
        Reflect.set(m, 'packages', {});
      },
      message: /packages: must be a list/,
    },
    {
      name: 'places that are not an object',
      change: (m) => {
        Reflect.set(m, 'places', []);
      },
      message: /places: must be an object/,
    },
    {
      name: 'paths that are not a list',
      change: (m) => {
        m.places['stdout'] = { ...place(m, 'stdout'), paths: 'x' as never };
      },
      message: /places\.stdout: paths must be a list/,
    },
    {
      name: 'a folder among the importers of the raw client',
      change: (m) => {
        place(m, 'rawClientImporters').paths = ['packages/core/src/logger/'];
      },
      message:
        /places\.rawClientImporters: "packages\/core\/src\/logger\/" must be one module/,
    },
    {
      name: 'the entry point of core among the importers of the raw client',
      change: (m) => {
        place(m, 'rawClientImporters').paths = ['packages/core/src/index.ts'];
      },
      message:
        /places\.rawClientImporters: "packages\/core\/src\/index\.ts" must be one module/,
    },
    {
      name: 'a module of another package among the importers of the raw client',
      change: (m) => {
        place(m, 'rawClientImporters').paths = [
          'packages/server/src/stdio/index.ts',
        ];
      },
      message:
        /places\.rawClientImporters: "packages\/server\/src\/stdio\/index\.ts" must be one module/,
    },
    {
      name: 'a module inside the client folder among its importers',
      change: (m) => {
        place(m, 'rawClientImporters').paths = [
          'packages/core/src/churchtools/index.ts',
        ];
      },
      message: /places\.rawClientImporters: .* must be one module/,
    },
    {
      name: 'the package of the mount among its importers',
      change: (m) => {
        place(m, 'mcpMountImporters').paths = ['packages/core/src/'];
      },
      message:
        /places\.mcpMountImporters: "packages\/core\/src\/" lies in the package of the mount/,
    },
    {
      name: 'a test package that is not listed',
      change: (m) => {
        m.testOnly = 'fixtures';
      },
      message: /testOnly: must name a listed package/,
    },
  ];

  it('accepts the file as it is', () => {
    expect(() => parseBoundaries(manifest, workspaceRoot)).not.toThrow();
  });

  it.each(cases)('refuses $name', ({ change, message }) => {
    const broken = structuredClone(manifest);
    change(broken);
    expect(() => parseBoundaries(broken, workspaceRoot)).toThrow(message);
  });
});
