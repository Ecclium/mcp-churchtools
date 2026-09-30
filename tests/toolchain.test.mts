import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The Node.js, pnpm and mise versions are named in several files, each read
// by a different tool: mise, nvm, pnpm, Corepack, npm and the CI workflows.
// These tests keep them in step, so that an update of one file cannot leave
// another one behind (ADR 0019, ADR 0020).

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

interface Manifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const manifest = (path: string): Manifest => JSON.parse(read(path)) as Manifest;

const root = manifest('package.json');

/** Reads a quoted value from a TOML line such as `node = "24.21.0"`. */
const tomlValue = (toml: string, key: string): string | undefined =>
  new RegExp(`^"?${key}"?\\s*=\\s*"([^"]+)"`, 'm').exec(toml)?.[1];

const major = (version: string): number => Number(version.split('.')[0]);

const developmentNode = tomlValue(read('mise.toml'), 'node') ?? '';
const compatNode = tomlValue(read('mise.compat.toml'), 'node') ?? '';

describe('Node.js', () => {
  it('uses the same development version for mise and nvm', () => {
    expect(developmentNode).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read('.nvmrc').trim()).toBe(developmentNode);
  });

  it('keeps the development version within the supported range', () => {
    const minimum = /^\^(\d+\.\d+\.\d+) \|\| >=(\d+)\.0\.0$/.exec(
      root.engines?.['node'] ?? '',
    );
    expect(minimum).not.toBeNull();
    const [, lowest = '', next = ''] = minimum ?? [];
    expect(major(lowest)).toBe(major(developmentNode));
    expect(
      lowest.localeCompare(developmentNode, 'en', { numeric: true }),
    ).toBeLessThanOrEqual(0);
    expect(major(compatNode)).toBe(Number(next));
  });

  it('checks the next line in the compatibility environment', () => {
    expect(major(compatNode)).toBeGreaterThan(major(developmentNode));
  });

  it('checks the oldest supported version in the minimum environment', () => {
    const lowest = /^\^(\d+\.\d+\.\d+) \|\| /.exec(
      root.engines?.['node'] ?? '',
    )?.[1];
    expect(lowest).toBeDefined();
    expect(tomlValue(read('mise.minimum.toml'), 'node')).toBe(lowest);
  });

  it('types only the APIs of the development line', () => {
    const types = root.devDependencies?.['@types/node'] ?? '';
    expect(major(types)).toBe(major(developmentNode));
  });
});

describe('pnpm', () => {
  it('uses the same version for mise and Corepack, pinned by hash', () => {
    const version = tomlValue(read('mise.toml'), 'aqua:pnpm/pnpm');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(root.packageManager).toMatch(
      new RegExp(`^pnpm@${String(version)}\\+sha512\\.[0-9a-f]{128}$`),
    );
  });
});

describe('mise', () => {
  const workflowDirectory = new URL('../.github/workflows/', import.meta.url);
  // GitHub runs .yml and .yaml files alike.
  const workflowFiles = readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map(
      (name) =>
        [name, readFileSync(new URL(name, workflowDirectory), 'utf8')] as const,
    );
  const workflows = workflowFiles.map(([, workflow]) => workflow);

  /** Every step of a workflow that installs tools with mise-action. */
  const miseSteps = (workflow: string): string[] =>
    workflow
      .split(/^\s*- (?=name:|uses:)/m)
      .filter((step) => step.includes('jdx/mise-action@'));

  /** The `version:` inputs of every mise-action step in a workflow. */
  const miseVersions = (workflow: string): (string | undefined)[] =>
    miseSteps(workflow).map((step) => /^\s+version: (\S+)$/m.exec(step)?.[1]);

  it('pins one version of mise in every workflow that installs tools', () => {
    const versions = workflows.flatMap(miseVersions);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version).toMatch(/^\d{4}\.\d+\.\d+$/);
    }
    expect(new Set(versions).size).toBe(1);
  });

  // Renovate updates the version of mise with a regular expression over the
  // workflows and over its own configuration (.github/renovate.json5). The
  // same expressions here make sure that it finds every place and that the
  // mise updating mise.lock is the mise CI runs.
  it('lets Renovate find every pinned version of mise', () => {
    const renovate = read('.github/renovate.json5');
    const step =
      /jdx\/mise-action@[0-9a-f]{40} # v\S+\s+with:\s+version: (\S+)/g;
    for (const workflow of workflows) {
      const found = [...workflow.matchAll(step)].map((match) => match[1]);
      expect(found).toEqual(miseVersions(workflow));
    }
    const [version] = workflows.flatMap(miseVersions);
    expect(/\bmise: '([^']+)'/.exec(renovate)?.[1]).toBe(version);
  });

  // A cache restored from an earlier run could replace gitleaks or zizmor,
  // and mise does not check the checksums from its lock files again for
  // tools it restores from a cache (ADR 0021). mise-action caches unless it
  // is told not to. Locked mode makes mise refuse a tool whose version,
  // address or checksum is missing from the lock file.
  it('installs the tools without a cache and in locked mode', () => {
    for (const [name, workflow] of workflowFiles) {
      const steps = miseSteps(workflow);
      for (const step of steps) {
        expect(step, name).toMatch(/^\s+cache: false$/m);
      }
      if (steps.length > 0) {
        expect(workflow, name).toMatch(
          /^env:\n(?: +\S.*\n)*? +MISE_LOCKED: 1$/m,
        );
      }
      // A job, a step or a line written to $GITHUB_ENV could switch it off
      // again.
      for (const [, value] of workflow.matchAll(
        /MISE_LOCKED\s*[:=]\s*['"]?([^'"\s]*)/g,
      )) {
        expect(value, name).toBe('1');
      }
    }
  });

  it('restores no cache in any workflow', () => {
    for (const [name, workflow] of workflowFiles) {
      expect(workflow, name).not.toMatch(/uses: actions\/cache/);
      for (const line of workflow.match(/^\s+[\w-]*cache[\w-]*:.*$/gim) ?? []) {
        expect(line.trim(), name).toBe('cache: false');
      }
    }
  });

  // mise 2026.9.7 to 2026.9.15 read and write lock files in format 2; newer
  // releases write format 3, which these reject. A lock file in format 3
  // therefore needs a newer mise in CI in the same change.
  it('keeps every lock file in the format the pinned mise reads', () => {
    const locks = readdirSync(new URL('../', import.meta.url)).filter((name) =>
      /^mise(\.[^.]+)?\.lock$/.test(name),
    );
    expect(locks).toContain('mise.lock');
    for (const lock of locks) {
      expect(read(lock), lock).toMatch(/^lockfile_version = 2$/m);
    }
  });
});

describe('dependencies', () => {
  const manifests = [
    root,
    ...readdirSync(new URL('../packages/', import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => manifest(`packages/${entry.name}/package.json`)),
  ];

  it('pins every external dependency to an exact version', () => {
    for (const {
      name = 'workspace root',
      dependencies,
      devDependencies,
    } of manifests) {
      for (const [dependency, spec] of Object.entries({
        ...dependencies,
        ...devDependencies,
      })) {
        if (!spec.startsWith('workspace:')) {
          expect(spec, `${name}: ${dependency}`).toMatch(/^\d+\.\d+\.\d+$/);
        }
      }
    }
  });
});
