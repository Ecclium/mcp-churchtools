/**
 * Checks the sign-off of the Developer Certificate of Origin in commits.
 *
 * Every commit carries a `Signed-off-by` trailer whose name and e-mail
 * address are those of its author (ADR 0002, CONTRIBUTING.md). Trailers are
 * read by Git itself, so the check sees exactly what Git and GitHub show.
 *
 * A merge commit needs no sign-off only if it has exactly two parents and
 * changes nothing beyond what Git merges on its own, like the merge that
 * «Update branch» on GitHub creates. Everything in it then comes from
 * commits that are checked themselves. Any other merge is checked like a
 * normal commit.
 *
 * Usage:
 * - `node scripts/ci/check-dco.mts --range <base> <head>` checks every
 *   commit that is reachable from `<head>` but not from `<base>`.
 * - `node scripts/ci/check-dco.mts --message-file <file>` checks a commit
 *   message before the commit exists, against the author Git is going to
 *   use. The commit-msg hook calls it this way.
 *
 * @packageDocumentation
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Name and e-mail address, as Git records them for a commit. */
export interface Identity {
  readonly name: string;
  readonly email: string;
}

/** The result of checking commits or a message. */
export interface SignOffReport {
  /** Number of commits looked at. */
  readonly checked: number;
  /** What is missing, in German, one entry per commit. */
  readonly problems: readonly string[];
}

/**
 * Reads name and e-mail address from an identity such as
 * `Max Mustermann <max.mustermann@example.org>`.
 *
 * @param ident - The identity, optionally followed by a timestamp and a
 *   time zone as in the output of `git var GIT_AUTHOR_IDENT`.
 * @returns The identity, or undefined if there is no address in angle
 *   brackets.
 */
export function parseIdentity(ident: string): Identity | undefined {
  const match =
    /^(?<name>[^<>]*?) ?<(?<email>[^<>]*)>(?: \d+ [+-]\d{4})?$/.exec(
      ident.trim(),
    )?.groups;
  if (match === undefined) {
    return undefined;
  }
  return { name: match['name'] ?? '', email: match['email'] ?? '' };
}

/**
 * Returns a commit message as Git will store it: without the part from the
 * scissors line on, which holds the diff of `git commit --verbose`, and
 * without comment lines.
 *
 * @param message - The message as the commit-msg hook receives it.
 * @returns The message without the parts Git drops.
 */
export function storedMessage(message: string): string {
  const lines = message.split('\n');
  const scissors = lines.findIndex((line) => /^# -+ >8 -+$/.test(line));
  return (scissors === -1 ? lines : lines.slice(0, scissors))
    .filter((line) => !line.startsWith('#'))
    .join('\n');
}

/**
 * Tells whether one of the signed-off identities is the author. Names must
 * match exactly, e-mail addresses regardless of case.
 *
 * @param signOffs - Values of the `Signed-off-by` trailers.
 * @param author - Author of the commit.
 * @returns True if the author has signed off.
 */
export function isSignedOffBy(
  signOffs: readonly string[],
  author: Identity,
): boolean {
  return signOffs.some((value) => {
    const identity = parseIdentity(value);
    return (
      identity !== undefined &&
      identity.name === author.name &&
      identity.email.toLowerCase() === author.email.toLowerCase()
    );
  });
}

function git(args: readonly string[], input?: string): string {
  const result = spawnSync('git', args, { encoding: 'utf8', input });
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0] ?? ''} ist fehlgeschlagen: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Reads the values of the `Signed-off-by` trailers of a message, parsed by
 * Git. Only the trailer block at the end counts, not a line in the middle.
 *
 * @param message - A commit message.
 * @returns The values, such as `Max Mustermann <max.mustermann@example.org>`.
 * @throws {Error} If Git cannot parse the message.
 */
export function signOffs(message: string): string[] {
  // --no-divider: in a commit message, unlike in a patch sent by e-mail, a
  // line of three dashes does not end the message.
  return git(['interpret-trailers', '--parse', '--no-divider'], message)
    .split('\n')
    .filter((line) => /^signed-off-by: /i.test(line))
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
}

// Name and address come from the commit and so from the pull request. Git
// keeps characters such as a carriage return in them, and the runner reads
// a line that starts after one as a command (::). Every control and format
// character is therefore replaced before the identity is printed.
const visible = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');

const missing = (commit: string, author: Identity): string =>
  `Commit ${commit}: Das Sign-off von «${visible(author.name)} <${visible(author.email)}>» fehlt. ` +
  'Setzen Sie es mit «git commit --signoff», bei bestehenden Commits mit «git rebase --signoff origin/main» und danach «git push --force-with-lease».';

/**
 * Checks every commit that is reachable from `head` but not from `base`.
 *
 * @param base - Commit or branch the changes are based on.
 * @param head - Last commit of the changes.
 * @returns The number of commits and what is missing.
 * @throws {Error} If a Git command fails, for example for an unknown commit.
 */
export function checkRange(base: string, head: string): SignOffReport {
  const commits = git(['rev-list', '--reverse', head, '--not', base])
    .split('\n')
    .filter((line) => line !== '');
  const problems: string[] = [];
  for (const commit of commits) {
    const [parents = '', name = '', email = '', message = ''] = git([
      'log',
      '-1',
      '--format=%P%x00%an%x00%ae%x00%B',
      commit,
    ]).split('\0');
    const short = commit.slice(0, 12);
    if (
      parents.split(' ').length === 2 &&
      git(['show', '--remerge-diff', '--format=', commit]).trim() === ''
    ) {
      continue;
    }
    const author = { name, email };
    if (!isSignedOffBy(signOffs(message), author)) {
      problems.push(missing(short, author));
    }
  }
  return { checked: commits.length, problems };
}

/**
 * Checks a commit message against the author of the commit being made.
 * While a merge is in progress the message is not checked; the check of
 * the range decides about the merge commit.
 *
 * @param file - Path of the message file that Git passes to the hook.
 * @returns What is missing.
 * @throws {Error} If Git names no author or a Git command fails.
 */
export function checkMessageFile(file: string): SignOffReport {
  const merging =
    spawnSync('git', ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], {
      encoding: 'utf8',
    }).status === 0;
  if (merging) {
    return { checked: 0, problems: [] };
  }
  const author = parseIdentity(git(['var', 'GIT_AUTHOR_IDENT']));
  if (author === undefined) {
    throw new Error('Git nennt keine Autorin und keinen Autor für den Commit.');
  }
  const message = storedMessage(readFileSync(file, 'utf8'));
  return {
    checked: 1,
    problems: isSignedOffBy(signOffs(message), author)
      ? []
      : [missing('(neu)', author)],
  };
}

function main(): number {
  const [mode, ...args] = process.argv.slice(2);
  let report: SignOffReport;
  try {
    if (mode === '--range' && args.length === 2) {
      report = checkRange(args[0] ?? '', args[1] ?? '');
    } else if (mode === '--message-file' && args.length === 1) {
      report = checkMessageFile(args[0] ?? '');
    } else {
      console.error(
        'Aufruf: node scripts/ci/check-dco.mts --range <Basis> <Ende> | --message-file <Datei>',
      );
      return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  for (const problem of report.problems) {
    console.error(problem);
  }
  console.log(
    `Sign-offs geprüft: ${String(report.checked)} ${report.checked === 1 ? 'Commit' : 'Commits'}, ${String(report.problems.length)} ohne Sign-off der Autorin oder des Autors.`,
  );
  return report.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
