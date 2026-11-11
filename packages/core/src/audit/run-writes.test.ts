import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AuditFileRead, AuditFolder, AuditLine } from './reader.js';
import { findRunOfWrite, findRunWrites } from './run-writes.js';

// The writes of one run of a routine in the audit files, from synthetic
// lines. All data are made up.

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const runId = '00000000-0000-4000-8000-0000000000cc';
const otherRun = '00000000-0000-4000-8000-0000000000dd';

const nameOf = (day: string, number: number): string =>
  `audit-${day}-120000-4242-${String(number)}.jsonl`;

let events = 0;

const idOf = (number: number): string =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

/** A line of the run, by default a read, with the fields an event needs. */
const event = (fields: Record<string, unknown>): string => {
  events += 1;
  const outcome = fields['outcome'] ?? 'ok';
  return JSON.stringify({
    v: 1,
    eventId: idOf(events),
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
    ...(outcome === 'ok' ? {} : { errorCode: 'conflict' }),
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
    runResult: 'queued',
    attempt: 1,
    period: '2026-W46',
    durationMs: 9000,
    ...fields,
  });

/** A decision of the operator about an entry of the queue. */
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
    policyHash: 'a'.repeat(64),
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
  opened: string[] = [],
): AuditFolder => ({
  names: Object.keys(files).sort(),
  others: 0,
  read: (name, onLine) => {
    opened.push(name);
    const file = files[name];
    if (file === undefined) return 'gone';
    if (typeof file === 'string') return file;
    file.forEach((text, index) => {
      onLine(line(text, index + 1));
    });
    return 'read';
  },
});

const idIn = (text: string): string =>
  (JSON.parse(text) as { eventId: string }).eventId;

describe('findRunWrites', () => {
  it('finds the write of the run with its routine, begin, end and period', () => {
    const own = write();
    const found = findRunWrites({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [
          write({ runId: otherRun }),
          event({ ts: '2026-11-09T05:00:02.000Z' }),
          event({ ts: '2026-11-09T05:00:00.500Z' }),
          own,
          runEnd(),
        ],
      }),
      runId,
    });
    expect(found).toEqual({
      files: 1,
      read: 1,
      unread: 0,
      moved: false,
      skipped: 0,
      lines: 4,
      routineId: 'weekly-report',
      begin: '2026-11-09T05:00:00.500Z',
      ended: '2026-11-09T05:00:10.000Z',
      period: '2026-W46',
      written: [
        {
          eventId: idIn(own),
          ts: '2026-11-09T05:00:09.000Z',
          way: 'run',
          writeState: 'verified',
        },
      ],
      undecided: [],
    });
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found.written)).toBe(true);
    expect(Object.isFrozen(found.written[0])).toBe(true);
    expect(Object.isFrozen(found.undecided)).toBe(true);
  });

  it('finds the approval of an entry the run queued, even in an earlier file', () => {
    const queued = write({ writeState: 'queued', confirmation: undefined });
    const approved = decision(idIn(queued));
    const found = findRunWrites({
      folder: folderOf({
        // The name of the file of the approval sorts first.
        [nameOf('2026-11-09', 0)]: [approved],
        [nameOf('2026-11-09', 1)]: [queued, runEnd()],
      }),
      runId,
    });
    expect(found.written).toEqual([
      {
        eventId: idIn(approved),
        ts: '2026-11-10T08:00:00.000Z',
        way: 'approval',
        writeState: 'verified',
      },
    ]);
    expect(found.undecided).toEqual([]);
  });

  it('names entries without a decision, and none that was rejected', () => {
    const first = write({
      ts: '2026-11-09T05:00:05.000Z',
      writeState: 'queued',
      confirmation: undefined,
    });
    const second = write({
      ts: '2026-11-09T05:00:05.000Z',
      writeState: 'queued',
      confirmation: undefined,
    });
    const earlier = write({
      ts: '2026-11-09T05:00:04.000Z',
      writeState: 'queued',
      confirmation: undefined,
    });
    const rejected = write({ writeState: 'queued', confirmation: undefined });
    const found = findRunWrites({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [second, first, earlier, rejected],
        [nameOf('2026-11-10', 1)]: [
          decision(idIn(rejected), {
            decision: 'rejected',
            writeState: undefined,
            confirmation: undefined,
            policyHash: undefined,
          }),
          // An approval that wrote nothing decides, but is no write.
          decision(idIn(earlier), { writeState: 'skipped' }),
          // An approval of an entry of another run is none of this run.
          decision(idOf(999_999)),
        ],
      }),
      runId,
    });
    expect(found.written).toEqual([]);
    expect(found.undecided).toEqual([idIn(first), idIn(second)]);
  });

  it('counts writes that may have reached ChurchTools, the newest first', () => {
    const verified = write({ ts: '2026-11-09T05:00:07.000Z' });
    const conflict = write({
      ts: '2026-11-09T05:00:09.000Z',
      writeState: 'conflict',
      outcome: 'error',
    });
    const failed = write({
      ts: '2026-11-09T05:00:09.000Z',
      writeState: 'failed',
      outcome: 'error',
    });
    const found = findRunWrites({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [
          verified,
          conflict,
          failed,
          write({ writeState: 'skipped' }),
          write({ writeState: 'planned', confirmation: undefined }),
          write({
            writeState: 'denied',
            outcome: 'denied',
            confirmation: undefined,
          }),
          // A line of an undo that names the run is one of its lines, but
          // no write of it.
          event({
            type: 'undo',
            tool: undefined,
            undoes: idIn(verified),
            actor: { kind: 'operator', id: 'local-stdio' },
            mode: 'operator',
            writeState: 'verified',
            confirmation: 'operator',
          }),
        ],
      }),
      runId,
    });
    // The same time: the higher ID first.
    expect(found.written.map((found) => found.eventId)).toEqual([
      idIn(failed),
      idIn(conflict),
      idIn(verified),
    ]);
    expect(found.written.map((found) => found.writeState)).toEqual([
      'failed',
      'conflict',
      'verified',
    ]);
    expect(found.lines).toBe(7);
    expect(found.ended).toBeUndefined();
    expect(found.period).toBeUndefined();
  });

  it('takes the last end, should a run have two', () => {
    const found = findRunWrites({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [
          runEnd({ ts: '2026-11-09T06:00:00.000Z', period: '2026-W46' }),
          runEnd({ ts: '2026-11-09T05:00:00.000Z', period: '2026-W45' }),
        ],
      }),
      runId,
    });
    expect(found.ended).toBe('2026-11-09T06:00:00.000Z');
    expect(found.period).toBe('2026-W46');
  });

  it('opens no file of a day before the first, and drops earlier lines', () => {
    const opened: string[] = [];
    const found = findRunWrites({
      folder: folderOf(
        {
          [nameOf('2026-11-08', 1)]: [
            write({ ts: '2026-11-08T05:00:00.000Z' }),
          ],
          [nameOf('2026-11-09', 1)]: [
            write({ ts: '2026-11-08T23:59:59.000Z' }),
            decision(idOf(999_998), { ts: '2026-11-08T23:59:59.000Z' }),
          ],
          // A name without a day is read.
          'audit-current.jsonl': [],
        },
        opened,
      ),
      runId,
      since: '2026-11-09',
    });
    expect(opened).toEqual([nameOf('2026-11-09', 1), 'audit-current.jsonl']);
    expect(found.written).toEqual([]);
    expect(found.lines).toBe(0);
  });

  it('counts pieces and lines that are no audit events as skipped', () => {
    const found = findRunWrites({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: [
          'not json',
          '{"v":1}',
          `${write().slice(0, 20)}~`,
          write({ tool: 'ct_wiki_page_append_sectionä' }),
          write(),
        ],
      }),
      runId,
    });
    expect(found.skipped).toBe(4);
    expect(found.written).toHaveLength(1);
  });

  it('counts files it could not read whole and stops when the folder moves', () => {
    const found = findRunWrites({
      folder: folderOf({
        [nameOf('2026-11-09', 1)]: 'unreadable',
        [nameOf('2026-11-09', 2)]: 'gone',
        [nameOf('2026-11-09', 3)]: 'moved',
        [nameOf('2026-11-09', 4)]: [write()],
      }),
      runId,
    });
    expect(found).toMatchObject({
      files: 4,
      read: 0,
      unread: 1,
      moved: true,
      written: [],
    });
  });

  it.each([
    { runId: 'run-alpha' },
    { runId: runId.toUpperCase() },
    { runId, since: '2026-02-30' },
    { runId, since: 'yesterday' },
  ])('refuses %j', (wrong) => {
    expect(() => findRunWrites({ folder: folderOf({}), ...wrong })).toThrow(
      TypeError,
    );
  });
});

describe('findRunOfWrite', () => {
  it('names the run of a write of a run, and none of a write of a client', () => {
    const own = write();
    const client = write({
      runId: undefined,
      routineId: undefined,
      actor: { kind: 'user', id: 'person-id-1' },
      mode: 'interactive',
      confirmation: 'elicitation',
    });
    const folder = folderOf({ [nameOf('2026-11-09', 1)]: [own, client] });
    expect(findRunOfWrite({ folder, eventId: idIn(own) })).toEqual({
      run: { runId, routineId: 'weekly-report' },
      complete: true,
    });
    const none = findRunOfWrite({ folder, eventId: idIn(client) });
    expect(none).toEqual({ complete: true });
    expect(Object.isFrozen(none)).toBe(true);
    expect(findRunOfWrite({ folder, eventId: idOf(999_997) })).toEqual({
      complete: true,
    });
  });

  it('says it read not every line when one is no audit event or a piece, since it may be the one asked for', () => {
    const own = write();
    const damaged = write().replace('"verified"', '"bogus"');
    for (const bad of ['not json', `${own.slice(0, 20)}~`, damaged]) {
      const folder = folderOf({ [nameOf('2026-11-09', 1)]: [bad, own] });
      expect(findRunOfWrite({ folder, eventId: idIn(own) })).toEqual({
        run: { runId, routineId: 'weekly-report' },
        complete: false,
      });
      expect(findRunOfWrite({ folder, eventId: idIn(damaged) })).toEqual({
        complete: false,
      });
    }
  });

  it('names the run whose line queued the entry an approval wrote, in any order of the files', () => {
    const queued = write({ writeState: 'queued', confirmation: undefined });
    const approved = decision(idIn(queued));
    const other = decision(idOf(999_996));
    const folder = folderOf({
      [nameOf('2026-11-09', 0)]: [approved, other],
      [nameOf('2026-11-09', 1)]: [queued],
    });
    expect(findRunOfWrite({ folder, eventId: idIn(approved) })).toEqual({
      run: { runId, routineId: 'weekly-report' },
      complete: true,
    });
    // An approval of an entry that no run queued belongs to no run.
    expect(findRunOfWrite({ folder, eventId: idIn(other) })).toEqual({
      complete: true,
    });
  });

  it('names the run of an undo of a write of a run', () => {
    const undo = event({
      type: 'undo',
      tool: undefined,
      undoes: idOf(999_995),
      actor: { kind: 'operator', id: 'local-stdio' },
      mode: 'operator',
      writeState: 'verified',
      confirmation: 'operator',
    });
    expect(
      findRunOfWrite({
        folder: folderOf({ [nameOf('2026-11-09', 1)]: [undo] }),
        eventId: idIn(undo),
      }).run,
    ).toEqual({ runId, routineId: 'weekly-report' });
  });

  it('reads only the days from the first on, and says when it could not read every file', () => {
    const old = write({ ts: '2026-11-08T05:00:00.000Z' });
    const opened: string[] = [];
    const folder = folderOf(
      {
        [nameOf('2026-11-08', 1)]: [old],
        [nameOf('2026-11-09', 1)]: [old],
        [nameOf('2026-11-09', 2)]: 'gone',
      },
      opened,
    );
    expect(
      findRunOfWrite({ folder, eventId: idIn(old), since: '2026-11-09' }),
    ).toEqual({ complete: true });
    expect(opened).toEqual([nameOf('2026-11-09', 1), nameOf('2026-11-09', 2)]);
    expect(
      findRunOfWrite({
        folder: folderOf({
          [nameOf('2026-11-09', 1)]: 'unreadable',
          'audit-current.jsonl': [old],
        }),
        eventId: idIn(old),
      }),
    ).toEqual({
      run: { runId, routineId: 'weekly-report' },
      complete: false,
    });
    expect(
      findRunOfWrite({
        folder: folderOf({
          [nameOf('2026-11-09', 1)]: 'moved',
          [nameOf('2026-11-09', 2)]: [old],
        }),
        eventId: idIn(old),
      }),
    ).toEqual({ complete: false });
  });

  it.each([
    { eventId: 'run-alpha' },
    { eventId: runId.toUpperCase() },
    { eventId: runId, since: '2026-13-01' },
  ])('refuses %j', (wrong) => {
    expect(() => findRunOfWrite({ folder: folderOf({}), ...wrong })).toThrow(
      TypeError,
    );
  });
});
