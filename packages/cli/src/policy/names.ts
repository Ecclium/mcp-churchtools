/**
 * The names in the results of the list tools, as `ecclium policy init`
 * reads them (ADR 0024, ADR 0032), and the session in which it reads them:
 * its own audit file, whose anchor goes to the log when it closes.
 *
 * A name stands in the data envelope that the pipeline puts around every
 * text of the tenant. The command takes it out and notes whether the
 * redaction changed it, by removing hidden characters or, in the level
 * strict, by masking a part: such a name is not the one ChurchTools
 * compares, so a proposal never takes it as a match.
 *
 * @packageDocumentation
 */
import {
  type EccliumConfig,
  freeTextMarkers,
} from '@ecclium/mcp-churchtools-core';
import {
  anchorEventOf,
  type AuditFileWriter,
  createLogger,
  createStderrWriter,
  openAuditFile,
  prepareQuotaFolder,
  type StderrLineWriter,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import { auditFileText, quotaFolderText } from '../messages/index.js';
import type { Output } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';

// The data envelope around a name, and the note of the redaction after a
// text it removed hidden characters from.
const envelope = /^<<data-([0-9a-f]{16})>>([\s\S]*)<<\/data-\1>>$/;
const hiddenNote = / \[ecclium: \d+ hidden characters removed\]$/;
const maskMarkers: readonly string[] = Object.freeze(
  Object.values(freeTextMarkers),
);

/** A name as the command line takes it from a result. */
export interface Name {
  readonly text: string;
  /**
   * Whether the redaction changed it: hidden characters removed, or in
   * the level strict a part masked (ADR 0069).
   */
  readonly changed: boolean;
}

/**
 * Takes a name out of its data envelope.
 *
 * @param value - A value of a result.
 * @returns The name, or undefined for a value that is no name in an
 *   envelope.
 * @example
 * ```ts
 * nameOf(entry['name'])?.text;
 * ```
 */
export const nameOf = (value: unknown): Name | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = envelope.exec(value);
  const text = match?.[2];
  if (text === undefined) return undefined;
  return {
    text,
    changed:
      hiddenNote.test(text) ||
      maskMarkers.some((marker) => text.includes(marker)),
  };
};

/**
 * Whether a value is a plain object, read field by field afterwards.
 *
 * @param value - Any value.
 * @returns Whether it is an object that is no array.
 * @example
 * ```ts
 * if (isRecord(data)) read(data['more']);
 * ```
 */
export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One page of a list, as a tool gives it. */
export interface ListPage<T> {
  readonly entries: readonly T[];
  readonly more: boolean;
}

/**
 * Reads one page of the result of a list tool, field by field, with the
 * list under its name; a result of another form gives undefined, and the
 * command writes no proposal then.
 *
 * @param data - The data of the result.
 * @param field - The name of the list, such as `categories`.
 * @param entryOf - Reads one entry, or gives undefined for one of another
 *   form.
 * @returns The page, or undefined.
 * @example
 * ```ts
 * const page = listPageOf(outcome.data, 'categories', categoryOf);
 * ```
 */
export const listPageOf = <T>(
  data: unknown,
  field: string,
  entryOf: (entry: Readonly<Record<string, unknown>>) => T | undefined,
): ListPage<T> | undefined => {
  if (!isRecord(data) || typeof data['more'] !== 'boolean') return undefined;
  const list = data[field];
  if (!Array.isArray(list)) return undefined;
  const entries: T[] = [];
  for (const entry of list as readonly unknown[]) {
    const read = isRecord(entry) ? entryOf(entry) : undefined;
    if (read === undefined) return undefined;
    entries.push(read);
  }
  return { entries, more: data['more'] };
};

/** A category, a calendar or a resource of a list, with its ID. */
export interface NamedEntry {
  readonly id: number;
  readonly name: Name;
}

/**
 * Reads an entry with an ID and a name, as the lists of categories,
 * calendars and resources give it.
 *
 * @param entry - The entry of the list.
 * @returns The ID with the name, or undefined for an entry of another
 *   form.
 * @example
 * ```ts
 * listPageOf(outcome.data, 'categories', namedEntryOf);
 * ```
 */
export const namedEntryOf = (
  entry: Readonly<Record<string, unknown>>,
): NamedEntry | undefined => {
  const id = entry['id'];
  const name = nameOf(entry['name']);
  return typeof id === 'number' && Number.isSafeInteger(id) && name
    ? { id, name }
    : undefined;
};

/** What a reading of the command has open while it asks ChurchTools. */
export interface Reading {
  readonly auditFile: AuditFileWriter;
  readonly writer: StderrLineWriter;
  readonly clock: Clock;
}

/** The result of a reading, or the exit code after a text on stderr. */
export type ReadingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ExitCode };

// The highest count a log line takes.
const maxCount = 1_000_000;

/**
 * Runs a reading with an audit file of its own, as the server would: the
 * folder of the counters prepared, the anchor of the chain on the log when
 * the file closes, and before it the count of lines the file lost
 * (ADR 0028).
 *
 * @param config - The checked configuration.
 * @param stateDir - The folder of state.
 * @param options - The output and the replacement of `writeSync`.
 * @param options.output - Where the texts of a problem go.
 * @param options.writeSync - Replaces `writeSync` of the stderr writer,
 *   for tests.
 * @param read - What the reading does with the file and the writer.
 * @returns What it gave, or 78 after a text on stderr when the audit file
 *   or the folder of the counters cannot be used.
 * @example
 * ```ts
 * const read = await withReading(config, stateDir, options, (reading) => ask(reading));
 * ```
 */
export const withReading = async <T>(
  config: EccliumConfig,
  stateDir: string,
  options: {
    readonly output: Output;
    readonly writeSync?: WriteSyncFn | undefined;
  },
  read: (reading: Reading) => Promise<ReadingResult<T>>,
): Promise<ReadingResult<T>> => {
  const { output } = options;
  const clock = systemClock;
  const opened = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!opened.ok) {
    output.stderr(auditFileText(opened.code));
    return { ok: false, code: exitCodes.invalidConfig };
  }
  const auditFile = opened.writer;
  let closing = (): void => undefined;
  try {
    const prepared = prepareQuotaFolder(stateDir);
    if (!prepared.ok) {
      output.stderr(quotaFolderText(prepared.code));
      return { ok: false, code: exitCodes.invalidConfig };
    }
    const writer = createStderrWriter(
      options.writeSync === undefined ? {} : { writeSync: options.writeSync },
    );
    const processLogger = createLogger({ writer, clock, minLevel: 'info' });
    closing = () => {
      processLogger.info('audit_file_closed', {
        count: Math.min(auditFile.counts().failed, maxCount),
      });
    };
    const anchorLogger = createLogger({
      writer,
      clock,
      minLevel: 'info',
      anchors: true,
    });
    auditFile.attach({
      anchor: (anchor) => {
        const { file, seq, hash } = anchor;
        anchorLogger.info(anchorEventOf(anchor), { file, seq, hash });
      },
      swept: () => undefined,
    });
    return await read({ auditFile, writer, clock });
  } finally {
    closing();
    auditFile.close();
  }
};
