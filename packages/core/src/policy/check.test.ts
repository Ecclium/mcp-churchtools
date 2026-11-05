import { describe, expect, it } from 'vitest';

import {
  checkPolicy,
  defaultPolicy,
  policyFieldOf,
  targetKeyOf,
} from './check.js';
import type { Policy } from './schema.js';

const guid = '00000000-0000-4000-8000-000000000001';
const upperGuid = '0000000A-0000-4000-8000-00000000000B';

const category = { kind: 'wiki_category', id: 12, name: 'Berichte' };
const page = {
  kind: 'wiki_page',
  categoryId: 12,
  guid,
  name: 'Dienstplan-Auswertung',
};
const service = {
  kind: 'service',
  event: { id: 5, name: 'Gottesdienst' },
  service: { id: 7, name: 'Technik' },
};

const entry = (target: unknown, tools = ['ct_wiki_page_create']) => ({
  target,
  tools,
  maxPerDay: 4,
});

const routine = (target: unknown, more: Record<string, unknown> = {}) => ({
  routine: 'dienstplan-report',
  credential: 'bericht',
  target,
  tools: ['ct_wiki_page_append_section'],
  maxPerRun: 2,
  maxPerDay: 4,
  ...more,
});

const policyOf = (value: unknown): Policy => {
  const result = checkPolicy(value);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.policy;
};

// Every object of the policy is frozen, at every depth.
const deeplyFrozen = (value: unknown): boolean =>
  typeof value !== 'object' ||
  value === null ||
  (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));

describe('checkPolicy', () => {
  it('takes a file with only its version as the default policy', () => {
    const result = checkPolicy({ schema: 'policy.v1' });
    expect(result).toEqual({ ok: true, policy: defaultPolicy });
    expect(deeplyFrozen(result)).toBe(true);
    expect(defaultPolicy).toEqual({
      schema: 'policy.v1',
      interactive: { readBudgetPerDay: 200, targets: [] },
      unattended: [],
    });
    expect(deeplyFrozen(defaultPolicy)).toBe(true);
  });

  it('takes every kind of target and fills in the defaults', () => {
    const policy = policyOf({
      schema: 'policy.v1',
      interactive: {
        readBudgetPerDay: 0,
        targets: [
          entry(category),
          entry({ ...page, guid: upperGuid }, ['ct_wiki_page_update']),
          entry({ kind: 'calendar', id: 3, name: 'Gottesdienste' }, [
            'ct_appointments_create',
          ]),
          entry({ kind: 'resource', id: 4, name: 'Beamer' }, [
            'ct_bookings_create',
          ]),
          entry({ kind: 'group', id: 9, name: 'Lobpreis' }, [
            'ct_groups_add_member',
            'ct_groups_remove_member',
          ]),
          entry(service, ['ct_services_request']),
        ],
      },
      unattended: [
        routine(page),
        routine(category, {
          routine: 'wiki-hygiene',
          modelRedaction: 'standard',
          tools: ['ct_wiki_page_create'],
        }),
      ],
    });
    expect(policy.interactive.readBudgetPerDay).toBe(0);
    expect(policy.interactive.targets).toHaveLength(6);
    expect(policy.interactive.targets[1]?.target).toEqual({
      ...page,
      guid: upperGuid.toLowerCase(),
    });
    expect(policy.unattended.map((item) => item.modelRedaction)).toEqual([
      'strict',
      'standard',
    ]);
    expect(deeplyFrozen(policy)).toBe(true);
  });

  it('keeps names in the normal form NFC', () => {
    const decomposed = 'Présences';
    const policy = policyOf({
      schema: 'policy.v1',
      interactive: {
        targets: [
          entry({ ...category, name: decomposed }),
          entry({ ...service, event: { id: 5, name: decomposed } }, [
            'ct_services_request',
          ]),
        ],
      },
    });
    expect(policy.interactive.targets[0]?.target).toMatchObject({
      name: 'Présences',
    });
    expect(policy.interactive.targets[1]?.target).toMatchObject({
      event: { name: 'Présences' },
      service: { name: 'Technik' },
    });
  });

  it.each([
    ['without its version', {}, 'schema'],
    ['with another version', { schema: 'policy.v2' }, 'schema'],
    ['as a list', [{ schema: 'policy.v1' }], undefined],
    ['as text', 'policy.v1', undefined],
    ['as null', null, undefined],
  ])('refuses a file %s', (_name, value, field) => {
    expect(checkPolicy(value)).toEqual({
      ok: false,
      code: 'policy_version_unknown',
      ...(field === undefined ? {} : { field }),
    });
  });

  it('refuses an unknown field without naming it', () => {
    const result = checkPolicy({ schema: 'policy.v1', Berichte: true });
    expect(result).toEqual({ ok: false, code: 'policy_invalid' });
    expect(JSON.stringify(result)).not.toContain('Berichte');
    expect(
      checkPolicy({ schema: 'policy.v1', interactive: { targetz: [] } }),
    ).toEqual({ ok: false, code: 'policy_invalid', field: 'interactive' });
  });

  it.each([
    [
      'a read budget above 1000',
      { interactive: { readBudgetPerDay: 1001 } },
      'interactive.readBudgetPerDay',
    ],
    [
      'a negative read budget',
      { interactive: { readBudgetPerDay: -1 } },
      'interactive.readBudgetPerDay',
    ],
    [
      'a limit of 0 per day',
      { interactive: { targets: [{ ...entry(category), maxPerDay: 0 }] } },
      'interactive.targets[0].maxPerDay',
    ],
    [
      'a limit above 1000 per day',
      { interactive: { targets: [{ ...entry(category), maxPerDay: 1001 }] } },
      'interactive.targets[0].maxPerDay',
    ],
    [
      'an entry without tools',
      { interactive: { targets: [entry(category, [])] } },
      'interactive.targets[0].tools',
    ],
    [
      'a tool that is no name of a tool',
      { interactive: { targets: [entry(category, ['wiki create'])] } },
      'interactive.targets[0].tools[0]',
    ],
    [
      'an ID of 0',
      { interactive: { targets: [entry({ ...category, id: 0 })] } },
      'interactive.targets[0].target.id',
    ],
    [
      'an ID that is no whole number',
      { interactive: { targets: [entry({ ...category, id: 1.5 })] } },
      'interactive.targets[0].target.id',
    ],
    [
      'an ID above the range',
      { interactive: { targets: [entry({ ...category, id: 2 ** 31 })] } },
      'interactive.targets[0].target.id',
    ],
    [
      'an empty name',
      { interactive: { targets: [entry({ ...category, name: '' })] } },
      'interactive.targets[0].target.name',
    ],
    [
      'a name with a line break',
      { interactive: { targets: [entry({ ...category, name: 'a\nb' })] } },
      'interactive.targets[0].target.name',
    ],
    [
      'a name longer than 255 characters',
      {
        interactive: {
          targets: [entry({ ...category, name: 'x'.repeat(256) })],
        },
      },
      'interactive.targets[0].target.name',
    ],
    [
      'a GUID of another form',
      { interactive: { targets: [entry({ ...page, guid: 'start' })] } },
      'interactive.targets[0].target.guid',
    ],
    [
      'a service without its event',
      {
        interactive: {
          targets: [entry({ kind: 'service', service: service.service })],
        },
      },
      'interactive.targets[0].target.event',
    ],
    [
      'a routine whose ID is no slug',
      { unattended: [routine(page, { routine: 'Dienstplan Report' })] },
      'unattended[0].routine',
    ],
    [
      'a level of redaction off',
      { unattended: [routine(page, { modelRedaction: 'off' })] },
      'unattended[0].modelRedaction',
    ],
    [
      'a routine without its credential',
      { unattended: [{ ...routine(page), credential: undefined }] },
      'unattended[0].credential',
    ],
  ])('refuses %s with the path of its field', (_name, more, field) => {
    expect(checkPolicy({ schema: 'policy.v1', ...more })).toEqual({
      ok: false,
      code: 'policy_invalid',
      field,
    });
  });

  it('keeps contact values in the normal form of the content policy, only when there are some', () => {
    const policy = policyOf({
      schema: 'policy.v1',
      interactive: {
        contacts: ['sekretariat@example.org', '\uff10\uff10\uff10 000 12 34'],
      },
    });
    expect(policy.interactive.contacts).toEqual([
      'sekretariat@example.org',
      '000 000 12 34',
    ]);
    expect(Object.isFrozen(policy.interactive.contacts)).toBe(true);
    expect(
      'contacts' in
        policyOf({ schema: 'policy.v1', interactive: {} }).interactive,
    ).toBe(false);
    expect(
      'contacts' in
        policyOf({ schema: 'policy.v1', interactive: { contacts: [] } })
          .interactive,
    ).toBe(false);
  });

  it('refuses a contact value that is no single value, and one twice', () => {
    for (const contact of [
      'Pfarramt',
      'Tel. 000 000 12 34',
      'a@example.org b@example.org',
      'a\ud800@example.org',
    ]) {
      expect(
        checkPolicy({
          schema: 'policy.v1',
          interactive: { contacts: ['sekretariat@example.org', contact] },
        }),
      ).toEqual({
        ok: false,
        code: 'policy_invalid',
        field: 'interactive.contacts[1]',
      });
    }
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: { contacts: ['000 000 12 34', '000-000-12-34'] },
      }),
    ).toEqual({
      ok: false,
      code: 'policy_contradiction',
      field: 'interactive.contacts[1]',
    });
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: { contacts: ['a'.repeat(255)] },
      }),
    ).toMatchObject({ ok: false, code: 'policy_invalid' });
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: {
          contacts: Array.from(
            { length: 101 },
            (_, index) => `a${String(index)}@example.org`,
          ),
        },
      }),
    ).toMatchObject({ ok: false, code: 'policy_invalid' });
  });

  // The line of the marking names whom to ask (ADR 0032).
  it('keeps whom to ask in the normal form of the content policy, only when it is set', () => {
    const wide = String.fromCodePoint(0xff33);
    const policy = policyOf({
      schema: 'policy.v1',
      interactive: {
        contacts: ['sekretariat@example.org'],
        inquiriesTo: `  ${wide}ekretariat, sekretariat@example.org `,
      },
    });
    expect(policy.interactive.inquiriesTo).toBe(
      'Sekretariat, sekretariat@example.org',
    );
    expect(
      'inquiriesTo' in
        policyOf({ schema: 'policy.v1', interactive: {} }).interactive,
    ).toBe(false);
  });

  it.each([
    [
      'contact data the policy does not list',
      'Sekretariat, max.mustermann@example.org',
    ],
    ['a web address', 'Sekretariat, www.example.org'],
    ['a tag', 'Sekretariat <b>Pfarramt</b>'],
    ['a sign that starts a link', 'Sekretariat [Pfarramt]'],
    ['a second line', 'Sekretariat\nPfarramt'],
    ['a tab', 'Sekretariat\tPfarramt'],
    ['a character reference', 'Kirche &amp; Gemeinde'],
    ['only spaces', '   '],
    ['an empty text', ''],
    ['more than 200 signs', 'a'.repeat(201)],
  ])('refuses whom to ask with %s', (_name, inquiriesTo) => {
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: { contacts: ['sekretariat@example.org'], inquiriesTo },
      }),
    ).toEqual({
      ok: false,
      code: 'policy_invalid',
      field: 'interactive.inquiriesTo',
    });
  });

  it('refuses more than 200 entries and 20 tools', () => {
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: {
          targets: Array.from({ length: 201 }, (_value, index) =>
            entry({ ...category, id: index + 1 }),
          ),
        },
      }),
    ).toEqual({
      ok: false,
      code: 'policy_invalid',
      field: 'interactive.targets',
    });
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: {
          targets: [
            entry(
              category,
              Array.from(
                { length: 21 },
                (_value, index) => `ct_tool_${String(index)}`,
              ),
            ),
          ],
        },
      }),
    ).toEqual({
      ok: false,
      code: 'policy_invalid',
      field: 'interactive.targets[0].tools',
    });
  });

  it.each([
    ['a group', { kind: 'group', id: 9, name: 'Lobpreis' }],
    ['a service', service],
  ])('refuses %s as a target of a routine', (_name, target) => {
    const result = checkPolicy({
      schema: 'policy.v1',
      unattended: [routine(target)],
    });
    expect(result).toMatchObject({ ok: false, code: 'policy_invalid' });
    expect(result).toHaveProperty(
      'field',
      expect.stringMatching(/^unattended\[0\]\.target/u),
    );
  });

  it.each([
    [
      'a category with two names',
      [entry(category), entry({ ...category, name: 'Archiv' }, ['ct_other'])],
      'interactive.targets[1].target.name',
    ],
    [
      'a page with two names, its GUID written in two ways',
      [
        entry(page, ['ct_wiki_page_update']),
        entry({ ...page, guid: guid.toUpperCase(), name: 'Archiv' }, [
          'ct_wiki_page_append_section',
        ]),
      ],
      'interactive.targets[1].target.name',
    ],
    [
      'a page with two names in two categories',
      [
        entry(page, ['ct_wiki_page_update']),
        entry({ ...page, categoryId: 13, name: 'Archiv' }, [
          'ct_wiki_page_update',
        ]),
      ],
      'interactive.targets[1].target.name',
    ],
    [
      'an event with two names',
      [
        entry(service, ['ct_services_request']),
        entry(
          {
            ...service,
            event: { id: 5, name: 'Jugend' },
            service: { id: 8, name: 'Ton' },
          },
          ['ct_services_request'],
        ),
      ],
      'interactive.targets[1].target.event.name',
    ],
    [
      'a service with two names',
      [
        entry(service, ['ct_services_request']),
        entry(
          {
            ...service,
            event: { id: 6, name: 'Jugend' },
            service: { id: 7, name: 'Ton' },
          },
          ['ct_services_request'],
        ),
      ],
      'interactive.targets[1].target.service.name',
    ],
    [
      'a tool twice in one entry',
      [entry(category, ['ct_wiki_page_create', 'ct_wiki_page_create'])],
      'interactive.targets[0].tools[1]',
    ],
    [
      'one target with one tool in two entries',
      [
        entry(page, ['ct_wiki_page_update']),
        entry({ ...page, guid: guid.toUpperCase() }, [
          'ct_wiki_page_append_section',
          'ct_wiki_page_update',
        ]),
      ],
      'interactive.targets[1].tools[1]',
    ],
  ])('refuses %s as a contradiction', (_name, targets, field) => {
    expect(
      checkPolicy({ schema: 'policy.v1', interactive: { targets } }),
    ).toEqual({ ok: false, code: 'policy_contradiction', field });
  });

  it('takes one target in two entries with other tools, and one name in two forms', () => {
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: {
          targets: [
            entry({ ...category, name: 'Résumé' }),
            entry({ ...category, name: 'Résumé' }, ['ct_wiki_page_update']),
          ],
        },
      }).ok,
    ).toBe(true);
  });

  it.each([
    [
      'a limit per run above the limit per day',
      [routine(page, { maxPerRun: 5 })],
      'unattended[0].maxPerRun',
    ],
    [
      'a routine with two levels of redaction',
      [routine(page), routine(category, { modelRedaction: 'standard' })],
      'unattended[1].modelRedaction',
    ],
    [
      'one routine with one target and tool twice',
      [routine(page), routine({ ...page, guid: guid.toUpperCase() })],
      'unattended[1].tools[0]',
    ],
    [
      'a name other than the one of the interactive part',
      [routine({ ...page, name: 'Archiv' })],
      'unattended[0].target.name',
    ],
  ])('refuses %s in the unattended part', (_name, unattended, field) => {
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: { targets: [entry(page, ['ct_wiki_page_update'])] },
        unattended,
      }),
    ).toEqual({ ok: false, code: 'policy_contradiction', field });
  });

  it('lets two routines write one target with one tool', () => {
    expect(
      checkPolicy({
        schema: 'policy.v1',
        interactive: {
          targets: [entry(page, ['ct_wiki_page_append_section'])],
        },
        unattended: [routine(page), routine(page, { routine: 'wiki-hygiene' })],
      }).ok,
    ).toBe(true);
  });
});

describe('policyFieldOf', () => {
  it.each([
    [['unattended', 0, 'maxPerRun'], 'unattended[0].maxPerRun'],
    [[0, 'name'], '[0].name'],
    [['interactive', 'with space', 'name'], 'interactive'],
    [[Symbol('key'), 'name'], undefined],
    [[], undefined],
  ])('writes %j as %s', (path, field) => {
    expect(policyFieldOf(path)).toBe(field);
  });
});

describe('targetKeyOf', () => {
  it.each([
    [category, 'wiki_category:12'],
    [{ ...page, guid: upperGuid }, `wiki_page:12/${upperGuid.toLowerCase()}`],
    [{ kind: 'calendar', id: 3, name: 'Gottesdienste' }, 'calendar:3'],
    [{ kind: 'resource', id: 4, name: 'Beamer' }, 'resource:4'],
    [{ kind: 'group', id: 9, name: 'Lobpreis' }, 'group:9'],
    [service, 'service:5/7'],
  ] as const)('names %j as %s', (target, key) => {
    expect(targetKeyOf(target as Parameters<typeof targetKeyOf>[0])).toBe(key);
  });
});
