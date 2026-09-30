import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepository, type Repository } from '../support/git.mts';
import { runCommand } from '../support/workflows.mts';

// The scans in CI read file names, the title of a pull request and commit
// messages through `gitleaks stdin` (ADR 0014). This test takes the command
// of each such step from its workflow and runs it in a temporary repository
// with bash in the mode the runner uses (-eo pipefail), so it checks what CI
// runs, not a copy. Every run that must fail has a counterpart that passes,
// so a test cannot pass merely because a step fails for another reason.
//
// It needs mise, gitleaks and Git, as `mise exec -- pnpm check` and the CI
// jobs provide them.

const workspace = fileURLToPath(new URL('../../', import.meta.url));

const read = (file: string): string =>
  readFileSync(join(workspace, file), 'utf8');

// The scans read the rules from .gitleaks.toml, and the mise files select
// the version of gitleaks, as in the hook test.
const configFiles = [
  '.gitleaks.toml',
  ...spawnSync('git', ['ls-files', '--', 'mise*.toml', 'mise*.lock'], {
    cwd: workspace,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter((name) => /^mise(\.[^./]+)?\.(toml|lock)$/.test(name)),
];

/** A subdomain of church.tools that is new on every run. */
const canaryHost = (): string =>
  `${randomBytes(6).toString('hex')}.church.tools`;

// gitleaks skips piped text as a binary file when its first bytes look like
// the signature of a file format. A name or a message that starts with this
// one does, which the two lines each scan prints first must neutralise (see
// .gitleaks.toml).
const binaryStart = '%PDF-1.7';

const timeout = 60_000;

describe('the scans of names, titles and messages in CI', () => {
  const repositories: Repository[] = [];

  /** A repository whose first commit holds the configuration of the scans. */
  const setUp = (): Repository => {
    const repository = createRepository();
    repositories.push(repository);
    for (const file of configFiles) {
      copyFileSync(join(workspace, file), join(repository.path, file));
    }
    repository.git(['add', '--', ...configFiles]);
    repository.git(['commit', '--quiet', '--message', 'chore: add the scans']);
    return repository;
  };

  const commit = (
    repository: Repository,
    file: string,
    message: string,
  ): void => {
    writeFileSync(join(repository.path, file), 'Nothing to report.\n');
    repository.git(['add', '--', file]);
    repository.git(['commit', '--quiet', '--message', message]);
  };

  // In a pull request the job checks out the test merge: HEAD^1 is the base
  // and HEAD^2 the head of the pull request.
  const testMerge = (
    repository: Repository,
    messages: readonly string[],
  ): void => {
    repository.git(['switch', '--quiet', '--create', 'feature']);
    messages.forEach((message, index) => {
      commit(repository, `change-${String(index)}.md`, message);
    });
    repository.git(['switch', '--quiet', 'main']);
    repository.git(['merge', '--quiet', '--no-ff', '--no-edit', 'feature']);
  };

  const run = (
    repository: Repository,
    workflow: string,
    step: string,
    extra: NodeJS.ProcessEnv = {},
  ): { status: number | null; output: string } => {
    const result = repository.run(
      'mise',
      [
        'exec',
        '--',
        'bash',
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        runCommand(workflow, step),
      ],
      { MISE_TRUSTED_CONFIG_PATHS: repository.path, NO_COLOR: '1', ...extra },
    );
    return { status: result.status, output: result.stdout + result.stderr };
  };

  afterEach(() => {
    for (const repository of repositories.splice(0)) {
      repository.remove();
    }
  });

  it(
    'find a name behind a first name that starts like a binary file',
    () => {
      const step = 'Scan the names of all files, now and in the history';
      const host = canaryHost();
      const repository = setUp();
      commit(repository, `${binaryStart}-notes.md`, 'docs: add notes');
      commit(repository, `export-${host}.md`, 'docs: add an export');

      const result = run(repository, 'ci.yml', step);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('leaks found: 1');
      expect(result.output).not.toContain(host);

      const clean = setUp();
      commit(clean, `${binaryStart}-notes.md`, 'docs: add notes');
      commit(clean, 'export.md', 'docs: add an export');
      const counterpart = run(clean, 'ci.yml', step);
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(counterpart.output).toContain('no leaks found');
    },
    timeout,
  );

  it(
    'find a title that starts like a binary file',
    () => {
      const step = 'Scan the title for secrets';
      const host = canaryHost();
      const repository = setUp();

      const result = run(repository, 'pr-meta.yml', step, {
        TITLE: `${binaryStart} fix: notes from ${host}`,
      });
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('leaks found: 1');
      expect(result.output).not.toContain(host);

      const counterpart = run(repository, 'pr-meta.yml', step, {
        TITLE: `${binaryStart} fix: notes from example.church.tools`,
      });
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(counterpart.output).toContain('no leaks found');
    },
    timeout,
  );

  it(
    'find a message of a pull request behind one that starts like a binary file',
    () => {
      const step = 'Scan the commit messages for secrets';
      const host = canaryHost();
      const repository = setUp();
      testMerge(repository, [
        `fix: one\n\nFrom ${host}.`,
        `${binaryStart} fix: two`,
      ]);

      const result = run(repository, 'pr-meta.yml', step);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('leaks found: 1');
      expect(result.output).not.toContain(host);

      const clean = setUp();
      testMerge(clean, [
        'fix: one\n\nFrom example.church.tools.',
        `${binaryStart} fix: two`,
      ]);
      const counterpart = run(clean, 'pr-meta.yml', step);
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(counterpart.output).toContain('no leaks found');
    },
    timeout,
  );

  // The runs above cover the steps in CI. This check covers every place, the
  // hooks and the scripts for local runs included, and every scan that is
  // added later.
  it('let every scan through stdin read the two lines first', () => {
    const header = String.raw`printf '\n%40000s\n`;
    const { scripts } = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    const sources: [string, string][] = [
      ['.github/workflows/ci.yml', read('.github/workflows/ci.yml')],
      ['.github/workflows/pr-meta.yml', read('.github/workflows/pr-meta.yml')],
      ['lefthook.yml', read('lefthook.yml')],
      ['package.json', Object.values(scripts).join('\n')],
    ];
    for (const [file, content] of sources) {
      const scans = content.split('gitleaks stdin').length - 1;
      expect(scans, file).toBeGreaterThan(0);
      expect(content.split(header).length - 1, file).toBe(scans);
    }
  });
});
