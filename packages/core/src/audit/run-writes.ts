/**
 * Finds the writes of one run of a routine in the audit files, for
 * `ecclium undo --run` and `ecclium marker adopt --run` (ADR 0029,
 * ADR 0031, ADR 0032).
 *
 * A run writes in two ways: itself, on a line that names the run, or
 * through the approval of an entry it queued. The line of an approval
 * names the entry, not the run; the ID of an entry is the ID of the line
 * with which the run queued it, and that line names the run (ADR 0031).
 * So the approvals are found by joining the two, without a field of the
 * run on the line of an approval.
 *
 * A write counts when it may have changed ChurchTools: `verified`, and
 * `conflict` or `failed`, which may have reached ChurchTools or not. Only
 * the snapshot under its ID tells; a write that sent nothing has none,
 * because the core keeps it right before the one send. Only whole lines
 * that fit the schema of an audit event count, and the chain is not
 * checked: that is `ecclium audit verify`.
 *
 * The other way round, for `ecclium undo` with the ID of one write: the
 * run a write belongs to, so that its undo writes with the account of the
 * routine, as the run did, and never with the token of the server
 * (ADR 0033).
 *
 * @packageDocumentation
 */
import type { WriteState } from '@ecclium/mcp-churchtools-plugin-api';

import type { AuditFolder } from './reader.js';
import { dayOfAuditFile } from './retention.js';
import { runIdFromText } from './run-summary.js';
import { auditEventV1Schema } from './schema.js';
import { isUtcDay } from './summary.js';

/** How a write of a run came about. */
export type AuditRunWriteWay = 'run' | 'approval';

/** One write of a run that may have changed ChurchTools. */
export interface AuditRunWrite {
  /**
   * The ID of the line of the write, under which its snapshot lies and
   * which `ecclium undo` takes.
   */
  readonly eventId: string;
  /** The time of the line, in UTC. */
  readonly ts: string;
  /** Whether the run wrote itself or an approval of its entry did. */
  readonly way: AuditRunWriteWay;
  /** How the write ended: `verified`, `conflict` or `failed`. */
  readonly writeState: WriteState;
}

/** What {@link findRunWrites} found. */
export interface AuditRunWritesFound {
  /** The audit files in the folder. */
  readonly files: number;
  /** The files read whole. */
  readonly read: number;
  /** The files not read whole, other than those gone meanwhile. */
  readonly unread: number;
  /** Whether the folder `audit` changed while it was read. */
  readonly moved: boolean;
  /**
   * The lines in the files read that do not fit the schema, and the
   * pieces of lines too long: any of them may have been a write of the
   * run.
   */
  readonly skipped: number;
  /** The lines that name the run, in the range. */
  readonly lines: number;
  /** The routine of the run, from its first line that names one. */
  readonly routineId?: string;
  /** The time of its first line, in UTC. */
  readonly begin?: string;
  /** The time of its line of the type `run`, if it ended. */
  readonly ended?: string;
  /** Its period, from its line of the type `run`. */
  readonly period?: string;
  /** Its writes, the newest first. */
  readonly written: readonly AuditRunWrite[];
  /**
   * The IDs of the entries it queued with no decision in the range, in
   * the order they were queued.
   */
  readonly undecided: readonly string[];
}

/** Options of {@link findRunWrites}. */
export interface FindRunWritesOptions {
  /** The opened folder `audit`. */
  readonly folder: AuditFolder;
  /** The ID of the run, from {@link runIdFromText}. */
  readonly runId: string;
  /**
   * The first UTC day to read, such as `2026-10-01`. Files of earlier
   * days are not opened.
   */
  readonly since?: string | undefined;
}

// The states of a write that may have changed ChurchTools.
const mayHaveWritten: readonly WriteState[] = Object.freeze([
  'verified',
  'conflict',
  'failed',
]);

const parse = (text: string | undefined): unknown => {
  // A line that is not printable ASCII has no text.
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// In code units, which for times and IDs is the order of time and text.
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Finds the writes of one run from the audit files of the folder. It reads
 * only, through the folder.
 *
 * @param options - The folder, the ID of the run and the first day.
 * @returns What it found, frozen.
 * @throws {TypeError} When the ID is no ID of a run or the day no UTC day.
 * @example
 * ```ts
 * const found = findRunWrites({ folder, runId, since: '2026-10-01' });
 * found.written.map((write) => write.eventId);
 * ```
 */
export function findRunWrites(
  options: FindRunWritesOptions,
): AuditRunWritesFound {
  const { folder, runId, since } = options;
  if (
    runIdFromText(runId) !== runId ||
    (since !== undefined && !isUtcDay(since))
  ) {
    throw new TypeError('The writes of a run need its ID and a day.');
  }
  const written: AuditRunWrite[] = [];
  // The entries the run queued, by ID, with the time of queueing.
  const queued = new Map<string, string>();
  // The approvals that wrote, and every entry with a decision, by ID.
  const approvals = new Map<string, AuditRunWrite>();
  const decided = new Set<string>();
  let lines = 0;
  let skipped = 0;
  let read = 0;
  let unread = 0;
  let moved = false;
  let routineId: string | undefined;
  let begin: string | undefined;
  let ended: string | undefined;
  let period: string | undefined;

  for (const name of folder.names) {
    const day = dayOfAuditFile(name);
    if (since !== undefined && day !== undefined && day < since) continue;
    const outcome = folder.read(name, (line) => {
      // A piece of a line too long for Ecclium counts as a line that could
      // not be read: it may be what is left of a write of the run.
      const parsed = line.piece
        ? undefined
        : auditEventV1Schema.safeParse(parse(line.text));
      if (parsed?.success !== true) {
        skipped += 1;
        return;
      }
      const event = parsed.data;
      if (since !== undefined && event.ts.slice(0, 10) < since) return;
      const { eventId, ts, writeState } = event;
      // The schema gives every line of the type approval its entry and
      // its decision.
      if (event.type === 'approval') {
        const queueId = event.queueId as string;
        decided.add(queueId);
        if (writeState !== undefined && mayHaveWritten.includes(writeState)) {
          approvals.set(
            queueId,
            Object.freeze({ eventId, ts, way: 'approval', writeState }),
          );
        }
        return;
      }
      if (event.runId !== runId) return;
      lines += 1;
      if (begin === undefined || ts < begin) begin = ts;
      routineId ??= event.routineId;
      if (event.type === 'run') {
        // The last end counts, should a run have two.
        if (ended === undefined || ts > ended) {
          ended = ts;
          period = event.period;
        }
        return;
      }
      if (event.type !== 'tool_call' || writeState === undefined) return;
      if (writeState === 'queued') {
        queued.set(eventId, ts);
      } else if (mayHaveWritten.includes(writeState)) {
        written.push(Object.freeze({ eventId, ts, way: 'run', writeState }));
      }
    });
    if (outcome === 'moved') {
      moved = true;
      break;
    }
    if (outcome === 'read') read += 1;
    else if (outcome !== 'gone') unread += 1;
  }

  const undecided: string[] = [];
  for (const [queueId] of [...queued].sort(
    ([leftId, left], [rightId, right]) =>
      compareText(left, right) || compareText(leftId, rightId),
  )) {
    const approval = approvals.get(queueId);
    if (approval !== undefined) written.push(approval);
    if (!decided.has(queueId)) undecided.push(queueId);
  }
  written.sort(
    (left, right) =>
      compareText(right.ts, left.ts) ||
      compareText(right.eventId, left.eventId),
  );

  return Object.freeze({
    files: folder.names.length,
    read,
    unread,
    moved,
    skipped,
    lines,
    ...(routineId === undefined ? {} : { routineId }),
    ...(begin === undefined ? {} : { begin }),
    ...(ended === undefined ? {} : { ended }),
    ...(period === undefined ? {} : { period }),
    written: Object.freeze(written),
    undecided: Object.freeze(undecided),
  });
}

/** The run of a routine a line of the audit belongs to. */
export interface AuditRunRef {
  readonly runId: string;
  readonly routineId: string;
}

/**
 * What {@link findRunOfWrite} found: the run of the write, proof that it
 * belongs to none, or that the files cannot tell.
 */
export type AuditRunOfWrite =
  /** The write belongs to this run. */
  | { readonly kind: 'run'; readonly run: AuditRunRef }
  /**
   * The write belongs to no run: its own line names none, and for an
   * approval the line that queued its entry names none either; or no line
   * of the range names the write while every line was read.
   */
  | { readonly kind: 'none' }
  /**
   * The files cannot tell: the line of the write is not found while a
   * file or a line could not be read (`incomplete`), or an approval names
   * an entry whose queueing line is not in the range (`queued_missing`).
   */
  | {
      readonly kind: 'unknown';
      readonly reason: 'incomplete' | 'queued_missing';
    };

/** Options of {@link findRunOfWrite}. */
export interface FindRunOfWriteOptions {
  /** The opened folder `audit`. */
  readonly folder: AuditFolder;
  /** The ID of the line of the write, in lower case. */
  readonly eventId: string;
  /** The first UTC day to read; files of earlier days are not opened. */
  readonly since?: string | undefined;
}

/**
 * Finds the run of a routine a write belongs to, for `ecclium undo` with
 * the ID of one write (ADR 0031): the run its own line names, such as the
 * write of a run or the undo of one, or for an approval, the run whose
 * line queued the entry. It reads only, through the folder.
 *
 * @param options - The folder, the ID of the line and the first day.
 * @returns The run, proof of none, or that the files cannot tell;
 *   frozen.
 * @throws {TypeError} When the ID is no ID of a line or the day no UTC day.
 * @example
 * ```ts
 * const found = findRunOfWrite({ folder, eventId, since });
 * if (found.kind === 'run') found.run.routineId;
 * ```
 */
export function findRunOfWrite(
  options: FindRunOfWriteOptions,
): AuditRunOfWrite {
  const { folder, eventId, since } = options;
  if (
    runIdFromText(eventId) !== eventId ||
    (since !== undefined && !isUtcDay(since))
  ) {
    throw new TypeError('The run of a write needs its ID and a day.');
  }
  // The own line of the write: the run it names, or the entry an approval
  // wrote.
  let own:
    { readonly ref?: AuditRunRef; readonly queueId?: string } | undefined;
  // The lines that queued an entry, by their ID, with the run they name,
  // or null for one of no run.
  const queuedBy = new Map<string, AuditRunRef | null>();
  let complete = true;
  for (const name of folder.names) {
    const day = dayOfAuditFile(name);
    if (since !== undefined && day !== undefined && day < since) continue;
    const outcome = folder.read(name, (line) => {
      const parsed = line.piece
        ? undefined
        : auditEventV1Schema.safeParse(parse(line.text));
      // A line that cannot be read may be the one asked for.
      if (parsed?.success !== true) {
        complete = false;
        return;
      }
      const event = parsed.data;
      if (since !== undefined && event.ts.slice(0, 10) < since) return;
      const ref =
        event.runId !== undefined && event.routineId !== undefined
          ? Object.freeze({ runId: event.runId, routineId: event.routineId })
          : undefined;
      if (event.eventId === eventId) {
        own = {
          ...(ref === undefined ? {} : { ref }),
          ...(event.queueId === undefined ? {} : { queueId: event.queueId }),
        };
      }
      if (event.writeState === 'queued') {
        queuedBy.set(event.eventId, ref ?? null);
      }
    });
    if (outcome === 'moved') {
      complete = false;
      break;
    }
    if (outcome !== 'read' && outcome !== 'gone') complete = false;
  }
  const none: AuditRunOfWrite = Object.freeze({ kind: 'none' });
  const unknown = (reason: 'incomplete' | 'queued_missing'): AuditRunOfWrite =>
    Object.freeze({ kind: 'unknown', reason });
  const runOf = (run: AuditRunRef): AuditRunOfWrite =>
    Object.freeze({ kind: 'run', run });
  const found = own;
  if (found === undefined) return complete ? none : unknown('incomplete');
  if (found.ref !== undefined) return runOf(found.ref);
  if (found.queueId === undefined) return none;
  const queued = queuedBy.get(found.queueId);
  if (queued === undefined) return unknown('queued_missing');
  return queued === null ? none : runOf(queued);
}
