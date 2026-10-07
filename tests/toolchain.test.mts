import { readFileSync, readdirSync } from 'node:fs';

import ts from 'typescript';
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

  /**
   * The jobs of a workflow as [name, text], split at the keys under `jobs:`,
   * also when a key is quoted or followed by a comment.
   */
  const jobsOf = (workflow: string): (readonly [string, string])[] =>
    (workflow.split(/^jobs:\n/m)[1] ?? '')
      .split(/^(?= {2}[^\s#])/m)
      .map((job) => [/^ {2}['"]?([\w-]+)/.exec(job)?.[1] ?? '', job] as const)
      .filter(([job]) => job !== '');

  /** Whether an expression `${{ … }}` in the text reads the given context. */
  const readsContext = (text: string, context: RegExp): boolean =>
    (text.match(/\$\{\{[\s\S]*?\}\}/g) ?? []).some((expression) =>
      context.test(expression),
    );
  /** Any use of `secrets`, also `toJSON(secrets)`. */
  const secretsContext = /\bsecrets\b/i;
  /** `github.token`, or the whole `github` context, which holds it. */
  const tokenContext = /(?<![\w.'"-])github(?![\w-])(?!\s*\.\s*(?!token\b)\w)/i;

  // Online, zizmor checks the pinned actions against the GitHub API, so this
  // step gets the job token after mise, in exactly this entry. The token only
  // reads there (ADR 0050).
  const tokenSteps = new Map([
    ['workflow-lint: Audit the workflows', 'GH_TOKEN: ${{ github.token }}'],
  ]);

  // Since version 5.1.1 mise-action keeps the job token to itself. The input
  // persist_github_token would hand it to every later step again, and so
  // would MISE_GITHUB_TOKEN set anywhere in a workflow. The input
  // github_token would give another token to the mise processes. Those
  // processes still inherit the token and run what the mise files say, so a
  // job that installs tools with mise only reads, uses no secrets and passes
  // the token to no step but those in tokenSteps (ADR 0050).
  const miseJobViolations = (workflow: string): string[] => {
    const violations: string[] = [];
    if (workflow.includes('MISE_GITHUB_TOKEN')) {
      violations.push('MISE_GITHUB_TOKEN');
    }
    if (miseSteps(workflow).length === 0) {
      return violations;
    }
    const header = workflow.split(/^jobs:\n/m)[0] ?? '';
    if (readsContext(header, secretsContext)) {
      violations.push('workflow: secrets');
    }
    if (readsContext(header, tokenContext)) {
      violations.push('workflow: token');
    }
    for (const [job, text] of jobsOf(workflow)) {
      const steps = miseSteps(text);
      if (steps.length === 0) {
        continue;
      }
      for (const step of steps) {
        if (/^\s+['"]?(?:persist_)?github_token['"]?\s*:/im.test(step)) {
          violations.push(`${job}: token input`);
        }
      }
      for (const part of text.split(/^(?= {6}- )/m)) {
        const step = /^ {6}(?:- | {2})name: (.+)$/m.exec(part)?.[1] ?? '';
        const allowed = tokenSteps.get(`${job}: ${step}`) ?? '';
        if (readsContext(part.replace(allowed, ''), tokenContext)) {
          violations.push(`${job}: token`);
        }
      }
      const blocks = [
        ...text.matchAll(
          /^ {4}permissions:(.*)\n((?:(?: {5,}\S.*| *(?:#.*)?)\n)*)/gm,
        ),
      ];
      const scopes = (blocks[0]?.[2] ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'));
      if (
        blocks.length !== 1 ||
        (blocks[0]?.[1] ?? '').replace(/#.*/, '').trim() !== '' ||
        scopes.join('\n') !== 'contents: read'
      ) {
        violations.push(`${job}: permissions`);
      }
      if (readsContext(text, secretsContext)) {
        violations.push(`${job}: secrets`);
      }
    }
    return violations;
  };

  it('keeps the job token from the steps after mise and lets their jobs only read', () => {
    const miseJobs = workflowFiles.flatMap(([, workflow]) =>
      jobsOf(workflow).filter(([, text]) => miseSteps(text).length > 0),
    );
    // Guard against a split that finds no job and so checks nothing.
    expect(miseJobs.length).toBe(workflows.flatMap(miseSteps).length);
    expect(miseJobs.length).toBeGreaterThan(0);
    for (const [name, workflow] of workflowFiles) {
      expect(miseJobViolations(workflow), name).toEqual([]);
    }
  });

  it('reports each way to hand on the token or to widen the rights of such a job', () => {
    const ci = workflowFiles.find(([name]) => name === 'ci.yml')?.[1] ?? '';
    const afterCache = (line: string) => (workflow: string) =>
      workflow.replace(/^(\s+)cache: false$/m, `$1cache: false\n$1${line}`);
    const afterLocked = (line: string) => (workflow: string) =>
      workflow.replace(/^( +)MISE_LOCKED: 1$/m, `$1MISE_LOCKED: 1\n$1${line}`);
    const afterRead = (lines: string) => (workflow: string) =>
      workflow.replace(
        /^ {6}contents: read$/m,
        `      contents: read\n${lines}`,
      );
    const mutations = [
      afterCache('persist_github_token: true'),
      afterCache("'persist_github_token': 'true'"),
      afterCache('PERSIST_GITHUB_TOKEN: true'),
      afterCache('github_token: ${{ github.token }}'),
      afterLocked('MISE_GITHUB_TOKEN: ${{ github.token }}'),
      afterLocked('GH_TOKEN: ${{ github.token }}'),
      afterLocked('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}'),
      (workflow: string) =>
        workflow.replace(
          /^ {2}compat:\n/m,
          '$&    env:\n      GITHUB_TOKEN: ${{ github.token }}\n',
        ),
      (workflow: string) =>
        workflow.replace('name: Audit the workflows', 'name: Audit'),
      (workflow: string) =>
        workflow.replace('${{ github.token }}', '${{ toJSON(github) }}'),
      (workflow: string) =>
        workflow.replace('${{ github.token }}', '${{ secrets.SOME_TOKEN }}'),
      (workflow: string) =>
        workflow.replace('${{ github.token }}', '${{ toJSON(secrets) }}'),
      (workflow: string) =>
        workflow.replace(/^ {6}contents: read$/m, '      contents: write'),
      afterRead('      pull-requests: write'),
      afterRead('\n      pull-requests: write'),
      afterRead('    # a comment\n      pull-requests: write'),
      (workflow: string) =>
        workflow.replace(
          /^ {4}permissions:\n {6}contents: read$/m,
          '    permissions: write-all',
        ),
    ];
    expect(miseJobViolations(ci)).toEqual([]);
    for (const [index, mutate] of mutations.entries()) {
      const mutated = mutate(ci);
      expect(mutated, `mutation ${String(index)}`).not.toBe(ci);
      expect(
        miseJobViolations(mutated),
        `mutation ${String(index)}`,
      ).not.toEqual([]);
    }
    // A quoted job key or one with a comment still starts its own job.
    const quoted = ci.replace(/^ {2}([\w-]+):$/gm, "  '$1': # a comment");
    expect(quoted).not.toBe(ci);
    expect(jobsOf(quoted).map(([job]) => job)).toEqual(
      jobsOf(ci).map(([job]) => job),
    );
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

interface RenovateRule {
  readonly automerge?: boolean;
  readonly matchManagers?: readonly string[];
  readonly matchDepTypes?: readonly string[];
  readonly matchPackageNames?: readonly string[];
  readonly matchUpdateTypes?: readonly string[];
}

interface RenovateConfig {
  readonly extends: readonly string[];
  readonly automerge?: boolean;
  readonly platformAutomerge?: boolean;
  readonly vulnerabilityAlerts?: { readonly automerge?: boolean };
  readonly lockFileMaintenance?: { readonly automerge?: boolean };
  readonly packageRules: readonly RenovateRule[];
}

/**
 * Reads .github/renovate.json5 without running it. The JSON reader of
 * TypeScript takes the JSON5 of this file, comments and single quotes
 * included, and reports each single-quoted string (code 1327); any other
 * report fails the test.
 */
const renovateConfig = (): RenovateConfig => {
  const file = ts.parseJsonText(
    'renovate.json5',
    read('.github/renovate.json5'),
  );
  const errors: ts.Diagnostic[] = [];
  const config = ts.convertToObject(file, errors) as RenovateConfig;
  const { parseDiagnostics } = file as unknown as {
    parseDiagnostics: readonly ts.Diagnostic[];
  };
  expect(
    [...parseDiagnostics, ...errors]
      .filter((error) => error.code !== 1327)
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' ')),
  ).toEqual([]);
  return config;
};

// Renovate merges on its own only patch and minor updates of development
// tools that are named in its configuration and published with provenance
// (ADR 0021). The trust policy of pnpm (pnpm-workspace.yaml) then refuses a
// later version with weaker evidence. A tool without provenance is merged by
// a person.
describe('Renovate', () => {
  const config = renovateConfig();
  const rules = config.packageRules;
  const withoutProvenance = [
    'typescript',
    '@types/node',
    'eslint',
    '@eslint/js',
    'prettier',
  ];
  // An exact name matches only itself. Renovate reads a name with *, ?,
  // braces, a leading ! or slashes around it as a pattern.
  const exactName = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9.-]*$/;

  /** Every key in the configuration, at any depth, with its path. */
  const entries = (
    value: unknown,
    path = '',
  ): { path: string; key: string; value: unknown }[] =>
    typeof value === 'object' && value !== null
      ? Object.entries(value as Record<string, unknown>).flatMap(
          ([key, child]) => [
            { path: `${path}/${key}`, key, value: child },
            ...entries(child, `${path}/${key}`),
          ],
        )
      : [];
  const everywhere = entries(config);
  const pathsOf = (key: string): string[] =>
    everywhere.filter((entry) => entry.key === key).map((entry) => entry.path);

  const allowedIndex = rules.findIndex((rule) => rule.automerge === true);
  const allowed = rules[allowedIndex] ?? {};

  // Renovate reads automerge from the top level, from objects per manager
  // such as npm, from objects per update type such as patch, from
  // vulnerabilityAlerts, lockFileMaintenance and every package rule.
  it('turns automerge on in exactly one rule', () => {
    expect(
      everywhere
        .filter((entry) => entry.key === 'automerge' && entry.value !== false)
        .map((entry) => entry.path),
    ).toEqual([`/packageRules/${String(allowedIndex)}/automerge`]);
  });

  it('merges automatically only the named development tools', () => {
    // Any further matcher, such as a pattern for names, could widen the
    // rule beyond the names that were checked.
    expect(Object.keys(allowed).sort()).toEqual([
      'automerge',
      'description',
      'matchDepTypes',
      'matchManagers',
      'matchPackageNames',
      'matchUpdateTypes',
    ]);
    expect(allowed.matchManagers).toEqual(['npm']);
    expect(allowed.matchDepTypes).toEqual(['devDependencies']);
    expect(allowed.matchUpdateTypes).toEqual(['patch', 'minor']);
    const names = allowed.matchPackageNames ?? [];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(exactName);
      expect(Object.keys(root.devDependencies ?? {})).toContain(name);
    }
  });

  // ignoreTests lets Renovate merge without green checks, and automergeType
  // changes how it merges. With platformAutomerge true, GitHub would merge
  // once the required checks pass, past a failing lockfile-provenance.
  it('merges only after every check has passed', () => {
    for (const key of ['ignoreTests', 'automergeType']) {
      expect(pathsOf(key), key).toEqual([]);
    }
    expect(pathsOf('platformAutomerge')).toEqual(['/platformAutomerge']);
    expect(config.platformAutomerge).toBe(false);
  });

  // A preset can turn automerge on or skip the checks, also from inside a
  // rule. The three presets here set neither (checked on 30.09.2026).
  it('uses only the known presets', () => {
    expect(config.extends).toEqual([
      'config:best-practices',
      'helpers:pinGitHubActionDigestsToSemver',
      ':semanticCommits',
    ]);
    expect(pathsOf('extends')).toEqual(['/extends']);
  });

  it('never merges a tool without provenance automatically', () => {
    const deniedIndex = rules.findIndex(
      (rule) =>
        rule.automerge === false &&
        withoutProvenance.every((name) =>
          rule.matchPackageNames?.includes(name),
        ),
    );
    // Later rules win, so the exceptions must come after the rule that
    // turns automerge on, and nothing may narrow them.
    expect(deniedIndex).toBeGreaterThan(allowedIndex);
    const denied = rules[deniedIndex] ?? {};
    expect(Object.keys(denied).sort()).toEqual([
      'automerge',
      'description',
      'matchPackageNames',
    ]);
    for (const name of denied.matchPackageNames ?? []) {
      expect(name).toMatch(exactName);
    }
    for (const name of withoutProvenance) {
      expect(allowed.matchPackageNames).not.toContain(name);
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
