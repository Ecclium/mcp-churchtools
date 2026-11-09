import { describe, expect, it } from 'vitest';

import {
  approvalCountDays,
  approvalQuotaKey,
  isApprovalQuotaKey,
  isIsoDate,
  isQuotaKey,
  isRunQuotaKey,
  maxWriteQuotaKeyLength,
  quotaKeys,
  runCountDays,
  runQuotaDayOf,
  runQuotaKey,
  type RunQuotaKey,
  runWindowCount,
  writeQuotaKey,
} from './index.js';

const guid = '00000000-0000-4000-8000-000000000001';

describe('the port for quotas', () => {
  it('has one key with a fixed name, frozen', () => {
    expect(quotaKeys).toEqual(['special_reads']);
    expect(Object.isFrozen(quotaKeys)).toBe(true);
  });

  it.each([
    ['ct_wiki_page_create', 'wiki_category:12'],
    ['ct_wiki_page_update', `wiki_page:12/${guid}`],
    ['ct_appointments_create', 'calendar:3'],
    ['ct_bookings_create', 'resource:4'],
    ['ct_groups_add_member', 'group:2147483647'],
    ['ct_services_request', 'service:5/7'],
  ])('builds the key of a counter of %s on %s', (tool, target) => {
    const key = writeQuotaKey(tool, target);
    expect(key).toBe(`write:${tool}:${target}`);
    expect(isQuotaKey(key)).toBe(true);
  });

  it('takes the longest key the form allows', () => {
    const key = writeQuotaKey(
      `ct_${'a'.repeat(60)}`,
      `wiki_page:2147483647/${guid}`,
    );
    expect(key.length).toBeLessThanOrEqual(maxWriteQuotaKeyLength);
  });

  it.each([
    ['a tool of another form', 'wiki_create', 'wiki_category:12'],
    ['a kind outside the policy', 'ct_api_execute_write', 'operation:x'],
    ['an ID of 0', 'ct_wiki_page_create', 'wiki_category:0'],
    ['an ID with a sign', 'ct_wiki_page_create', 'wiki_category:-1'],
    [
      'a GUID in capitals',
      'ct_wiki_page_update',
      'wiki_page:12/0000000A-0000-4000-8000-00000000000B',
    ],
    ['a page without its category', 'ct_wiki_page_update', `wiki_page:${guid}`],
    ['a path', 'ct_wiki_page_create', 'wiki_category:12/../x'],
    ['a line break', 'ct_wiki_page_create', 'wiki_category:12\n'],
  ])('refuses %s', (_name, tool, target) => {
    expect(() => writeQuotaKey(tool, target)).toThrow(TypeError);
  });

  it('builds the key of the counter of a decision about an entry', () => {
    const hash = 'a1'.repeat(32);
    const key = approvalQuotaKey(hash);
    expect(key).toBe(`approval:${hash}`);
    expect(isApprovalQuotaKey(key)).toBe(true);
    expect(isQuotaKey(key)).toBe(true);
    // Kept through the 14 days of the queue and one more.
    expect(approvalCountDays).toBe(15);
  });

  it.each([
    ['a hash too short', 'a'.repeat(63)],
    ['a hash too long', 'a'.repeat(65)],
    ['a hash in capitals', 'A'.repeat(64)],
    ['a path', `../${'a'.repeat(61)}`],
    ['a line break', `${'a'.repeat(64)}\n`],
    ['nothing', ''],
  ])('refuses the key of a decision with %s', (_name, hash) => {
    expect(() => approvalQuotaKey(hash)).toThrow(TypeError);
    expect(isApprovalQuotaKey(`approval:${hash}`)).toBe(false);
    expect(isQuotaKey(`approval:${hash}`)).toBe(false);
  });

  // The memory of runs of the routines (ADR 0034).
  it('builds the keys of the memory of runs of a trigger', () => {
    const trigger = Date.UTC(2026, 10, 9, 5);
    const keys = [
      runQuotaKey('dienstplan-report', trigger, 'done'),
      runQuotaKey('dienstplan-report', trigger, 'tries'),
      runQuotaKey('dienstplan-report', trigger, 0),
      runQuotaKey('dienstplan-report', trigger, runWindowCount - 1),
    ];
    expect(keys).toEqual([
      'run:dienstplan-report:20261109T0500:done',
      'run:dienstplan-report:20261109T0500:tries',
      'run:dienstplan-report:20261109T0500:try:0',
      'run:dienstplan-report:20261109T0500:try:3071',
    ]);
    for (const key of keys) {
      expect(isRunQuotaKey(key)).toBe(true);
      expect(isQuotaKey(key)).toBe(true);
      expect(isApprovalQuotaKey(key)).toBe(false);
      expect(runQuotaDayOf(key)).toBe('2026-11-09');
    }
    // The 31 days a trigger can be due and one more, in windows of 15
    // minutes.
    expect(runCountDays).toBe(32);
    expect(runWindowCount).toBe(3072);
  });

  it('takes the longest ID of a routine and the edges of the calendar', () => {
    const key = runQuotaKey(
      `a${'-'.repeat(62)}`,
      Date.UTC(9999, 11, 31, 23, 59),
      'tries',
    );
    expect(key).toBe(`run:a${'-'.repeat(62)}:99991231T2359:tries`);
    expect(runQuotaDayOf(key)).toBe('9999-12-31');
    expect(runQuotaKey('r', 0, 'done')).toBe('run:r:19700101T0000:done');
    expect(runQuotaDayOf(runQuotaKey('r', Date.UTC(2028, 1, 29), 1))).toBe(
      '2028-02-29',
    );
  });

  it.each<[string, string, number, 'done' | 'tries' | number]>([
    ['an ID in capitals', 'Dienstplan', 0, 'done'],
    ['an ID with a colon', 'a:b', 0, 'done'],
    ['an ID too long', 'a'.repeat(64), 0, 'done'],
    ['an empty ID', '', 0, 'done'],
    ['a trigger with seconds', 'r', 1000, 'done'],
    ['a trigger before 1970', 'r', -60_000, 'done'],
    ['a trigger after 9999', 'r', Date.UTC(10_000, 0, 1), 'done'],
    ['a trigger far beyond any date', 'r', 9e15, 'done'],
    ['a trigger that is no number', 'r', Number.NaN, 'done'],
    ['a window below 0', 'r', 0, -1],
    ['a window beyond the days kept', 'r', 0, 3072],
    ['a window that is no whole number', 'r', 0, 1.5],
    ['another counter', 'r', 0, 'last' as 'done'],
  ])('refuses the key of a run with %s', (_name, routine, trigger, counter) => {
    expect(() => runQuotaKey(routine, trigger, counter)).toThrow(TypeError);
  });

  it.each([
    'run:r:20260230T0500:done',
    'run:r:20261109T2400:done',
    'run:r:20261109T0560:done',
    'run:r:20261109T0500:try:01',
    'run:r:20261109T0500:try:3072',
    'run:r:20261109T0500:try:',
    'run:r:20261109T0500',
    'run:r:2026110T0500:done',
    'run:r:20261109T0500:done\n',
    'run:-r:20261109T0500:done',
    12,
    null,
  ])('does not take %j as the key of a run', (value) => {
    expect(isRunQuotaKey(value)).toBe(false);
    expect(isQuotaKey(value)).toBe(false);
  });

  it('gives no day for a key of a run that is none', () => {
    expect(() =>
      runQuotaDayOf('run:r:20260230T0500:done' as RunQuotaKey),
    ).toThrow(TypeError);
  });

  it.each(['special_reads', 'write:ct_x:wiki_category:1', 12, null])(
    'does not take %j as the key of a decision',
    (value) => {
      expect(isApprovalQuotaKey(value)).toBe(false);
    },
  );

  it.each(['special_reads', `write:ct_x:wiki_page:1/${guid}`])(
    'takes %s as a key',
    (value) => {
      expect(isQuotaKey(value)).toBe(true);
    },
  );

  it.each([
    'special_read',
    'write:',
    `write:ct_${'a'.repeat(200)}:group:1`,
    'toString',
    12,
    null,
    undefined,
  ])('refuses %j as a key', (value) => {
    expect(isQuotaKey(value)).toBe(false);
  });

  it.each(['2026-10-24', '1970-01-01', '2028-02-29', '9999-12-31'])(
    'takes the day %s',
    (value) => {
      expect(isIsoDate(value)).toBe(true);
    },
  );

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-00',
    '1969-12-31',
    '2026-1-24',
    '2026-10-24T00:00:00Z',
    ' 2026-10-24',
    '2026-10-24\n',
    '../2026-10-24',
    '２０２６-10-24',
    '',
    20261024,
    null,
    undefined,
  ])('refuses %j as a day', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });
});
