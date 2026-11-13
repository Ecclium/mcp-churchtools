import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AuditFileRead, AuditFolder, AuditLine } from './reader.js';
import { runIdFromText, summarizeRun } from './run-summary.js';

// One run of a routine in the audit files, from synthetic lines. All data
// are made up.

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const runId = '00000000-0000-4000-8000-0000000000cc';
const otherRun = '00000000-0000-4000-8000-0000000000dd';

const nameOf = (day: string, number: number): string =>
  `audit-${day}-120000-4242-${String(number)}.jsonl`;

let events = 0;

/** A read of the run, with the fields an event needs. */
const event = (fields: Record<string, unknown>): string => {
  events += 1;
  const outcome = fields['outcome'] ?? 'ok';
  return JSON.stringify({
    v: 1,
    eventId: `00000000-0000-4000-8000-${String(events).padStart(12, '0')}`,
    ts: '2026-11-09T05:00:01.000Z',
    type: 'tool_call',
    tenantId: 'default',
    actor: { kind: 'runner', id: 'runner:weekly-report' },
    mode: 'unattended',
    runId,
    routineId: 'weekly-report',
    tool: 'ct_events_list',
    outcome,
    objectRefs: [],
    ...(outcome === 'ok' ? {} : { errorCode: 'upstream' }),
    durationMs: 4,
    ...fields,
  });
};

/** A write of the run. */
const write = (fields: Record<string, unknown> = {}): string =>
  event({
    ts: '2026-11-09T05:00:09.000Z',
    tool: 'ct_wiki_page_append_section',
    writeState: 'verified',
    confirmation: 'policy',
    policyHash: 'a'.repeat(64),
    ...fields,
  });

/** The end of the run. */
const runEnd = (fields: Record<string, unknown> = {}): string =>
  event({
    ts: '2026-11-09T05:00:10.000Z',
    type: 'run',
    tool: undefined,
    runResult: 'written',
    attempt: 1,
    period: '2026-W46',
    durationMs: 9000,
    ...fields,
  });

const line = (text: string, number: number): AuditLine => ({
  number,
  hash: sha256(text),
  text: /^[ -~]*$/u.test(text) ? text : undefined,
  tooLong: false,
  piece: text.endsWith('~'),
});

const folderOf = (
  files: Readonly<Record<string, readonly string[] | AuditFileRead>>,
): AuditFolder => ({
  names: Object.keys(files).sort(),
  others: 0,
  read: (name, onLine) => {
    const file = files[name];
    if (file === undefined) return 'gone';
    if (typeof file === 'string') return file;
    file.forEach((text, index) => {
      onLine(line(text, index + 1));
    });
    return 'read';
  },
});

describe('runIdFromText', () => {
  it('takes a UUID in any case and gives it in lower case', () => {
    expect(runIdFromText(runId)).toBe(runId);
    expect(runIdFromText(runId.toUpperCase())).toBe(runId);
  });

  it.each([
    '',
    'run-alpha',
    `${runId}0`,
    runId.slice(1),
    runId.replace(/-/gu, 'x'),
    'x'.repeat(10_000),
  ])('refuses %j', (text) => {
    expect(runIdFromText(text)).toBeUndefined();
  });
});

describe('summarizeRun', () => {
  it('names routine, begin, end, reads per tool and writes per way and state', () => {
    const summary = summarizeRun({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [
          event({ runId: otherRun }),
          event({ ts: '2026-11-09T05:00:02.000Z' }),
          event({}),
          event({ outcome: 'error' }),
          event({
            tool: 'ct_services_get_assignments',
            outcome: 'denied',
            errorCode: 'policy_denied',
            withheldAfterRead: true,
          }),
          write(),
          write({
            writeState: 'queued',
            confirmation: undefined,
            ts: '2026-11-09T05:00:08.000Z',
          }),
          write({ writeState: 'skipped' }),
          write({ confirmation: 'operator' }),
          runEnd(),
          'not a line of the audit',
        ],
      }),
      runId,
    });
    expect(summary).toEqual({
      files: 1,
      read: 1,
      unread: 0,
      moved: false,
      skipped: 1,
      lines: 9,
      routineId: 'weekly-report',
      begin: '2026-11-09T05:00:01.000Z',
      end: {
        ts: '2026-11-09T05:00:10.000Z',
        result: 'written',
        outcome: 'ok',
        attempt: 1,
        period: '2026-W46',
        durationMs: 9000,
      },
      reads: [
        {
          tool: 'ct_events_list',
          calls: 3,
          ok: 2,
          error: 1,
          denied: 0,
          withheld: 0,
        },
        {
          tool: 'ct_services_get_assignments',
          calls: 1,
          ok: 0,
          error: 0,
          denied: 1,
          withheld: 1,
        },
      ],
      writeRows: [
        { tool: 'ct_wiki_page_append_section', writeState: 'queued', count: 1 },
        {
          tool: 'ct_wiki_page_append_section',
          confirmation: 'operator',
          writeState: 'verified',
          count: 1,
        },
        {
          tool: 'ct_wiki_page_append_section',
          confirmation: 'policy',
          writeState: 'skipped',
          count: 1,
        },
        {
          tool: 'ct_wiki_page_append_section',
          confirmation: 'policy',
          writeState: 'verified',
          count: 1,
        },
      ],
      decisions: [],
      undos: [],
      adoptions: [],
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.reads)).toBe(true);
    expect(Object.isFrozen(summary.writeRows[0])).toBe(true);
    expect(Object.isFrozen(summary.end)).toBe(true);
  });

  it('names the step, code and reasons of a failed run, and a run over two files of two days', () => {
    const summary = summarizeRun({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [event({ ts: '2026-11-09T23:59:59.000Z' })],
        [nameOf('2026-11-10', 1)]: [
          runEnd({
            ts: '2026-11-10T00:00:05.000Z',
            outcome: 'denied',
            errorCode: 'policy_denied',
            runResult: 'failed',
            runStep: 'content',
            contentViolations: ['webAddress'],
            attempt: undefined,
          }),
        ],
      }),
      runId,
    });
    expect(summary.begin).toBe('2026-11-09T23:59:59.000Z');
    expect(summary.end).toEqual({
      ts: '2026-11-10T00:00:05.000Z',
      result: 'failed',
      outcome: 'denied',
      step: 'content',
      errorCode: 'policy_denied',
      contentViolations: ['webAddress'],
      period: '2026-W46',
      durationMs: 9000,
    });
    expect(summary.read).toBe(2);
  });

  it('has no end for a run that did not end, and takes the later of two ends', () => {
    const open = summarizeRun({
      folder: folderOf({ [nameOf('2026-11-09', 1)]: [event({})] }),
      runId,
    });
    expect(open.end).toBeUndefined();
    expect(open.lines).toBe(1);
    const twice = summarizeRun({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [
          runEnd({
            ts: '2026-11-09T05:00:20.000Z',
            runResult: 'unchanged',
            period: undefined,
          }),
          runEnd({ ts: '2026-11-09T05:00:10.000Z' }),
        ],
      }),
      runId,
    });
    expect(twice.end?.result).toBe('unchanged');
    expect(twice.end).not.toHaveProperty('period');
  });

  // A runner without its proxy notes it on the end of each run, and the
  // summary carries it on (ADR 0035).
  it('keeps the note of a runner without its proxy', () => {
    const off = summarizeRun({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [runEnd({ egressOff: true })],
      }),
      runId,
    });
    expect(off.end?.egressOff).toBe(true);
    const on = summarizeRun({
      folder: folderOf({ [nameOf('2026-11-09', 1)]: [runEnd()] }),
      runId,
    });
    expect(on.end).not.toHaveProperty('egressOff');
  });

  it('finds nothing for another run, and leaves out lines outside the days', () => {
    const files = {
      [nameOf('2026-11-09', 1)]: [event({}), runEnd()],
    };
    expect(
      summarizeRun({ folder: folderOf(files), runId: otherRun }),
    ).toMatchObject({ lines: 0, reads: [], writeRows: [] });
    expect(
      summarizeRun({
        folder: folderOf(files),
        runId,
        since: '2026-11-10',
      }).lines,
    ).toBe(0);
    expect(
      summarizeRun({
        folder: folderOf(files),
        runId,
        until: '2026-11-08',
      }).lines,
    ).toBe(0);
    expect(
      summarizeRun({
        folder: folderOf(files),
        runId,
        since: '2026-11-09',
        until: '2026-11-09',
      }).lines,
    ).toBe(2);
  });

  it('counts the adoptions of the section of the run by state, apart from its undos (ADR 0032)', () => {
    const adoption = (fields: Record<string, unknown> = {}): string =>
      event({
        ts: '2026-11-11T08:00:00.000Z',
        type: 'adoption',
        actor: { kind: 'operator', id: 'local-stdio' },
        mode: 'operator',
        tool: undefined,
        writeState: 'verified',
        confirmation: 'operator',
        ...fields,
      });
    const summary = summarizeRun({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [write(), runEnd()],
        [nameOf('2026-11-11', 1)]: [
          adoption({ writeState: 'planned', confirmation: undefined }),
          adoption(),
          adoption({ writeState: 'skipped' }),
          // An adoption for another run is none of this run.
          adoption({ runId: otherRun }),
          // One without a state counts as a line of the run only.
          adoption({ writeState: undefined, confirmation: undefined }),
        ],
      }),
      runId,
    });
    expect(summary.adoptions).toEqual([
      { writeState: 'planned', count: 1 },
      { writeState: 'skipped', count: 1 },
      { writeState: 'verified', count: 1 },
    ]);
    expect(summary.undos).toEqual([]);
    expect(summary.writeRows).toHaveLength(1);
    // The write, the end and the four adoptions of this run.
    expect(summary.lines).toBe(6);
    expect(Object.isFrozen(summary.adoptions)).toBe(true);
    expect(Object.isFrozen(summary.adoptions[0])).toBe(true);
  });

  it('joins the decisions about the entries the run queued, and counts the undos of its writes', () => {
    const idIn = (text: string): string =>
      (JSON.parse(text) as { eventId: string }).eventId;
    const queuedWrite = (): string =>
      write({ writeState: 'queued', confirmation: undefined });
    const approvedOnce = queuedWrite();
    const approvedTwice = queuedWrite();
    const rejected = queuedWrite();
    const waiting = queuedWrite();
    const decision = (
      queueId: string,
      fields: Record<string, unknown> = {},
    ): string =>
      event({
        ts: '2026-11-10T08:00:00.000Z',
        type: 'approval',
        actor: { kind: 'operator', id: 'local-stdio' },
        mode: 'operator',
        runId: undefined,
        routineId: undefined,
        tool: undefined,
        queueId,
        decision: 'approved',
        writeState: 'verified',
        confirmation: 'operator',
        ...fields,
      });
    const rejection = {
      decision: 'rejected',
      writeState: undefined,
      confirmation: undefined,
    };
    const undo = (fields: Record<string, unknown> = {}): string =>
      event({
        ts: '2026-11-11T08:00:00.000Z',
        type: 'undo',
        actor: { kind: 'operator', id: 'local-stdio' },
        mode: 'operator',
        tool: undefined,
        undoes: idIn(approvedOnce),
        writeState: 'verified',
        confirmation: 'operator',
        ...fields,
      });
    const summary = summarizeRun({
      folder: folderOf({
        // The decisions sort before the lines of the run.
        [nameOf('2026-11-08', 1)]: [
          decision(idIn(approvedOnce), { ts: '2026-11-08T08:00:00.000Z' }),
        ],
        [nameOf('2026-11-09', 1)]: [
          approvedOnce,
          approvedTwice,
          rejected,
          waiting,
          runEnd(),
        ],
        [nameOf('2026-11-10', 1)]: [
          decision(idIn(approvedOnce)),
          // An approval that found the target changed decides nothing.
          decision(idIn(approvedTwice), {
            outcome: 'error',
            errorCode: 'conflict',
            writeState: undefined,
            confirmation: undefined,
          }),
          decision(idIn(approvedTwice)),
          decision(idIn(rejected), rejection),
          // A decision about an entry of another run is none of this run.
          decision('00000000-0000-4000-8000-0000000009ff', rejection),
        ],
        [nameOf('2026-11-11', 1)]: [
          undo(),
          undo({ writeState: 'skipped' }),
          undo({ writeState: 'skipped' }),
          // An undo of a write of another run is none of this run.
          undo({ runId: otherRun }),
          // The schema lets an undo without a state through; it counts as
          // a line of the run only.
          undo({ writeState: undefined, confirmation: undefined }),
        ],
      }),
      runId,
      since: '2026-11-09',
    });
    expect(summary.decisions).toEqual([
      { decision: 'approved', count: 1 },
      { decision: 'approved', writeState: 'verified', count: 2 },
      { decision: 'rejected', count: 1 },
    ]);
    expect(summary.undos).toEqual([
      { writeState: 'skipped', count: 2 },
      { writeState: 'verified', count: 1 },
    ]);
    // The four writes, the end and the four undos of this run.
    expect(summary.lines).toBe(9);
    expect(summary.begin).toBe('2026-11-09T05:00:09.000Z');
    expect(Object.isFrozen(summary.decisions)).toBe(true);
    expect(Object.isFrozen(summary.decisions[0])).toBe(true);
    expect(Object.isFrozen(summary.undos)).toBe(true);
    expect(Object.isFrozen(summary.undos[0])).toBe(true);
  });

  it('counts a line without a tool and a piece of a line as nothing, and a line of other characters as skipped', () => {
    const summary = summarizeRun({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [
          event({ tool: undefined }),
          '{"v":1~',
          'ä line that is no ASCII',
        ],
      }),
      runId,
    });
    expect(summary).toMatchObject({
      lines: 1,
      skipped: 1,
      reads: [],
      writeRows: [],
    });
  });

  it('counts the files it could not read and stops when the folder moved', () => {
    const unread = summarizeRun({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: 'unreadable',
        [nameOf('2026-11-09', 2)]: [event({})],
      }),
      runId,
    });
    expect(unread).toMatchObject({ files: 2, read: 1, unread: 1, lines: 1 });
    const gone: AuditFolder = {
      ...folderOf({}),
      names: [nameOf('2026-11-09', 1)],
    };
    expect(summarizeRun({ folder: gone, runId })).toMatchObject({
      files: 1,
      read: 0,
      unread: 0,
    });
    const moved = summarizeRun({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: 'moved',
        [nameOf('2026-11-09', 2)]: [event({})],
      }),
      runId,
    });
    expect(moved).toMatchObject({ moved: true, lines: 0 });
  });

  it.each([
    [{ runId: runId.toUpperCase() }],
    [{ runId: 'run-alpha' }],
    [{ runId, since: '2026-02-30' }],
    [{ runId, until: 'today' }],
  ])('refuses %j', (options) => {
    expect(() => summarizeRun({ folder: folderOf({}), ...options })).toThrow(
      TypeError,
    );
  });
});
