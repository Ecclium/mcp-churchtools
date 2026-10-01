import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRepository, type Repository } from '../support/git.mts';

// The Git hooks in lefthook.yml stop a commit that contains a secret or data
// that must not become public, in the staged files, their names and the
// commit message (ADR 0014), a commit while a .gitleaksignore could silence
// findings, and a commit whose message lacks the sign-off of its author
// (ADR 0002). This test installs the hooks into a temporary repository and
// commits through them, as a contributor would. Every commit that must fail
// has a counterpart that passes, so the test cannot pass merely because the
// hook fails for another reason, such as a missing tool.
//
// It needs mise, lefthook, gitleaks and Node.js on the PATH, as `mise exec --
// pnpm check` and the CI jobs provide them.

const workspace = fileURLToPath(new URL('../../', import.meta.url));

// The hooks read these files: .gitleaks.toml holds the rules, the script
// checks the sign-off, and the mise files select gitleaks and Node.js. Every
// tracked mise environment is copied, so that a run with MISE_ENV, as in the
// compat job, uses the same tools as the workspace. Untracked files such as
// a personal mise.local.toml stay out.
const trackedMiseFiles = spawnSync(
  'git',
  ['ls-files', '--', 'mise*.toml', 'mise*.lock'],
  { cwd: workspace, encoding: 'utf8' },
)
  .stdout.split('\n')
  .filter((name) => /^mise(\.[^./]+)?\.(toml|lock)$/.test(name));

const hookFiles = [
  'lefthook.yml',
  '.gitleaks.toml',
  'scripts/ci/check-dco.mts',
  ...trackedMiseFiles,
];

/** A subdomain of church.tools that is new on every run. */
const canaryHost = (): string =>
  `${randomBytes(6).toString('hex')}.church.tools`;

// Every finding in this test comes from this rule; it stands for all rules,
// whose patterns are the business of .gitleaks.toml.
const rule = 'opsec-churchtools-host';

/** Content that Git treats as binary: it holds NUL bytes. */
const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02]);

const timeout = 60_000;

describe('the commit hooks', () => {
  let repository: Repository;

  const hookEnvironment = (): NodeJS.ProcessEnv => ({
    // mise ignores configuration in a directory it has not been told to
    // trust.
    MISE_TRUSTED_CONFIG_PATHS: repository.path,
    // The format step runs Prettier from the node_modules of the workspace,
    // which a temporary repository lacks. `pnpm format:check` covers it.
    LEFTHOOK_EXCLUDE: 'format',
    NO_COLOR: '1',
  });

  const commit = (
    message: string,
    { signOff = true } = {},
  ): { status: number | null; output: string } => {
    const result = repository.run(
      'git',
      ['commit', ...(signOff ? ['--signoff'] : []), '--message', message],
      hookEnvironment(),
    );
    return { status: result.status, output: result.stdout + result.stderr };
  };

  const commitCount = (): number =>
    Number(repository.git(['rev-list', '--count', '--all']).trim());

  const stage = (file: string, content: string): void => {
    writeFileSync(join(repository.path, file), content);
    repository.git(['add', '--', file]);
  };

  beforeAll(() => {
    repository = createRepository();
    for (const file of hookFiles) {
      mkdirSync(dirname(join(repository.path, file)), { recursive: true });
      copyFileSync(join(workspace, file), join(repository.path, file));
    }
    expect(trackedMiseFiles).toContain('mise.toml');
    const install = repository.run('lefthook', ['install'], hookEnvironment());
    expect(install.status, install.stdout + install.stderr).toBe(0);
    // The configuration itself is committed without the hooks, so that
    // every test starts from the same commit and can run on its own.
    repository.git(['add', '--', ...hookFiles]);
    repository.git([
      'commit',
      '--quiet',
      '--no-verify',
      '--message',
      'chore: add the hook configuration',
    ]);
  }, timeout);

  beforeEach(() => {
    repository.git(['reset', '--quiet', '--hard']);
    repository.git(['clean', '--quiet', '--force', '-d']);
  });

  afterAll(() => {
    repository.remove();
  });

  it(
    'let a clean commit pass after scanning it',
    () => {
      const before = commitCount();
      stage('notes.md', 'Nothing to report.\n');

      const result = commit('docs: add notes');
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('no leaks found');
      expect(result.output).toContain('Sign-offs geprüft: 1 Commit');
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );

  it(
    'stop a staged file with a finding and do not print the value',
    () => {
      const before = commitCount();
      const host = canaryHost();
      stage('links.md', `See https://${host}/ for details.\n`);

      const result = commit('docs: add links');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(rule);
      expect(result.output).not.toContain(host);
      expect(commitCount()).toBe(before);

      stage('links.md', 'See https://example.church.tools/ for details.\n');
      const counterpart = commit('docs: add links');
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );

  it(
    'stop a commit message with a finding and do not print the value',
    () => {
      const before = commitCount();
      stage('summary.md', 'Nothing to report.\n');
      const host = canaryHost();

      const result = commit(`docs: summarise the notes from ${host}`);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(rule);
      expect(result.output).not.toContain(host);
      expect(commitCount()).toBe(before);

      const counterpart = commit(
        'docs: summarise the notes from example.church.tools',
      );
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );

  it(
    'stop a commit without the sign-off of its author',
    () => {
      const before = commitCount();
      stage('todo.md', 'Still nothing to report.\n');

      const result = commit('docs: add a list', { signOff: false });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('Das Sign-off von');
      expect(commitCount()).toBe(before);

      const counterpart = commit('docs: add a list');
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );

  it(
    'stop a staged file whose name carries a finding',
    () => {
      const before = commitCount();
      const host = canaryHost();
      const file = `export-${host}.md`;
      stage(file, 'Nothing to report.\n');

      const result = commit('docs: add an export');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(rule);
      expect(result.output).not.toContain(host);
      expect(commitCount()).toBe(before);

      repository.git(['rm', '--cached', '--quiet', '--', file]);
      rmSync(join(repository.path, file));
      stage('export.md', 'Nothing to report.\n');
      const counterpart = commit('docs: add an export');
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );

  // gitleaks skips piped text as a binary file when its first bytes look
  // like the signature of a file format, and a name or a message that starts
  // with %PDF does. The hooks print two lines of their own first, so the
  // finding behind such a start is still reported (see .gitleaks.toml).
  it(
    'stop a finding in a name when the first name starts like a binary file',
    () => {
      const before = commitCount();
      const host = canaryHost();
      const file = `export-${host}.md`;
      stage('%PDF-notes.md', 'Nothing to report.\n');
      stage(file, 'Nothing to report.\n');

      const result = commit('docs: add notes and an export');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(rule);
      expect(result.output).not.toContain(host);
      expect(commitCount()).toBe(before);

      repository.git(['rm', '--cached', '--quiet', '--', file]);
      rmSync(join(repository.path, file));
      stage('export.md', 'Nothing to report.\n');
      const counterpart = commit('docs: add notes and an export');
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );

  it(
    'stop a finding in a message that starts like a binary file',
    () => {
      const before = commitCount();
      stage('pdf.md', 'Nothing to report.\n');
      const host = canaryHost();

      const result = commit(`%PDF-1.7 notes\n\nFrom ${host}.`);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(rule);
      expect(result.output).not.toContain(host);
      expect(commitCount()).toBe(before);

      const counterpart = commit(
        '%PDF-1.7 notes\n\nFrom example.church.tools.',
      );
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );

  // gitleaks skips binary files, so an export or a database with member
  // data would pass every scan. The hook refuses a binary file outside
  // brand/, by its content and whatever .gitattributes says, and the usual
  // export formats by name, also without a NUL byte (ADR 0014).
  it(
    'stop binary and export files outside brand/ and let them pass in brand/',
    () => {
      const before = commitCount();
      const message = (file: string): string =>
        `Binär- oder Exportdatei ausserhalb von brand/: ${file}`;
      mkdirSync(join(repository.path, 'exports'), { recursive: true });
      mkdirSync(join(repository.path, 'docs/brand'), { recursive: true });
      writeFileSync(join(repository.path, 'exports/members.xlsx'), binary);
      writeFileSync(
        join(repository.path, 'docs/brand/liste.PDF'),
        '%PDF-1.7\n',
      );
      stage('.gitattributes', '*.xlsx diff\n');
      repository.git([
        'add',
        '--',
        'exports/members.xlsx',
        'docs/brand/liste.PDF',
      ]);

      const result = commit('docs: add an export');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(message('exports/members.xlsx'));
      expect(result.output).toContain(message('docs/brand/liste.PDF'));
      expect(commitCount()).toBe(before);

      repository.git(['reset', '--quiet']);
      rmSync(join(repository.path, 'exports'), { recursive: true });
      rmSync(join(repository.path, 'docs'), { recursive: true });
      rmSync(join(repository.path, '.gitattributes'));
      mkdirSync(join(repository.path, 'brand'), { recursive: true });
      writeFileSync(join(repository.path, 'brand/logo.png'), binary);
      writeFileSync(join(repository.path, 'brand/guide.pdf'), '%PDF-1.7\n');
      repository.git(['add', '--', 'brand/logo.png', 'brand/guide.pdf']);
      const counterpart = commit('docs: add the brand files');
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(before + 1);

      // Moving a file out of brand/ makes it a new file outside of it.
      mkdirSync(join(repository.path, 'exports'), { recursive: true });
      repository.git(['mv', 'brand/logo.png', 'exports/logo.png']);
      const moved = commit('docs: move the logo');
      expect(moved.status, moved.output).not.toBe(0);
      expect(moved.output).toContain(message('exports/logo.png'));
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );

  it(
    'stop every commit while a .gitleaksignore exists',
    () => {
      const before = commitCount();
      const ignoreFile = join(repository.path, '.gitleaksignore');
      writeFileSync(ignoreFile, 'report.md:opsec-churchtools-host:1\n');
      stage('report.md', 'Once more nothing to report.\n');

      const result = commit('docs: add a report');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('.gitleaksignore');
      expect(commitCount()).toBe(before);

      rmSync(ignoreFile);
      const counterpart = commit('docs: add a report');
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(before + 1);
    },
    timeout,
  );
});
