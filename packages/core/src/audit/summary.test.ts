import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AuditFileRead, AuditFolder, AuditLine } from './reader.js';
import { isUtcDay, maxShownHits, summarizeAuditFiles } from './summary.js';

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const nameOf = (number: number): string =>
  `audit-2026-10-30-120000-4242-${String(number)}.jsonl`;

let events = 0;

/** A line of the audit file with the fields an event needs. */
const event = (fields: Record<string, unknown>): string => {
  events += 1;
  const outcome = fields['outcome'] ?? 'ok';
  return JSON.stringify({
    v: 1,
    eventId: `00000000-0000-4000-8000-${String(events).padStart(12, '0')}`,
    ts: '2026-10-30T08:00:00.000Z',
    type: 'tool_call',
    tenantId: 'default',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    mode: 'interactive',
    tool: 'ct_persons_get',
    outcome,
    objectRefs: [],
    ...(outcome === 'ok' ? {} : { errorCode: 'policy_denied' }),
    durationMs: 4,
    ...fields,
  });
};

const line = (text: string, number: number): AuditLine => ({
  number,
  hash: sha256(text),
  text: /^[ -~]*$/.test(text) ? text : undefined,
  tooLong: false,
  piece: text.endsWith('~'),
});

/** A folder with files of lines and files that end otherwise. */
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

describe('summarizeAuditFiles', () => {
  it('counts the calls per UTC day and tool, by outcome', () => {
    const summary = summarizeAuditFiles({
      folder: folderOf({
        [nameOf(1)]: [
          event({ ts: '2026-10-31T00:10:00.000Z', tool: 'ct_whoami' }),
          event({}),
          event({ outcome: 'error', errorCode: 'upstream' }),
          event({ outcome: 'denied' }),
          event({ outcome: 'denied', withheldAfterRead: true }),
          event({ tool: undefined }),
        ],
        [nameOf(2)]: [
          event({ ts: '2026-10-29T23:59:59.999Z' }),
          event({ tool: 'ct_groups_get' }),
        ],
      }),
    });

    expect(summary.rows).toEqual([
      {
        day: '2026-10-29',
        tool: 'ct_persons_get',
        calls: 1,
        ok: 1,
        error: 0,
        denied: 0,
        withheld: 0,
      },
      {
        day: '2026-10-30',
        tool: 'ct_groups_get',
        calls: 1,
        ok: 1,
        error: 0,
        denied: 0,
        withheld: 0,
      },
      {
        day: '2026-10-30',
        tool: 'ct_persons_get',
        calls: 4,
        ok: 1,
        error: 1,
        denied: 2,
        withheld: 1,
      },
      {
        day: '2026-10-30',
        tool: undefined,
        calls: 1,
        ok: 1,
        error: 0,
        denied: 0,
        withheld: 0,
      },
      {
        day: '2026-10-31',
        tool: 'ct_whoami',
        calls: 1,
        ok: 1,
        error: 0,
        denied: 0,
        withheld: 0,
      },
    ]);
    expect(summary).toMatchObject({
      files: 2,
      read: 2,
      unread: 0,
      moved: false,
      lines: 8,
      skipped: 0,
      hits: [],
      hitsOmitted: 0,
      partial: 0,
    });
    expect(Object.isFrozen(summary.rows[0])).toBe(true);
  });

  it('sorts lines without a tool after the tools of the day', () => {
    const summary = summarizeAuditFiles({
      folder: folderOf({
        [nameOf(1)]: [
          event({ tool: undefined }),
          event({ tool: 'ct_whoami' }),
          event({ tool: undefined }),
        ],
      }),
    });

    expect(summary.rows.map((row) => row.tool)).toEqual([
      'ct_whoami',
      undefined,
    ]);
  });

  it('counts only the days from since to until', () => {
    const folder = folderOf({
      [nameOf(1)]: [
        event({ ts: '2026-10-28T12:00:00.000Z' }),
        event({ ts: '2026-10-29T00:00:00.000Z' }),
        event({ ts: '2026-10-30T23:59:59.999Z' }),
        event({ ts: '2026-10-31T00:00:00.000Z' }),
      ],
    });

    const summary = summarizeAuditFiles({
      folder,
      since: '2026-10-29',
      until: '2026-10-30',
    });

    expect(summary.rows.map((row) => row.day)).toEqual([
      '2026-10-29',
      '2026-10-30',
    ]);
    expect(summary.lines).toBe(2);
  });

  it('skips lines that do not fit the schema and leaves out pieces', () => {
    const summary = summarizeAuditFiles({
      folder: folderOf({
        [nameOf(1)]: [
          'not json',
          '{"v":1}',
          event({ outcome: 'ok', errorCode: 'internal' }),
          `${event({}).slice(0, 30)}~`,
          `{"x":"ä"}`,
          event({}),
        ],
      }),
    });

    expect(summary.skipped).toBe(4);
    expect(summary.lines).toBe(1);
  });

  it('finds the lines that name an ID, by time, with tool, actor and outcome', () => {
    const summary = summarizeAuditFiles({
      object: 'person:12',
      folder: folderOf({
        [nameOf(1)]: [
          event({
            ts: '2026-10-30T09:00:00.000Z',
            objectRefs: ['group:7', 'person:12'],
            outcome: 'denied',
            withheldAfterRead: true,
          }),
          event({ objectRefs: ['person:13'] }),
        ],
        [nameOf(2)]: [
          event({
            ts: '2026-10-30T07:00:00.000Z',
            tool: undefined,
            actor: { kind: 'service', id: 'stdio:team-a' },
            objectRefs: ['person:12'],
          }),
        ],
      }),
    });

    expect(summary.hits).toEqual([
      {
        ts: '2026-10-30T07:00:00.000Z',
        tool: undefined,
        actorId: 'stdio:team-a',
        outcome: 'ok',
        withheld: false,
      },
      {
        ts: '2026-10-30T09:00:00.000Z',
        tool: 'ct_persons_get',
        actorId: 'stdio:local-stdio',
        outcome: 'denied',
        withheld: true,
      },
    ]);
    expect(Object.isFrozen(summary.hits[0])).toBe(true);
  });

  it('counts the lines that left IDs out and do not name the ID', () => {
    const many = Array.from(
      { length: 100 },
      (_, index) => `person:${String(index + 100)}`,
    );
    const summary = summarizeAuditFiles({
      object: 'person:12',
      folder: folderOf({
        [nameOf(1)]: [
          event({
            tool: 'ct_api_execute_read',
            objectRefs: many,
            objectRefsOmitted: 5,
          }),
          event({
            tool: 'ct_api_execute_read',
            objectRefs: ['person:12', ...many.slice(1)],
            objectRefsOmitted: 5,
          }),
          event({ objectRefs: ['person:13'] }),
        ],
      }),
    });

    expect(summary.partial).toBe(1);
    expect(summary.hits).toHaveLength(1);
  });

  it('lists the first hits and counts the others', () => {
    const lines = Array.from({ length: maxShownHits + 2 }, (_, index) =>
      event({
        ts: `2026-10-30T${String(Math.floor(index / 60) % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
        objectRefs: ['group:7'],
      }),
    );

    const summary = summarizeAuditFiles({
      object: 'group:7',
      folder: folderOf({ [nameOf(1)]: lines }),
    });

    expect(summary.hits).toHaveLength(maxShownHits);
    expect(summary.hitsOmitted).toBe(2);
  });

  it('keeps no more hits than it can sort and still counts them', () => {
    const text = event({ objectRefs: ['group:7'] });
    const lines = Array.from({ length: 100_001 }, () => text);

    const summary = summarizeAuditFiles({
      object: 'group:7',
      folder: folderOf({ [nameOf(1)]: lines }),
    });

    expect(summary.hits).toHaveLength(maxShownHits);
    expect(summary.hitsOmitted).toBe(100_001 - maxShownHits);
  }, 120_000);

  it('counts files it could not read and stops when the folder moves', () => {
    const files = {
      [nameOf(1)]: [event({})],
      [nameOf(2)]: 'gone',
      [nameOf(3)]: 'unsafe',
      [nameOf(4)]: 'unreadable',
      [nameOf(5)]: 'moved',
      [nameOf(6)]: [event({})],
    } as const;

    const summary = summarizeAuditFiles({ folder: folderOf(files) });

    expect(summary).toMatchObject({
      files: 6,
      read: 1,
      unread: 2,
      moved: true,
      lines: 1,
    });
  });

  it('throws for a day or an ID of another form', () => {
    const folder = folderOf({});
    for (const options of [
      { since: '2026-02-30' },
      { until: '31.10.2026' },
      { object: 'person:Max' },
      { object: 'Person:12' },
    ]) {
      expect(() => summarizeAuditFiles({ folder, ...options })).toThrow(
        TypeError,
      );
    }
  });
});

describe('isUtcDay', () => {
  it('takes days that exist and nothing else', () => {
    for (const day of ['2026-10-31', '2028-02-29', '2026-01-01']) {
      expect(isUtcDay(day)).toBe(true);
    }
    for (const value of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '0099-01-01',
      '2026-1-01',
      ' 2026-10-31',
      42,
      undefined,
    ]) {
      expect(isUtcDay(value)).toBe(false);
    }
  });
});
