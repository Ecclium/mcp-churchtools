import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSignedOffBy,
  parseIdentity,
  storedMessage,
} from '../../scripts/ci/check-dco.mts';
import {
  createRepository,
  placeholderIdentity,
  type Repository,
} from '../support/git.mts';

const script = fileURLToPath(
  new URL('../../scripts/ci/check-dco.mts', import.meta.url),
);

const max = placeholderIdentity;
const erika = { name: 'Erika Musterfrau', email: 'erika@example.org' };
const signOff = (who: { name: string; email: string }): string =>
  `Signed-off-by: ${who.name} <${who.email}>`;
const asAuthor = (who: { name: string; email: string }): NodeJS.ProcessEnv => ({
  GIT_AUTHOR_NAME: who.name,
  GIT_AUTHOR_EMAIL: who.email,
});

describe('parseIdentity', () => {
  it('reads an identity with and without a timestamp', () => {
    expect(parseIdentity('Max Mustermann <max@example.org>')).toEqual({
      name: 'Max Mustermann',
      email: 'max@example.org',
    });
    expect(
      parseIdentity('Max Mustermann <max@example.org> 1790000000 +0200'),
    ).toEqual({ name: 'Max Mustermann', email: 'max@example.org' });
  });

  it('rejects a value without an address in angle brackets', () => {
    expect(parseIdentity('Max Mustermann')).toBeUndefined();
    expect(
      parseIdentity('Max <max@example.org> <x@example.org>'),
    ).toBeUndefined();
  });
});

describe('storedMessage', () => {
  it('drops comment lines and everything from the scissors line on', () => {
    const message = [
      'fix: reject tokens',
      '# Please enter the commit message for your changes.',
      '',
      signOff(max),
      '# ------------------------ >8 ------------------------',
      signOff(erika),
      'diff --git a/x b/x',
    ].join('\n');
    expect(storedMessage(message)).toBe(
      ['fix: reject tokens', '', signOff(max)].join('\n'),
    );
  });
});

describe('isSignedOffBy', () => {
  it('needs the exact name and the address in any case', () => {
    expect(
      isSignedOffBy([`${max.name} <MAX.Mustermann@Example.org>`], max),
    ).toBe(true);
    expect(isSignedOffBy([`max mustermann <${max.email}>`], max)).toBe(false);
    expect(isSignedOffBy([`${erika.name} <${erika.email}>`], max)).toBe(false);
    expect(isSignedOffBy([], max)).toBe(false);
  });
});

// Each test and each set-up starts Git and Node.js several times and needs
// well under a second. Under heavy load, such as several checks running at
// once, one took longer than the default limit of five seconds.
const timeout = 30_000;

describe('check-dco', { timeout }, () => {
  let repository: Repository;
  let counter = 0;

  /** Commits a change to `file` and returns the new commit. */
  const commit = (
    file: string,
    message: readonly string[],
    extra: NodeJS.ProcessEnv = {},
  ): string => {
    counter += 1;
    writeFileSync(join(repository.path, file), `change ${String(counter)}\n`);
    repository.git(['add', '--', file]);
    repository.git(
      ['commit', '--quiet', ...message.flatMap((part) => ['--message', part])],
      extra,
    );
    return repository.git(['rev-parse', 'HEAD']).trim();
  };

  const check = (
    ...args: string[]
  ): { status: number | null; output: string } => {
    const result = repository.run('node', [script, ...args]);
    return { status: result.status, output: result.stdout + result.stderr };
  };

  beforeEach(() => {
    repository = createRepository();
    // The base carries no sign-off: only the new commits are checked.
    commit('base.txt', ['chore: start']);
    repository.git(['switch', '--quiet', '--create', 'feature']);
  }, timeout);

  afterEach(() => {
    repository.remove();
  });

  describe('--range', () => {
    it('accepts commits signed off by their authors', () => {
      commit('a.txt', ['fix: one', signOff(max)]);
      commit('b.txt', ['fix: two', signOff(erika)], asAuthor(erika));
      const result = check('--range', 'main', 'feature');
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('2 Commits, 0 ohne Sign-off');
    });

    it('rejects a commit without sign-off and names it', () => {
      commit('a.txt', ['fix: one', signOff(max)]);
      const unsigned = commit('b.txt', ['fix: two']);
      const result = check('--range', 'main', 'feature');
      expect(result.status).toBe(1);
      expect(result.output).toContain(`Commit ${unsigned.slice(0, 12)}`);
      expect(result.output).toContain('2 Commits, 1 ohne Sign-off');
    });

    it('rejects a sign-off by someone other than the author', () => {
      commit('a.txt', ['fix: one', signOff(max)], asAuthor(erika));
      expect(check('--range', 'main', 'feature').status).toBe(1);
    });

    it('rejects a sign-off that is not in the trailers at the end', () => {
      commit('a.txt', ['fix: one', signOff(max), 'More text afterwards.']);
      expect(check('--range', 'main', 'feature').status).toBe(1);
    });

    it('does not repeat the commit message in its output', () => {
      commit('a.txt', ['fix: ::warning::one']);
      const result = check('--range', 'main', 'feature');
      expect(result.status).toBe(1);
      expect(result.output).not.toContain('::');
    });

    it('prints an identity only without control characters', () => {
      // Git keeps a carriage return in a name, and the runner would read the
      // rest of the line as a command.
      commit('a.txt', ['fix: one'], {
        GIT_AUTHOR_NAME: `Max${String.fromCodePoint(0x0d)}::error::injected`,
      });
      const result = check('--range', 'main', 'feature');
      expect(result.status).toBe(1);
      expect(result.output).not.toContain(String.fromCodePoint(0x0d));
      expect(result.output).toContain('Max?::error::injected');
      for (const line of result.output.split('\n')) {
        expect(line.startsWith('::')).toBe(false);
      }
    });

    it('lets a merge without changes of its own pass unsigned', () => {
      commit('a.txt', ['fix: one', signOff(max)]);
      repository.git(['switch', '--quiet', 'main']);
      commit('main.txt', ['chore: move on']);
      repository.git(['switch', '--quiet', 'feature']);
      repository.git(['merge', '--quiet', '--no-ff', '--no-edit', 'main']);
      const result = check('--range', 'main', 'feature');
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('2 Commits');
    });

    it('checks a merge with changes of its own like any commit', () => {
      commit('a.txt', ['fix: one', signOff(max)]);
      repository.git(['switch', '--quiet', 'main']);
      commit('main.txt', ['chore: move on']);
      repository.git(['switch', '--quiet', 'feature']);
      repository.git(['merge', '--quiet', '--no-ff', '--no-commit', 'main']);
      writeFileSync(join(repository.path, 'extra.txt'), 'hidden change\n');
      repository.git(['add', 'extra.txt']);
      repository.git(['commit', '--quiet', '--no-edit']);
      expect(check('--range', 'main', 'feature').status).toBe(1);

      repository.git([
        'commit',
        '--quiet',
        '--amend',
        '--no-edit',
        '--signoff',
      ]);
      expect(check('--range', 'main', 'feature').status).toBe(0);
    });

    it('checks a merge of more than two parents like any commit', () => {
      for (const branch of ['left', 'right']) {
        repository.git(['switch', '--quiet', '--create', branch, 'main']);
        commit(`${branch}.txt`, [`fix: ${branch}`, signOff(max)]);
      }
      repository.git(['switch', '--quiet', 'feature']);
      repository.git([
        'merge',
        '--quiet',
        '--no-ff',
        '--no-edit',
        'left',
        'right',
      ]);
      expect(check('--range', 'main', 'feature').status).toBe(1);
    });

    it('stops with code 2 on a wrong call or an unknown commit', () => {
      expect(check('--range', 'main').status).toBe(2);
      expect(check('--range', 'main', 'missing').status).toBe(2);
    });
  });

  describe('--message-file', () => {
    const file = (): string => join(repository.path, 'message.txt');

    it('accepts a message signed off by the author Git will use', () => {
      writeFileSync(file(), ['fix: one', '', signOff(max), ''].join('\n'));
      expect(check('--message-file', file()).status).toBe(0);
    });

    it('rejects a message without the sign-off of that author', () => {
      writeFileSync(file(), 'fix: one\n');
      expect(check('--message-file', file()).status).toBe(1);
      writeFileSync(file(), ['fix: one', '', signOff(erika), ''].join('\n'));
      expect(check('--message-file', file()).status).toBe(1);
    });

    it('ignores a sign-off in a comment or below the scissors line', () => {
      writeFileSync(
        file(),
        [
          'fix: one',
          `# ${signOff(max)}`,
          '# ------------------------ >8 ------------------------',
          signOff(max),
          '',
        ].join('\n'),
      );
      expect(check('--message-file', file()).status).toBe(1);
    });

    it('leaves a merge in progress to the check of the range', () => {
      repository.git(['switch', '--quiet', 'main']);
      commit('main.txt', ['chore: move on']);
      repository.git(['switch', '--quiet', 'feature']);
      commit('a.txt', ['fix: one', signOff(max)]);
      repository.git(['merge', '--quiet', '--no-ff', '--no-commit', 'main']);
      writeFileSync(file(), 'Merge branch main\n');
      expect(check('--message-file', file()).status).toBe(0);
    });
  });
});
