import { createHash } from 'node:crypto';

import type { WriteState } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import type { AuditFileRead, AuditFolder, AuditLine } from './reader.js';
import { writeStateOutcomes } from './schema.js';
import { collectWriteTargets } from './write-targets.js';

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const nameOf = (number: number): string =>
  `audit-2026-10-30-120000-4242-${String(number)}.jsonl`;

const create = 'ct_wiki_page_create';
const update = 'ct_wiki_page_update';
const guid = '0000000a-0000-4000-8000-000000000001';

let events = 0;

/** A line of a call of a write tool, with the fields an event needs. */
const write = (
  writeState: WriteState,
  fields: Record<string, unknown> = {},
): string => {
  events += 1;
  const outcome = writeStateOutcomes[writeState];
  return JSON.stringify({
    v: 1,
    eventId: `00000000-0000-4000-8000-${String(events).padStart(12, '0')}`,
    ts: '2026-10-30T08:00:00.000Z',
    type: 'tool_call',
    tenantId: 'default',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    mode: 'interactive',
    tool: create,
    outcome,
    writeState,
    objectRefs: ['wiki_category:12'],
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

describe('collectWriteTargets', () => {
  it('collects the categories with their tools and the highest day of one tool', () => {
    const targets = collectWriteTargets(
      folderOf({
        [nameOf(1)]: [
          write('planned'),
          write('verified'),
          write('planned', { tool: update }),
          write('planned', {
            ts: '2026-10-31T09:00:00.000Z',
            objectRefs: ['wiki_category:20', `wiki_page:${guid}`],
            tool: update,
          }),
        ],
        [nameOf(2)]: [
          write('conflict', { ts: '2026-10-31T10:00:00.000Z' }),
          write('failed', { ts: '2026-10-31T11:00:00.000Z' }),
          write('verified', { ts: '2026-10-31T12:00:00.000Z' }),
        ],
      }),
    );
    expect(targets).toEqual({
      categories: [
        { id: 12, tools: [create, update], highestPerDay: 3 },
        { id: 20, tools: [update], highestPerDay: 0 },
      ],
      days: { first: '2026-10-30', last: '2026-10-31' },
      read: 2,
      unread: 0,
      moved: false,
    });
    expect(Object.isFrozen(targets.categories[0])).toBe(true);
  });

  it('names a refused target but does not count it for the limit', () => {
    const targets = collectWriteTargets(
      folderOf({
        [nameOf(1)]: [
          write('denied'),
          write('denied'),
          write('skipped', { objectRefs: ['wiki_category:13'] }),
        ],
      }),
    );
    expect(targets.categories).toEqual([
      { id: 12, tools: [create], highestPerDay: 0 },
      { id: 13, tools: [create], highestPerDay: 0 },
    ]);
  });

  it('leaves out other modes, reading tools, other IDs and broken lines', () => {
    const targets = collectWriteTargets(
      folderOf({
        [nameOf(1)]: [
          write('planned', { mode: 'unattended' }),
          write('planned', { mode: 'operator' }),
          write('planned', { writeState: undefined, outcome: 'ok' }),
          write('planned', { tool: undefined }),
          write('planned', {
            objectRefs: [
              'person:7',
              'wiki_category:0',
              'wiki_category:2147483648',
              `wiki_page:${guid}`,
            ],
          }),
          'not json',
          'not ASCII: \u00e4',
          `${write('planned')}~`,
          '{"v":1}',
        ],
      }),
    );
    expect(targets.categories).toEqual([]);
    expect(targets.days).toEqual({ first: '2026-10-30', last: '2026-10-30' });
  });

  it('leaves out an undo, which is no write of the model, but reads its day (ADR 0031)', () => {
    const undo = (fields: Record<string, unknown>): string =>
      write('verified', {
        type: 'undo',
        undoes: '00000000-0000-4000-8000-0000000000aa',
        tool: undefined,
        confirmation: 'operator',
        objectRefs: ['wiki_category:14', `wiki_page:${guid}`],
        ...fields,
      });
    const targets = collectWriteTargets(
      folderOf({
        [nameOf(1)]: [
          write('verified'),
          undo({ ts: '2026-10-31T09:00:00.000Z', mode: 'operator' }),
          // Not a line ecclium undo writes: one in the interactive mode,
          // which its type keeps out of the proposal all the same.
          undo({ mode: 'interactive' }),
        ],
      }),
    );
    expect(targets.categories).toEqual([
      { id: 12, tools: [create], highestPerDay: 1 },
    ]);
    expect(targets.days).toEqual({ first: '2026-10-30', last: '2026-10-31' });
  });

  it('counts files it could not read, and notices a folder that moved', () => {
    const targets = collectWriteTargets(
      folderOf({
        [nameOf(1)]: 'unreadable',
        [nameOf(2)]: 'unsafe',
        [nameOf(3)]: 'gone',
        [nameOf(4)]: 'moved',
        [nameOf(5)]: [write('verified', { objectRefs: ['wiki_category:9'] })],
      }),
    );
    expect(targets).toMatchObject({ read: 1, unread: 2, moved: true });
    expect(targets.categories).toEqual([
      { id: 9, tools: [create], highestPerDay: 1 },
    ]);
  });

  it('counts a confirmed write once, not its question as well (ADR 0029)', () => {
    const targets = collectWriteTargets(
      folderOf({
        [nameOf(1)]: [
          write('planned'),
          write('verified'),
          write('planned', { objectRefs: ['wiki_category:13'] }),
          write('denied', { objectRefs: ['wiki_category:13'] }),
        ],
      }),
    );
    expect(targets.categories).toEqual([
      { id: 12, tools: [create], highestPerDay: 1 },
      { id: 13, tools: [create], highestPerDay: 0 },
    ]);
  });

  it('names no ct_write_confirm, whose write belongs to the tool that planned it', () => {
    const targets = collectWriteTargets(
      folderOf({
        [nameOf(1)]: [
          write('planned'),
          write('verified', { tool: 'ct_write_confirm', confirmation: 'echo' }),
        ],
      }),
    );
    expect(targets.categories).toEqual([
      { id: 12, tools: [create], highestPerDay: 0 },
    ]);
  });

  it('has no days without a valid line', () => {
    const targets = collectWriteTargets(folderOf({}));
    expect(targets).toEqual({
      categories: [],
      read: 0,
      unread: 0,
      moved: false,
    });
  });
});
