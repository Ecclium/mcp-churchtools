import { describe, expect, it } from 'vitest';

import {
  approvalCountDays,
  approvalQuotaKey,
  isApprovalQuotaKey,
  isIsoDate,
  isQuotaKey,
  maxWriteQuotaKeyLength,
  quotaKeys,
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
