/**
 * Sums up one run of a routine for `ecclium audit show --run` (ADR 0028,
 * ADR 0033): its routine, period, try, begin and end, how it ended from
 * its line of the type `run`, its reads per tool and its writes per way of
 * confirmation and state.
 *
 * Only whole lines that fit the schema of an audit event and name the run
 * count. The lines of a run can stand in two files, when a new UTC day
 * began while it ran. A run that did not end, because it still runs or
 * its process ended at once, has no line of the type `run`. The decision
 * of the operator about a write a run queued is a line of its own, with
 * the entry of the queue and without the run (ADR 0031); the ID of the
 * entry is the ID of the line with which the run queued it, so the two are
 * joined here. An undo of a write of the run names the run on its line.
 * It does not check the chain: that is `ecclium audit verify`.
 *
 * @packageDocumentation
 */
import type {
  AuditOutcome,
  AuditRunResult,
  AuditRunStep,
  QueueDecisionKind,
  ConfirmationPath,
  ContentViolationKind,
  ErrorCode,
  WriteState,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { AuditFolder } from './reader.js';
import { auditEventV1Schema, auditFieldSchemas } from './schema.js';
import { isUtcDay } from './summary.js';

/** The reads of one tool in a run, by outcome. */
export interface AuditRunReads {
  readonly tool: string;
  readonly calls: number;
  readonly ok: number;
  readonly error: number;
  readonly denied: number;
  /** Of the denied reads, those held back after ChurchTools answered. */
  readonly withheld: number;
}

/** The writes of one tool in a run with one way and one state. */
export interface AuditRunWrites {
  readonly tool: string;
  /** How the write was confirmed; none for a write refused before. */
  readonly confirmation?: ConfirmationPath;
  /** Where the write ended, such as `verified` or `queued`. */
  readonly writeState: WriteState;
  readonly count: number;
}

/**
 * The decisions of the operator about the entries a run queued, with one
 * decision and, for an approval, the state of its write.
 */
export interface AuditRunDecisions {
  readonly decision: QueueDecisionKind;
  /** Where the write of an approval ended; none for a rejection. */
  readonly writeState?: WriteState;
  readonly count: number;
}

/** The undos of writes of a run, with one state. */
export interface AuditRunUndos {
  /** Where the undo ended, such as `verified` or `skipped`. */
  readonly writeState: WriteState;
  readonly count: number;
}

/** How a run ended, from its line of the type `run`. */
export interface AuditRunEnd {
  /** The time of the line, in UTC. */
  readonly ts: string;
  readonly result: AuditRunResult;
  readonly outcome: AuditOutcome;
  readonly step?: AuditRunStep;
  readonly errorCode?: ErrorCode;
  readonly contentViolations?: readonly ContentViolationKind[];
  /** Which try of its trigger the run was; none by hand or a preview. */
  readonly attempt?: number;
  readonly period?: string;
  readonly durationMs: number;
}

/** What {@link summarizeRun} found. */
export interface AuditRunSummary {
  /** The audit files in the folder. */
  readonly files: number;
  /** The files read whole. */
  readonly read: number;
  /** The entries that failed a check and the files not read whole. */
  readonly unread: number;
  /** Whether the folder `audit` changed while it was read. */
  readonly moved: boolean;
  /** The whole lines that do not fit the schema, in any range. */
  readonly skipped: number;
  /** The lines that name the run, in the range of days. */
  readonly lines: number;
  /** The routine of the run, from its first line. */
  readonly routineId?: string;
  /** The time of its first line, in UTC. */
  readonly begin?: string;
  /** How it ended, from its last line of the type `run`. */
  readonly end?: AuditRunEnd;
  /** Its reads per tool, sorted by tool. */
  readonly reads: readonly AuditRunReads[];
  /** Its writes per tool, way and state, sorted. */
  readonly writeRows: readonly AuditRunWrites[];
  /** The decisions about the entries it queued, sorted. */
  readonly decisions: readonly AuditRunDecisions[];
  /** The undos of its writes, sorted by state. */
  readonly undos: readonly AuditRunUndos[];
}

/** Options of {@link summarizeRun}. */
export interface AuditRunSummaryOptions {
  /** The opened folder `audit`. */
  readonly folder: AuditFolder;
  /** The ID of the run, from {@link runIdFromText}. */
  readonly runId: string;
  /** The first UTC day to read, such as `2026-11-01`. */
  readonly since?: string | undefined;
  /** The last UTC day to read. */
  readonly until?: string | undefined;
}

/**
 * The ID of a run as the audit writes it, from a text as typed: a UUID,
 * in lower case.
 *
 * @param text - The text, such as the value of `--run`.
 * @returns The ID, or undefined for any other text.
 * @example
 * ```ts
 * runIdFromText('3F2B…'); // '3f2b…'
 * ```
 */
export function runIdFromText(text: string): string | undefined {
  // The length first, so that a huge text never reaches the pattern.
  if (typeof text !== 'string' || text.length !== 36) return undefined;
  const id = text.toLowerCase();
  return auditFieldSchemas.runId.safeParse(id).success ? id : undefined;
}

const parse = (text: string | undefined): unknown => {
  // A line that is not printable ASCII has no text.
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// In code units, which for times, tool names and the closed lists of the
// audit is the order of time and of the alphabet.
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Sums up one run from the audit files of the folder. It reads only,
 * through the folder.
 *
 * @param options - The folder, the ID of the run and the range of days.
 * @returns The summary, frozen.
 * @throws {TypeError} When the ID is no ID of a run or a day no UTC day.
 * @example
 * ```ts
 * const run = summarizeRun({ folder, runId });
 * ```
 */
export function summarizeRun(options: AuditRunSummaryOptions): AuditRunSummary {
  const { folder, runId, since, until } = options;
  if (
    runIdFromText(runId) !== runId ||
    (since !== undefined && !isUtcDay(since)) ||
    (until !== undefined && !isUtcDay(until))
  ) {
    throw new TypeError('The summary of a run needs its ID and days.');
  }
  const reads = new Map<
    string,
    {
      tool: string;
      calls: number;
      ok: number;
      error: number;
      denied: number;
      withheld: number;
    }
  >();
  const writes = new Map<
    string,
    {
      tool: string;
      confirmation?: ConfirmationPath;
      writeState: WriteState;
      count: number;
    }
  >();
  let lines = 0;
  let skipped = 0;
  let read = 0;
  let unread = 0;
  let moved = false;
  let routineId: string | undefined;
  let begin: string | undefined;
  let end: AuditRunEnd | undefined;
  // The entries the run queued, the decisions about any entry by its ID,
  // and the undos of its writes by state.
  const queued = new Set<string>();
  const decisionsOf = new Map<
    string,
    { readonly decision: QueueDecisionKind; readonly writeState?: WriteState }[]
  >();
  const undos = new Map<WriteState, number>();

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
      // The schema gives every line of the type approval its entry and its
      // decision; the entry is joined with the run below.
      if (event.type === 'approval') {
        const queueId = event.queueId as string;
        const decided = decisionsOf.get(queueId) ?? [];
        decided.push({
          decision: event.decision as QueueDecisionKind,
          ...(event.writeState === undefined
            ? {}
            : { writeState: event.writeState }),
        });
        decisionsOf.set(queueId, decided);
        return;
      }
      if (event.runId !== runId) return;
      lines += 1;
      if (begin === undefined || event.ts < begin) begin = event.ts;
      routineId ??= event.routineId;
      // The pipeline gives every line of an undo the state it ended in.
      if (event.type === 'undo') {
        if (event.writeState !== undefined) {
          undos.set(event.writeState, (undos.get(event.writeState) ?? 0) + 1);
        }
        return;
      }
      // The schema gives every line of the type run a result.
      if (event.type === 'run' && event.runResult !== undefined) {
        // The last end counts, should a run have two.
        if (end !== undefined && end.ts > event.ts) return;
        end = Object.freeze({
          ts: event.ts,
          result: event.runResult,
          outcome: event.outcome,
          ...(event.runStep === undefined ? {} : { step: event.runStep }),
          ...(event.errorCode === undefined
            ? {}
            : { errorCode: event.errorCode }),
          ...(event.contentViolations === undefined
            ? {}
            : {
                contentViolations: Object.freeze([...event.contentViolations]),
              }),
          ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
          ...(event.period === undefined ? {} : { period: event.period }),
          durationMs: event.durationMs,
        });
        return;
      }
      if (event.type !== 'tool_call' || event.tool === undefined) return;
      const { tool, writeState, confirmation } = event;
      if (writeState === undefined) {
        let row = reads.get(tool);
        if (row === undefined) {
          row = { tool, calls: 0, ok: 0, error: 0, denied: 0, withheld: 0 };
          reads.set(tool, row);
        }
        row.calls += 1;
        row[event.outcome] += 1;
        if (event.withheldAfterRead === true) row.withheld += 1;
        return;
      }
      // A tool name, a way and a state hold no space, so the key is unique.
      const key = `${tool} ${confirmation ?? ''} ${writeState}`;
      let row = writes.get(key);
      if (row === undefined) {
        row = {
          tool,
          ...(confirmation === undefined ? {} : { confirmation }),
          writeState,
          count: 0,
        };
        writes.set(key, row);
      }
      row.count += 1;
      if (writeState === 'queued') queued.add(event.eventId);
    });
    if (outcome === 'moved') {
      moved = true;
      break;
    }
    if (outcome === 'read') read += 1;
    else if (outcome !== 'gone') unread += 1;
  }

  // A decision and a state hold no space, so the key is unique.
  const decisions = new Map<string, AuditRunDecisions>();
  for (const queueId of queued) {
    for (const { decision, writeState } of decisionsOf.get(queueId) ?? []) {
      const key = `${decision} ${writeState ?? ''}`;
      decisions.set(
        key,
        Object.freeze({
          decision,
          ...(writeState === undefined ? {} : { writeState }),
          count: (decisions.get(key)?.count ?? 0) + 1,
        }),
      );
    }
  }

  return Object.freeze({
    files: folder.names.length,
    read,
    unread,
    moved,
    skipped,
    lines,
    ...(routineId === undefined ? {} : { routineId }),
    ...(begin === undefined ? {} : { begin }),
    ...(end === undefined ? {} : { end }),
    reads: Object.freeze(
      [...reads.values()]
        .sort((left, right) => compareText(left.tool, right.tool))
        .map((row): AuditRunReads => Object.freeze(row)),
    ),
    writeRows: Object.freeze(
      [...writes.values()]
        .sort(
          (left, right) =>
            compareText(left.tool, right.tool) ||
            compareText(left.confirmation ?? '', right.confirmation ?? '') ||
            compareText(left.writeState, right.writeState),
        )
        .map((row): AuditRunWrites => Object.freeze(row)),
    ),
    // By decision, then by state, as the key holds both in this order.
    decisions: Object.freeze(
      [...decisions]
        .sort(([left], [right]) => compareText(left, right))
        .map(([, row]) => row),
    ),
    undos: Object.freeze(
      [...undos]
        .sort(([left], [right]) => compareText(left, right))
        .map(([writeState, count]): AuditRunUndos =>
          Object.freeze({ writeState, count }),
        ),
    ),
  });
}
