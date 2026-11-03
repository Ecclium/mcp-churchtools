/**
 * Sums up the audit files for `ecclium audit show` (ADR 0028): per UTC day
 * and tool the calls by outcome and the results held back after they were
 * read, the undos of `ecclium undo` in a row of their own (ADR 0031), and,
 * when asked for an ID of an object, the lines that name it.
 *
 * Only whole lines that fit the schema of an audit event count, the others
 * are counted as skipped. The day comes from the time of the line, not
 * from the name of its file, because a file written on after a failed
 * change of day holds lines of later days. It does not check the chain:
 * that is `ecclium audit verify`.
 *
 * @packageDocumentation
 */
import type {
  AuditOutcome,
  AuditType,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { AuditFolder } from './reader.js';
import { auditEventV1Schema, auditFieldSchemas, auditTypes } from './schema.js';

/**
 * Calls of one tool on one UTC day, or the undos of that day, which have no
 * tool (ADR 0031).
 */
export interface AuditDayToolCounts {
  /** The UTC day, such as `2026-10-31`. */
  readonly day: string;
  /** The type of the lines: `tool_call`, or `undo` for the undos. */
  readonly type: AuditType;
  /**
   * The name of the tool, or undefined for a line without one, such as
   * every undo.
   */
  readonly tool: string | undefined;
  /** All calls. */
  readonly calls: number;
  /** Calls with the outcome `ok`. */
  readonly ok: number;
  /** Calls with the outcome `error`. */
  readonly error: number;
  /** Calls with the outcome `denied`. */
  readonly denied: number;
  /** Of the denied calls, those held back after ChurchTools answered. */
  readonly withheld: number;
}

/** One line that names the ID asked for. */
export interface AuditObjectHit {
  /** The time of the line, in UTC. */
  readonly ts: string;
  /** The type of the line: `tool_call`, or `undo` for an undo. */
  readonly type: AuditType;
  /** The name of the tool, or undefined for a line without one. */
  readonly tool: string | undefined;
  /** The ID of the actor, such as `stdio:local-stdio`. */
  readonly actorId: string;
  readonly outcome: AuditOutcome;
  /** Whether the result was held back after it was read. */
  readonly withheld: boolean;
}

/** What {@link summarizeAuditFiles} found. */
export interface AuditSummary {
  /** The audit files in the folder. */
  readonly files: number;
  /** The files read whole. */
  readonly read: number;
  /**
   * The entries with the name of an audit file that failed a check, and
   * the files that could not be read whole.
   */
  readonly unread: number;
  /** Whether the folder `audit` changed while it was read. */
  readonly moved: boolean;
  /** The whole lines that fit the schema, in the range of days. */
  readonly lines: number;
  /** The whole lines that do not fit the schema, in any range. */
  readonly skipped: number;
  /**
   * The writes confirmed by echo, in the range of days: a weaker way than a
   * question or the operator, which an operator should see on its own
   * (ADR 0029).
   */
  readonly echoConfirmed: number;
  /**
   * The calls per day and tool, sorted by day, then tool, with the undos
   * of a day after its calls.
   */
  readonly rows: readonly AuditDayToolCounts[];
  /** The first {@link maxShownHits} lines that name the ID, by time. */
  readonly hits: readonly AuditObjectHit[];
  /** The lines beyond them that name the ID. */
  readonly hitsOmitted: number;
  /**
   * The lines that do not name the ID but left IDs out beyond the first
   * 100, so that the ID can be among those left out.
   */
  readonly partial: number;
}

/** Options of {@link summarizeAuditFiles}. */
export interface AuditSummaryOptions {
  /** The opened folder `audit`. */
  readonly folder: AuditFolder;
  /** The first UTC day to count, such as `2026-10-01`. */
  readonly since?: string | undefined;
  /** The last UTC day to count. */
  readonly until?: string | undefined;
  /** The ID to look for, such as `person:12`, from `objectRefFromText`. */
  readonly object?: string | undefined;
}

/** The most lines that name an ID a summary lists. */
export const maxShownHits = 1_000;

// The most hits kept for sorting; beyond them only counted.
const maxKeptHits = 100_000;

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tells whether a value is a UTC day as `YYYY-MM-DD` that exists, such as
 * `2026-02-28` and not `2026-02-30`.
 *
 * @param value - Any value.
 * @returns Whether it is such a day.
 * @example
 * ```ts
 * isUtcDay('2028-02-29'); // true
 * isUtcDay('2026-02-29'); // false
 * ```
 */
export function isUtcDay(value: unknown): value is string {
  if (typeof value !== 'string' || !dayPattern.test(value)) return false;
  const time = Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
  );
  // Date.UTC moves a day that does not exist into the next month, and maps
  // the years 0 to 99 to 1900 and later.
  return new Date(time).toISOString().slice(0, 10) === value;
}

/** The counts of one day and tool while they grow. */
interface Counts {
  day: string;
  type: AuditType;
  tool: string | undefined;
  calls: number;
  ok: number;
  error: number;
  denied: number;
  withheld: number;
}

// In code units, which for days, times and tool names of ASCII is the
// order of time and of the alphabet.
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// The undos of a day after its calls, as auditTypes orders them.
const compareType = (left: AuditType, right: AuditType): number =>
  auditTypes.indexOf(left) - auditTypes.indexOf(right);

// Lines without a tool after the tools. A day has one row per type and
// tool, so two rows of a day and type never both lack one.
const compareTool = (
  left: string | undefined,
  right: string | undefined,
): number => {
  if (left === undefined) return 1;
  return right === undefined ? -1 : compareText(left, right);
};

const parse = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Sums up the audit files of the folder, in the range of days if given,
 * and looks for an ID of an object if given. It reads only, through the
 * folder.
 *
 * @param options - The folder, the range of days and the ID.
 * @returns The summary, frozen.
 * @throws {TypeError} When a day is no UTC day or the ID has no form of
 *   an entry of `objectRefs`.
 * @example
 * ```ts
 * const summary = summarizeAuditFiles({ folder, object: 'person:12' });
 * ```
 */
export function summarizeAuditFiles(
  options: AuditSummaryOptions,
): AuditSummary {
  const { folder, since, until, object } = options;
  if (
    (since !== undefined && !isUtcDay(since)) ||
    (until !== undefined && !isUtcDay(until)) ||
    (object !== undefined &&
      !auditFieldSchemas.objectRef.safeParse(object).success)
  ) {
    throw new TypeError('The summary needs days and an ID of their form.');
  }
  const counts = new Map<string, Counts>();
  const hits: AuditObjectHit[] = [];
  let hitCount = 0;
  let partial = 0;
  let lines = 0;
  let skipped = 0;
  let echoConfirmed = 0;
  let read = 0;
  let unread = 0;
  let moved = false;

  for (const name of folder.names) {
    const outcome = folder.read(name, (line) => {
      if (line.piece) return;
      const parsed = auditEventV1Schema.safeParse(parse(line.text));
      if (!parsed.success) {
        skipped += 1;
        return;
      }
      const event = parsed.data;
      const day = event.ts.slice(0, 10);
      if (
        (since !== undefined && day < since) ||
        (until !== undefined && day > until)
      ) {
        return;
      }
      lines += 1;
      if (event.confirmation === 'echo' && event.writeState === 'verified') {
        echoConfirmed += 1;
      }
      const withheld = event.withheldAfterRead === true;
      // A type and a tool name hold no space, so the key is unique per
      // day, type and tool. An undo has no tool and gets a row of its own
      // (ADR 0031).
      const key = `${day} ${event.type} ${event.tool ?? ''}`;
      let row = counts.get(key);
      if (row === undefined) {
        row = {
          day,
          type: event.type,
          tool: event.tool,
          calls: 0,
          ok: 0,
          error: 0,
          denied: 0,
          withheld: 0,
        };
        counts.set(key, row);
      }
      row.calls += 1;
      row[event.outcome] += 1;
      if (withheld) row.withheld += 1;
      if (object === undefined) return;
      if (event.objectRefs.includes(object)) {
        hitCount += 1;
        if (hits.length < maxKeptHits) {
          hits.push(
            Object.freeze({
              ts: event.ts,
              type: event.type,
              tool: event.tool,
              actorId: event.actor.id,
              outcome: event.outcome,
              withheld,
            }),
          );
        }
      } else if (event.objectRefsOmitted !== undefined) {
        partial += 1;
      }
    });
    if (outcome === 'moved') {
      moved = true;
      break;
    }
    if (outcome === 'read') read += 1;
    else if (outcome !== 'gone') unread += 1;
  }

  const rows = [...counts.values()]
    .map((row): AuditDayToolCounts => Object.freeze(row))
    .sort(
      (left, right) =>
        compareText(left.day, right.day) ||
        compareType(left.type, right.type) ||
        compareTool(left.tool, right.tool),
    );
  // A stable sort keeps lines of the same time in the order of the files.
  const shown = hits
    .sort((left, right) => compareText(left.ts, right.ts))
    .slice(0, maxShownHits);

  return Object.freeze({
    files: folder.names.length,
    read,
    unread,
    moved,
    lines,
    skipped,
    echoConfirmed,
    rows: Object.freeze(rows),
    hits: Object.freeze(shown),
    hitsOmitted: hitCount - shown.length,
    partial,
  });
}
