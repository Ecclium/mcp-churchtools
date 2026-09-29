import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Temporary Git repositories for tests. Git reads its identity, hooks,
// signing and default branch from the global configuration, which differs
// between a developer machine and a CI runner (a runner has no identity at
// all). Every command here therefore runs without global and system
// configuration, without any GIT_ variable of the caller, and with a
// placeholder identity, so that a test gives the same result everywhere.

/** Author and committer of a commit unless a test sets another one. */
export const placeholderIdentity = {
  name: 'Max Mustermann',
  email: 'max.mustermann@example.org',
} as const;

/** The environment for a command in a temporary repository. */
export function gitEnvironment(
  extra: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...inherited,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: placeholderIdentity.name,
    GIT_AUTHOR_EMAIL: placeholderIdentity.email,
    GIT_COMMITTER_NAME: placeholderIdentity.name,
    GIT_COMMITTER_EMAIL: placeholderIdentity.email,
    ...extra,
  };
}

/** A temporary Git repository with the branch `main`. */
export interface Repository {
  /** Absolute path without symbolic links, as Git reports it. */
  readonly path: string;
  /** Runs a command in the repository and returns its result. */
  run(
    command: string,
    args: readonly string[],
    extra?: Readonly<NodeJS.ProcessEnv>,
  ): SpawnSyncReturns<string>;
  /** Runs Git in the repository and returns stdout, or throws on failure. */
  git(args: readonly string[], extra?: Readonly<NodeJS.ProcessEnv>): string;
  /** Deletes the repository. */
  remove(): void;
}

/** Creates an empty repository in the temporary directory. */
export function createRepository(): Repository {
  // realpath: on macOS the temporary directory is reached through a
  // symbolic link, while Git and child processes report the resolved path.
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'ecclium-git-')));
  const run: Repository['run'] = (command, args, extra = {}) =>
    spawnSync(command, args, {
      cwd: path,
      env: gitEnvironment(extra),
      encoding: 'utf8',
    });
  const git: Repository['git'] = (args, extra) => {
    const result = run('git', args, extra);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout;
  };
  git(['init', '--quiet', '--initial-branch=main']);
  return {
    path,
    run,
    git,
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
