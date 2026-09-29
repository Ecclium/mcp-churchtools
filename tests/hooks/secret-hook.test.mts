import { randomBytes } from 'node:crypto';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepository, type Repository } from '../support/git.mts';

// The Git hooks in lefthook.yml stop a commit that contains a secret or data
// that must not become public, in the staged files and in the commit message
// (ADR 0014). This test installs the hooks into a temporary repository and
// commits through them, as a contributor would. Every commit that must fail
// has a counterpart that passes, so the test cannot pass merely because the
// hook fails for another reason, such as a missing tool.
//
// It needs mise, lefthook and gitleaks on the PATH, as `mise exec -- pnpm
// check` and the CI jobs provide them.

const workspace = fileURLToPath(new URL('../../', import.meta.url));

// The hooks read these files: mise.toml and mise.lock select the pinned
// gitleaks, .gitleaks.toml holds the rules.
const hookFiles = ['lefthook.yml', '.gitleaks.toml', 'mise.toml', 'mise.lock'];

/** A subdomain of church.tools that is new on every run. */
const canaryHost = (): string =>
  `${randomBytes(6).toString('hex')}.church.tools`;

// Every finding in this test comes from this rule; it stands for all rules,
// whose patterns are the business of .gitleaks.toml.
const rule = 'opsec-churchtools-host';

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
  ): { status: number | null; output: string } => {
    const result = repository.run(
      'git',
      ['commit', '--signoff', '--message', message],
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
      copyFileSync(join(workspace, file), join(repository.path, file));
    }
    const install = repository.run('lefthook', ['install'], hookEnvironment());
    expect(install.status, install.stdout + install.stderr).toBe(0);
    repository.git(['add', '--', ...hookFiles]);
  }, timeout);

  afterAll(() => {
    repository.remove();
  });

  it(
    'let a clean commit pass after scanning it',
    () => {
      const result = commit('test: add the hook configuration');
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('no leaks found');
      expect(commitCount()).toBe(1);
    },
    timeout,
  );

  it(
    'stop a staged file with a finding and do not print the value',
    () => {
      const host = canaryHost();
      stage('notes.md', `See https://${host}/ for details.\n`);

      const result = commit('docs: add notes');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(rule);
      expect(result.output).not.toContain(host);
      expect(commitCount()).toBe(1);

      stage('notes.md', 'See https://example.church.tools/ for details.\n');
      const counterpart = commit('docs: add notes');
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(2);
    },
    timeout,
  );

  it(
    'stop a commit message with a finding and do not print the value',
    () => {
      stage('notes.md', 'Nothing to report.\n');
      const host = canaryHost();

      const result = commit(`docs: summarise the notes from ${host}`);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(rule);
      expect(result.output).not.toContain(host);
      expect(commitCount()).toBe(2);

      const counterpart = commit(
        'docs: summarise the notes from example.church.tools',
      );
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(commitCount()).toBe(3);
    },
    timeout,
  );
});
