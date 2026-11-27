/**
 * `ecclium token` (ADR 0074): the static bearer tokens of the server over
 * HTTP. `create` makes a token and enters its hash, `rotate` makes a new
 * token for a name and lets the old ones hold seven more days at most and
 * never longer than the new one, removing those that expired already,
 * `revoke` removes every entry of a name, and `list` shows the entries.
 * A command that changes the file holds a lock beside it from before its
 * read until after its write.
 *
 * `list` names the day each token was last used when `ECCLIUM_STATE_DIR`
 * is set, from the store of quotas in which the server notes it, and
 * «unbekannt» otherwise; it never creates a folder there.
 *
 * A token appears once, alone on stdout, so that `> file` takes it without
 * a text; every other line goes to stderr. It appears only after its hash
 * is in the file: a token that is shown always works. No text repeats an
 * argument before it passed its check, and no output names a hash.
 *
 * The exit codes follow sysexits: 0 when done, 64 for a wrong call, 65
 * when the file has the name already, lacks it or is full, 66 when the
 * file is missing for a command that changes or lists it, 74 when it could
 * not be read or written or the token could not be shown, 75 when another
 * command holds the lock or the file changed while the command ran, 78
 * for an invalid configuration or a file or folder of another form or
 * with other rights.
 *
 * @packageDocumentation
 */
import { hostname } from 'node:os';

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
  readBearerLastUse,
  readBearerTokensFile,
  serializeBearerTokens,
} from '@ecclium/mcp-churchtools-core';
import { createFileQuotaStore } from '@ecclium/mcp-churchtools-core/composition';
import type { Clock, QuotaStore } from '@ecclium/mcp-churchtools-plugin-api';

import { problemLines } from '../commands/audit-texts.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import type { Output } from '../output/index.js';
import {
  createdText,
  germanDay,
  lastUseText,
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
  lockTokensFile,
  nodeWriterFileSystem,
  sameIdentity,
  type TokensLock,
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
  /**
   * Replaces the store of quotas over the folder of state, for tests. It
   * is asked only with `ECCLIUM_STATE_DIR` set.
   */
  readonly lastUseStore?: QuotaStore | undefined;
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

// The youngest entry of a name: the last to come into being, of two on one
// day the one that holds longer. A rotation takes its scopes.
const youngestOf = (
  entries: readonly BearerTokenEntry[],
): BearerTokenEntry | undefined =>
  entries.reduce<BearerTokenEntry | undefined>(
    (youngest, entry) =>
      youngest === undefined ||
      entry.createdAt > youngest.createdAt ||
      (entry.createdAt === youngest.createdAt &&
        entry.expiresAt > youngest.expiresAt)
        ? entry
        : youngest,
    undefined,
  );

type LockRefusal = Exclude<TokensLock, { ok: true }>['reason'];

const lockTexts: Readonly<Record<LockRefusal, string>> = Object.freeze({
  busy: tokenTexts.busy,
  unsafe: tokenTexts.unsafeFolder,
  unavailable: tokenTexts.unavailable,
});

const lockExitCodes: Readonly<Record<LockRefusal, ExitCode>> = Object.freeze({
  busy: exitCodes.tempFail,
  unsafe: exitCodes.invalidConfig,
  unavailable: exitCodes.ioError,
});

const pad = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - text.length));

// The table of `list`, one line per entry, sorted by name and days. The
// last use belongs to the name, so two entries of a rotation share it.
const tableOf = (
  entries: readonly BearerTokenEntry[],
  today: string,
  lastUses: ReadonlyMap<string, string | null>,
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
      lastUseText(lastUses.get(entry.name)),
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
 * await runToken({ environment, action: 'create', name: 'claude-code-buero', output });
 * ```
 */
export async function runToken(options: TokenOptions): Promise<ExitCode> {
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
  const clock = options.clock ?? systemTime;
  const now = clock.now();
  if (action === 'list') {
    const read = readEntries(options, path, writeFiles);
    if (!read.ok) return read.code;
    return listEntries(options, read.entries, dayOf(now), {
      stateDir: loaded.config.stateDir,
      clock,
    });
  }
  // A command that changes the file holds its lock from before the read
  // until after the write, so that no second command undoes its change.
  const lock = lockTokensFile(path, now, writeFiles);
  if (!lock.ok) {
    output.stderr(lockTexts[lock.reason]);
    return lockExitCodes[lock.reason];
  }
  try {
    return onFile({ ...options, action }, days, path, writeFiles, now);
  } finally {
    lock.release();
  }
}

// The entries of the file and its identity before the read, or the exit
// code after the text for the problem.
type EntriesRead =
  | {
      readonly ok: true;
      readonly entries: readonly BearerTokenEntry[];
      readonly before: FileIdentity | undefined;
    }
  | { readonly ok: false; readonly code: ExitCode };

// Reads the file for one command. A missing file holds no entries for
// `create` only.
function readEntries(
  options: TokenOptions,
  path: string,
  writeFiles: WriterFileSystem,
): EntriesRead {
  const { output, action } = options;
  // What the file is before and after the read: a change in between would
  // make the entries read a mix of two files.
  const before: FileIdentity | undefined = identityOf(path, writeFiles);
  const read = readBearerTokensFile(path, options.readFiles);
  const after: FileIdentity | undefined = identityOf(path, writeFiles);
  const missing = !read.ok && read.code === 'bearer_tokens_file_missing';
  if ((read.ok || missing) && !sameIdentity(before, after)) {
    output.stderr(tokenTexts.changed);
    return { ok: false, code: exitCodes.tempFail };
  }
  if (read.ok) return { ok: true, entries: read.entries, before };
  if (missing && action === 'create') return { ok: true, entries: [], before };
  output.stderr(
    read.code === 'bearer_tokens_file_missing' && action !== 'list'
      ? tokenTexts.missingForChange
      : tokensFileText(read.code, read.field, read.line),
  );
  return { ok: false, code: readExitCode(read.code) };
}

// `list`: the table, with the day each name was last used, which the
// server keeps in the store of quotas of its folder of state (ADR 0074).
// The store is opened for reading only and never creates its folder; a
// name it cannot read counts as unknown, and the command still lists.
async function listEntries(
  options: TokenOptions,
  entries: readonly BearerTokenEntry[],
  today: string,
  where: { readonly stateDir: string | undefined; readonly clock: Clock },
): Promise<ExitCode> {
  const { output } = options;
  if (entries.length === 0) {
    output.stdout(tokenTexts.empty);
    return exitCodes.ok;
  }
  const lastUses = new Map<string, string | null>();
  if (where.stateDir !== undefined) {
    let store: QuotaStore | undefined = options.lastUseStore;
    try {
      store ??= createFileQuotaStore({
        stateDir: where.stateDir,
        clock: where.clock,
        pid: process.pid,
        host: hostname(),
      });
    } catch {
      store = undefined;
    }
    for (const name of new Set(entries.map((entry) => entry.name))) {
      if (store === undefined) break;
      try {
        lastUses.set(name, (await readBearerLastUse(store, name)) ?? null);
      } catch {
        // Unknown for this name; the others may still read.
      }
    }
  }
  for (const line of tableOf(entries, today, lastUses)) output.stdout(line);
  return exitCodes.ok;
}

// The read, the change and the write of one command that changes the file,
// under its lock. The name and the days passed their checks.
function onFile(
  options: TokenOptions & {
    readonly action: Exclude<TokenAction, 'list'>;
  },
  days: number,
  path: string,
  writeFiles: WriterFileSystem,
  now: number,
): ExitCode {
  const { output, action, name } = options;
  const today = dayOf(now);

  const read = readEntries(options, path, writeFiles);
  if (!read.ok) return read.code;
  const { entries, before } = read;

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
      const youngest = youngestOf(own);
      if (action === 'rotate' && youngest === undefined) {
        output.stderr(tokenTexts.nameUnknown);
        return exitCodes.dataError;
      }
      scopes =
        action === 'create'
          ? options.write === true
            ? ['read', 'write']
            : ['read']
          : (youngest?.scopes ?? ['read']);
      const expiresAt = addDays(today, days);
      // A rotation lets the old tokens hold seven more days at most and
      // never longer than the new one, never before the day they came
      // into being. An old token that has expired can never hold again,
      // so it leaves the file, which would fill up otherwise.
      const sevenDays = addDays(today, bearerRotationDays);
      const limit = sevenDays < expiresAt ? sevenDays : expiresAt;
      const kept = own
        .filter((entry) => entry.expiresAt >= today)
        .map((entry) => {
          const until = entry.expiresAt < limit ? entry.expiresAt : limit;
          const last = until < entry.createdAt ? entry.createdAt : until;
          if (last > oldUntil) oldUntil = last;
          return { ...entry, expiresAt: last };
        });
      if (others.length + kept.length >= maxBearerTokens) {
        output.stderr(tokenTexts.full);
        return exitCodes.dataError;
      }
      token = createBearerToken(options.random);
      next = [
        ...others,
        ...kept,
        {
          name: checkedName,
          sha256: hashBearerToken(token),
          scopes,
          createdAt: today,
          expiresAt,
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
          oldUntil === '' ? undefined : oldUntil,
        ),
  );
  return exitCodes.ok;
}
