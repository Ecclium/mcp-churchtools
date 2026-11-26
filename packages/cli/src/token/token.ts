/**
 * `ecclium token` (ADR 0074): the static bearer tokens of the server over
 * HTTP. `create` makes a token and enters its hash, `rotate` makes a new
 * token for a name and lets the old ones hold seven more days at most,
 * `revoke` removes every entry of a name, and `list` shows the entries.
 *
 * A token appears once, alone on stdout, so that `> file` takes it without
 * a text; every other line goes to stderr. It appears only after its hash
 * is in the file: a token that is shown always works. No text repeats an
 * argument before it passed its check, and no output names a hash.
 *
 * The exit codes follow sysexits: 0 when done, 64 for a wrong call, 65
 * when the file has the name already, lacks it or is full, 66 when the
 * file is missing for a command that changes or lists it, 74 when it could
 * not be read or written or the token could not be shown, 75 when it
 * changed while the command ran, 78 for an invalid configuration or a
 * file of another form or with other rights.
 *
 * @packageDocumentation
 */
import {
  addDays,
  bearerRotationDays,
  type BearerScope,
  type BearerTokenEntry,
  type BearerTokensCode,
  type ConfigFileSystem,
  createBearerToken,
  defaultBearerTokenDays,
  hashBearerToken,
  isBearerTokenName,
  loadTokenCommandConfig,
  maxBearerTokenDays,
  maxBearerTokens,
  readBearerTokensFile,
  serializeBearerTokens,
} from '@ecclium/mcp-churchtools-core';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { problemLines } from '../commands/audit-texts.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import type { Output } from '../output/index.js';
import {
  createdText,
  germanDay,
  listHeader,
  revokedText,
  rotatedText,
  stateText,
  tokensFileText,
  tokenTexts,
} from './texts.js';
import {
  type FileIdentity,
  identityOf,
  nodeWriterFileSystem,
  sameIdentity,
  type WriteOutcome,
  type WriterFileSystem,
  writeTokensFile,
} from './write.js';

/** What `ecclium token` does. */
export type TokenAction = 'create' | 'rotate' | 'revoke' | 'list';

/** What `ecclium token` needs, with replacements for tests. */
export interface TokenOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  readonly action: TokenAction;
  /** The name as given, for every action but `list`. */
  readonly name?: string | undefined;
  /** Whether `--write` was given, for `create`. */
  readonly write?: boolean | undefined;
  /** The value of `--days` as given, for `create` and `rotate`. */
  readonly days?: string | undefined;
  readonly output: Output;
  /** Replaces the clock of the system, for tests. */
  readonly clock?: Clock | undefined;
  /** Replaces the source of randomness of a token, for tests. */
  readonly random?: ((size: number) => Uint8Array) | undefined;
  /** Replaces the file functions of the reader, for tests. */
  readonly readFiles?: ConfigFileSystem | undefined;
  /** Replaces the file functions of the writer, for tests. */
  readonly writeFiles?: WriterFileSystem | undefined;
}

const systemTime: Clock = Object.freeze({ now: () => Date.now() });

// A whole number of days from 1 to 365, written without sign or leading
// zero, so that the value means one thing only.
const daysPattern = /^[1-9][0-9]{0,2}$/;

const daysOf = (value: string | undefined): number | undefined => {
  if (value === undefined) return defaultBearerTokenDays;
  if (!daysPattern.test(value)) return undefined;
  const days = Number(value);
  return days <= maxBearerTokenDays ? days : undefined;
};

const dayOf = (milliseconds: number): string =>
  new Date(milliseconds).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );

// The exit code of a file the command could not read.
const readExitCode = (code: BearerTokensCode): ExitCode => {
  if (code === 'bearer_tokens_file_missing') return exitCodes.noInput;
  if (code === 'bearer_tokens_file_unreadable') return exitCodes.ioError;
  return exitCodes.invalidConfig;
};

const writeExitCode: Readonly<
  Record<Exclude<WriteOutcome, 'written'>, ExitCode>
> = Object.freeze({
  changed: exitCodes.tempFail,
  unsafe: exitCodes.invalidConfig,
  unavailable: exitCodes.ioError,
});

const writeText: Readonly<Record<Exclude<WriteOutcome, 'written'>, string>> =
  Object.freeze({
    changed: tokenTexts.changed,
    unsafe: tokenTexts.unsafeFolder,
    unavailable: tokenTexts.unavailable,
  });

// The last entry of a name: the one that holds longest.
const newestOf = (
  entries: readonly BearerTokenEntry[],
): BearerTokenEntry | undefined =>
  entries.reduce<BearerTokenEntry | undefined>(
    (newest, entry) =>
      newest === undefined || entry.expiresAt > newest.expiresAt
        ? entry
        : newest,
    undefined,
  );

const pad = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - text.length));

// The table of `list`, one line per entry, sorted by name and days.
const tableOf = (
  entries: readonly BearerTokenEntry[],
  today: string,
): readonly string[] => {
  const rows = [...entries]
    .sort(
      (left, right) =>
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
        (left.expiresAt < right.expiresAt ? -1 : 1),
    )
    .map((entry) => [
      entry.name,
      entry.scopes.join(','),
      germanDay(entry.createdAt),
      germanDay(entry.expiresAt),
      stateText(daysBetween(today, entry.expiresAt)),
    ]);
  const all = [listHeader, ...rows];
  const widths = listHeader.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? '').length)),
  );
  return all.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : pad(cell, widths[column] ?? 0),
      )
      .join('  '),
  );
};

/**
 * Runs `ecclium token`.
 *
 * @param options - The action, its arguments, the environment and the
 *   output.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * runToken({ environment, action: 'create', name: 'claude-code-buero', output });
 * ```
 */
export function runToken(options: TokenOptions): ExitCode {
  const { output, action } = options;

  // The call first: nothing is loaded or read for a wrong one.
  const name = options.name;
  if (action !== 'list' && !isBearerTokenName(name)) {
    output.stderr(tokenTexts.nameInvalid);
    return exitCodes.usage;
  }
  const days = daysOf(options.days);
  if (days === undefined) {
    output.stderr(tokenTexts.daysInvalid);
    return exitCodes.usage;
  }

  const loaded = loadTokenCommandConfig({ environment: options.environment });
  if (!loaded.ok) {
    for (const line of problemLines(loaded.problems, loaded.omittedProblems)) {
      output.stderr(line);
    }
    return exitCodes.invalidConfig;
  }
  const path = loaded.config.httpTokensFile;
  const writeFiles = options.writeFiles ?? nodeWriterFileSystem;
  const today = dayOf((options.clock ?? systemTime).now());

  // What the file is before and after the read: a change in between would
  // make the entries read a mix of two files.
  const before: FileIdentity | undefined = identityOf(path, writeFiles);
  const read = readBearerTokensFile(path, options.readFiles);
  const after: FileIdentity | undefined = identityOf(path, writeFiles);
  const missing = !read.ok && read.code === 'bearer_tokens_file_missing';
  if ((read.ok || missing) && !sameIdentity(before, after)) {
    output.stderr(tokenTexts.changed);
    return exitCodes.tempFail;
  }
  let entries: readonly BearerTokenEntry[];
  if (read.ok) {
    entries = read.entries;
  } else if (missing && action === 'create') {
    entries = [];
  } else {
    output.stderr(
      read.code === 'bearer_tokens_file_missing' && action !== 'list'
        ? tokenTexts.missingForChange
        : tokensFileText(read.code, read.field, read.line),
    );
    return readExitCode(read.code);
  }

  if (action === 'list') {
    if (entries.length === 0) {
      output.stdout(tokenTexts.empty);
      return exitCodes.ok;
    }
    for (const line of tableOf(entries, today)) output.stdout(line);
    return exitCodes.ok;
  }

  // From here on the name passed its check.
  const checkedName = name as string;
  const own = entries.filter((entry) => entry.name === checkedName);
  const others = entries.filter((entry) => entry.name !== checkedName);

  let next: BearerTokenEntry[];
  let token: string | undefined;
  let scopes: readonly BearerScope[] = ['read'];
  // The last day of the old tokens of the name, after the rotation.
  let oldUntil = '';
  switch (action) {
    case 'create':
    case 'rotate': {
      if (action === 'create' && own.length > 0) {
        output.stderr(tokenTexts.nameTaken);
        return exitCodes.dataError;
      }
      const newest = newestOf(own);
      if (action === 'rotate' && newest === undefined) {
        output.stderr(tokenTexts.nameUnknown);
        return exitCodes.dataError;
      }
      if (entries.length >= maxBearerTokens) {
        output.stderr(tokenTexts.full);
        return exitCodes.dataError;
      }
      scopes =
        action === 'create'
          ? options.write === true
            ? ['read', 'write']
            : ['read']
          : (newest?.scopes ?? ['read']);
      // A rotation lets the old tokens hold seven more days at most, never
      // before the day they came into being.
      const limit = addDays(today, bearerRotationDays);
      const kept = own.map((entry) => {
        const until = entry.expiresAt < limit ? entry.expiresAt : limit;
        const expiresAt = until < entry.createdAt ? entry.createdAt : until;
        if (expiresAt > oldUntil) oldUntil = expiresAt;
        return { ...entry, expiresAt };
      });
      token = createBearerToken(options.random);
      next = [
        ...others,
        ...kept,
        {
          name: checkedName,
          sha256: hashBearerToken(token),
          scopes,
          createdAt: today,
          expiresAt: addDays(today, days),
        },
      ];
      break;
    }
    case 'revoke':
      if (own.length === 0) {
        output.stderr(tokenTexts.nameUnknown);
        return exitCodes.dataError;
      }
      next = [...others];
      break;
  }

  // The read passed or found no file, so the file had one identity, the
  // same before and after the read.
  const written = writeTokensFile(
    path,
    serializeBearerTokens(next),
    before as FileIdentity,
    writeFiles,
  );
  if (written !== 'written') {
    output.stderr(writeText[written]);
    return writeExitCode[written];
  }

  if (action === 'revoke') {
    output.stderr(revokedText(checkedName, own.length));
    return exitCodes.ok;
  }
  // The hash is in the file: only now does the token go out.
  if (token === undefined || !output.stdout(token)) {
    output.stderr(tokenTexts.tokenNotShown);
    return exitCodes.ioError;
  }
  const expiresAt = addDays(today, days);
  output.stderr(
    action === 'create'
      ? createdText(checkedName, scopes, expiresAt)
      : rotatedText(
          checkedName,
          expiresAt,
          oldUntil < today ? undefined : oldUntil,
        ),
  );
  return exitCodes.ok;
}
