import type { Mode } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { checkPolicy, defaultPolicy } from './check.js';
import {
  judgeMatch,
  matchPolicy,
  type PolicyMatch,
  type PolicyRequest,
  policyQueueReasons,
} from './engine.js';
import type { Policy } from './schema.js';

const guid = '0000000a-0000-4000-8000-000000000001';
const otherGuid = '0000000b-0000-4000-8000-000000000002';

const policyOf = (targets: readonly unknown[]): Policy => {
  const result = checkPolicy({ schema: 'policy.v1', interactive: { targets } });
  if (!result.ok) throw new Error(result.code);
  return result.policy;
};

const entry = (target: unknown, tools: readonly string[], maxPerDay = 4) => ({
  target,
  tools,
  maxPerDay,
});

const category = { kind: 'wiki_category', id: 12, name: 'Berichte' };
const page = {
  kind: 'wiki_page',
  categoryId: 12,
  guid: guid.toUpperCase(),
  name: 'Dienstplan-Auswertung',
};

const request = (
  kind: PolicyRequest['target']['kind'],
  key: string,
  tool = 'ct_wiki_page_create',
  more: Partial<PolicyRequest> = {},
): PolicyRequest => ({
  mode: 'interactive',
  tool,
  target: { kind, key },
  alwaysQueue: false,
  ...more,
});

const facts = (names: readonly (string | undefined)[], count = 0) => ({
  names,
  count,
  counted: false,
});

describe('matchPolicy', () => {
  it('refuses every write outside the interactive mode', () => {
    for (const mode of ['unattended', 'operator'] as Mode[]) {
      expect(
        matchPolicy(
          defaultPolicy,
          request('wiki_category', '12', 'ct_x', { mode }),
        ),
      ).toEqual({ kind: 'deny', reason: 'not_interactive' });
    }
  });

  it('sends an operation of the escape hatch to the queue, with or without entries', () => {
    for (const policy of [
      defaultPolicy,
      policyOf([entry(category, ['ct_x'])]),
    ]) {
      expect(
        matchPolicy(
          policy,
          request('operation', 'createPerson', 'ct_api_execute_write', {
            alwaysQueue: true,
          }),
        ),
      ).toEqual({ kind: 'queue', reason: 'queue_only' });
    }
  });

  it('lets every target of the core through without entries, but groups and services', () => {
    for (const [kind, key] of [
      ['wiki_category', '12'],
      ['wiki_page', `12/${guid}`],
      ['calendar', '3'],
      ['appointment', '3/45'],
      ['resource', '4'],
    ] as const) {
      expect(matchPolicy(defaultPolicy, request(kind, key))).toEqual({
        kind: 'allow',
      });
    }
    for (const [kind, key] of [
      ['group', '9'],
      ['service', '5/7'],
    ] as const) {
      expect(matchPolicy(defaultPolicy, request(kind, key))).toEqual({
        kind: 'queue',
        reason: 'queue_only',
      });
    }
  });

  it('finds the entry of a category for a new page and for each of its pages', () => {
    const policy = policyOf([
      entry(
        category,
        ['ct_wiki_page_create', 'ct_wiki_page_append_section'],
        10,
      ),
    ]);
    expect(matchPolicy(policy, request('wiki_category', '12'))).toEqual({
      kind: 'entry',
      entry: policy.interactive.targets[0],
      names: [{ of: { kind: 'wiki_category', id: 12 }, name: 'Berichte' }],
      counter: 'write:ct_wiki_page_create:wiki_category:12',
      maxPerDay: 10,
    });
    expect(
      matchPolicy(
        policy,
        request('wiki_page', `12/${otherGuid}`, 'ct_wiki_page_append_section'),
      ),
    ).toMatchObject({
      kind: 'entry',
      counter: 'write:ct_wiki_page_append_section:wiki_category:12',
    });
    expect(
      matchPolicy(
        policy,
        request('wiki_page', `13/${otherGuid}`, 'ct_wiki_page_append_section'),
      ),
    ).toEqual({ kind: 'queue', reason: 'no_entry' });
  });

  it('lets the entry of a page replace that of its category for that page', () => {
    const policy = policyOf([
      entry(category, ['ct_wiki_page_append_section'], 10),
      entry(page, ['ct_wiki_page_update'], 2),
    ]);
    expect(
      matchPolicy(
        policy,
        request('wiki_page', `12/${guid}`, 'ct_wiki_page_update'),
      ),
    ).toEqual({
      kind: 'entry',
      entry: policy.interactive.targets[1],
      names: [
        {
          of: { kind: 'wiki_page', categoryId: 12, guid },
          name: 'Dienstplan-Auswertung',
        },
      ],
      counter: `write:ct_wiki_page_update:wiki_page:12/${guid}`,
      maxPerDay: 2,
    });
    // The category allows appending, the page replaces it and does not.
    expect(
      matchPolicy(
        policy,
        request('wiki_page', `12/${guid}`, 'ct_wiki_page_append_section'),
      ),
    ).toEqual({ kind: 'queue', reason: 'no_entry' });
    // Another page of the category still has the entry of the category.
    expect(
      matchPolicy(
        policy,
        request('wiki_page', `12/${otherGuid}`, 'ct_wiki_page_append_section'),
      ),
    ).toMatchObject({ kind: 'entry', maxPerDay: 10 });
  });

  it('matches calendars with their appointments, resources, groups and services', () => {
    const policy = policyOf([
      entry({ kind: 'calendar', id: 3, name: 'Gottesdienste' }, [
        'ct_appointments_create',
        'ct_appointments_update',
      ]),
      entry({ kind: 'resource', id: 4, name: 'Beamer' }, [
        'ct_bookings_create',
      ]),
      entry({ kind: 'group', id: 9, name: 'Lobpreis' }, [
        'ct_groups_add_member',
      ]),
      entry(
        {
          kind: 'service',
          event: { id: 5, name: 'Gottesdienst' },
          service: { id: 7, name: 'Technik' },
        },
        ['ct_services_request'],
      ),
    ]);
    expect(
      matchPolicy(
        policy,
        request('appointment', '3/45', 'ct_appointments_update'),
      ),
    ).toMatchObject({
      counter: 'write:ct_appointments_update:calendar:3',
      names: [{ of: { kind: 'calendar', id: 3 }, name: 'Gottesdienste' }],
    });
    expect(
      matchPolicy(policy, request('calendar', '3', 'ct_appointments_create')),
    ).toMatchObject({ kind: 'entry' });
    expect(
      matchPolicy(policy, request('resource', '4', 'ct_bookings_create')),
    ).toMatchObject({
      names: [{ of: { kind: 'resource', id: 4 }, name: 'Beamer' }],
    });
    expect(
      matchPolicy(policy, request('group', '9', 'ct_groups_add_member')),
    ).toMatchObject({ counter: 'write:ct_groups_add_member:group:9' });
    expect(
      matchPolicy(policy, request('service', '5/7', 'ct_services_request')),
    ).toMatchObject({
      counter: 'write:ct_services_request:service:5/7',
      names: [
        { of: { kind: 'event', id: 5 }, name: 'Gottesdienst' },
        { of: { kind: 'service', eventId: 5, id: 7 }, name: 'Technik' },
      ],
    });
    for (const [kind, key, tool] of [
      ['appointment', '4/45', 'ct_appointments_update'],
      ['resource', '9', 'ct_bookings_create'],
      ['group', '4', 'ct_groups_add_member'],
      ['service', '5/8', 'ct_services_request'],
      ['service', '6/7', 'ct_services_request'],
      ['wiki_category', '3', 'ct_appointments_create'],
      ['resource', '4', 'ct_groups_add_member'],
    ] as const) {
      expect(matchPolicy(policy, request(kind, key, tool)), key).toEqual({
        kind: 'queue',
        reason: 'no_entry',
      });
    }
  });

  it('names five reasons for the queue', () => {
    expect(policyQueueReasons).toEqual([
      'queue_only',
      'no_entry',
      'name_changed',
      'limit_reached',
      'count_unavailable',
    ]);
    expect(Object.isFrozen(policyQueueReasons)).toBe(true);
  });
});

describe('judgeMatch', () => {
  const policy = policyOf([entry(category, ['ct_wiki_page_create'], 3)]);
  const match = matchPolicy(policy, request('wiki_category', '12'));

  it('passes on a match without an entry as it is', () => {
    const allow: PolicyMatch = { kind: 'allow' };
    expect(judgeMatch(allow, facts([]))).toBe(allow);
  });

  it('lets a write ahead with the expected name below the limit', () => {
    expect(judgeMatch(match, facts(['Berichte'], 2))).toEqual({
      kind: 'allow',
    });
    // The same name in another normal form.
    expect(
      judgeMatch(
        matchPolicy(
          policyOf([
            entry({ ...category, name: 'Résumé' }, ['ct_wiki_page_create']),
          ]),
          request('wiki_category', '12'),
        ),
        facts(['Résumé']),
      ),
    ).toEqual({ kind: 'allow' });
  });

  it.each([
    ['another name', ['Archiv']],
    ['a name in other case', ['berichte']],
    ['no name', [undefined]],
  ])('sends a write with %s to the queue', (_name, names) => {
    expect(judgeMatch(match, facts(names))).toEqual({
      kind: 'queue',
      reason: 'name_changed',
    });
  });

  it('stops at the limit before the count when planning, past it when committing', () => {
    expect(judgeMatch(match, facts(['Berichte'], 3))).toEqual({
      kind: 'queue',
      reason: 'limit_reached',
    });
    expect(
      judgeMatch(match, { names: ['Berichte'], count: 3, counted: true }),
    ).toEqual({ kind: 'allow' });
    expect(
      judgeMatch(match, { names: ['Berichte'], count: 4, counted: true }),
    ).toEqual({ kind: 'queue', reason: 'limit_reached' });
  });

  it.each([undefined, -1, 1.5, Number.NaN])(
    'sends a write whose counter reads %s to the queue',
    (count) => {
      expect(
        judgeMatch(match, { names: ['Berichte'], count, counted: false }),
      ).toEqual({ kind: 'queue', reason: 'count_unavailable' });
    },
  );
});
