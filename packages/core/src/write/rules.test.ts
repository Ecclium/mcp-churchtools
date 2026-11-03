import { readFileSync } from 'node:fs';

import type {
  Sensitivity,
  UnattendedRule,
  WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { echoAllowed, rulesOf, withToolMeta } from './rules.js';

const guid = '00000000-0000-4000-8000-000000000001';

const intents = {
  wikiPageCreate: {
    kind: 'wikiPageCreate',
    categoryId: 12,
    title: 'Plan',
    text: '# Plan',
  },
  wikiPageUpdate: {
    kind: 'wikiPageUpdate',
    categoryId: 12,
    guid,
    text: '# Plan',
    baseVersion: 3,
  },
  wikiSectionAppend: {
    kind: 'wikiSectionAppend',
    categoryId: 12,
    guid,
    section: '## Nachtrag',
    baseVersion: 3,
  },
  appointmentCreate: {
    kind: 'appointmentCreate',
    calendarId: 4,
    title: 'Probe',
    startDate: 'a',
    endDate: 'b',
  },
  appointmentUpdate: {
    kind: 'appointmentUpdate',
    calendarId: 4,
    appointmentId: 13,
    baseVersion: 0,
    title: 'Probe',
    startDate: 'a',
    endDate: 'b',
  },
  bookingCreate: {
    kind: 'bookingCreate',
    resourceId: 2,
    title: 'Raum',
    startDate: 'a',
    endDate: 'b',
  },
  groupMemberAdd: { kind: 'groupMemberAdd', groupId: 7, personId: 1 },
  groupMemberRemove: { kind: 'groupMemberRemove', groupId: 7, personId: 1 },
  serviceRequest: {
    kind: 'serviceRequest',
    eventId: 9,
    serviceId: 3,
    personId: 1,
  },
  apiOperation: { kind: 'apiOperation', operationId: 'post-groups-id' },
} as const satisfies Record<WriteIntent['kind'], WriteIntent>;

// Kind, target, replay guard, module, queue, runs: the table of ADR 0029
// and ADR 0071.
const table = [
  ['wikiPageCreate', 'wiki_category', '12', 'marker', 'core', false, true],
  [
    'wikiPageUpdate',
    'wiki_page',
    `12/${guid}`,
    'baseVersion',
    'core',
    false,
    true,
  ],
  [
    'wikiSectionAppend',
    'wiki_page',
    `12/${guid}`,
    'marker',
    'core',
    false,
    true,
  ],
  ['appointmentCreate', 'calendar', '4', 'nonce', 'core', false, false],
  [
    'appointmentUpdate',
    'appointment',
    '4/13',
    'baseVersion',
    'core',
    false,
    false,
  ],
  ['bookingCreate', 'resource', '2', 'nonce', 'core', false, false],
  ['groupMemberAdd', 'group', '7', 'nonce', 'pro', false, false],
  ['groupMemberRemove', 'group', '7', 'nonce', 'pro', false, false],
  ['serviceRequest', 'service', '9/3', 'nonce', 'pro', false, false],
  ['apiOperation', 'operation', 'post-groups-id', 'nonce', 'pro', true, false],
] as const;

describe('the rules of an intent', () => {
  it.each(table)(
    '%s targets %s %s, guards with %s, belongs to %s',
    (kind, targetKind, key, replayGuard, module, alwaysQueue, runs) => {
      const rules = rulesOf(intents[kind]);
      expect(rules.target).toEqual({ kind: targetKind, key });
      expect(rules.replayGuard).toBe(replayGuard);
      expect(rules.module).toBe(module);
      expect(rules.alwaysQueue).toBe(alwaysQueue);
      expect(rules.runs).toBe(runs);
      expect(Object.isFrozen(rules)).toBe(true);
      expect(Object.isFrozen(rules.target)).toBe(true);
      expect(Object.isFrozen(rules.requiredRights)).toBe(true);
      if (module === 'core') {
        expect(rules).toMatchObject({
          sensitivity: 'personal',
          unattended: 'policy',
          reversible: 'snapshot',
        });
      } else {
        // Always special, never unattended, never undone (ADR 0071).
        expect(rules).toMatchObject({
          sensitivity: 'special',
          unattended: 'never',
          reversible: 'no',
          requiredRights: [],
        });
      }
    },
  );

  it('keys a page by its GUID in lower case, so that one page has one target', () => {
    const upper = {
      ...intents.wikiPageUpdate,
      guid: '00000000-0000-4000-8000-00000000ABCD',
    };
    expect(rulesOf(upper).target.key).toBe(
      '12/00000000-0000-4000-8000-00000000abcd',
    );
    expect(
      rulesOf({ ...intents.wikiSectionAppend, guid: upper.guid }).target,
    ).toEqual(rulesOf(upper).target);
  });

  it('covers every kind of intent', () => {
    expect(table.map(([kind]) => kind).sort()).toEqual(
      Object.keys(intents).sort(),
    );
  });

  it('names for the writes of the wiki the right of the rights mapping', () => {
    // The mapping is the source of the docs tools; a write of the core
    // must not need a right the mapping does not name for its operation.
    const mapping = JSON.parse(
      readFileSync(
        new URL(
          '../../../../scripts/docs/rights-mapping.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      readonly operations: readonly {
        readonly operationId: string;
        readonly needs: readonly {
          readonly rights: readonly {
            readonly module: string;
            readonly name: string;
          }[];
        }[];
      }[];
    };
    const rightsOf = (operationId: string) =>
      mapping.operations
        .find((operation) => operation.operationId === operationId)
        ?.needs.flatMap((need) =>
          need.rights.map(({ module, name }) => ({ module, right: name })),
        );
    const create = rightsOf('post-wiki-categories-id-pages');
    const update = rightsOf('patch-wiki-categories-id-pages-identifier');
    expect(create).toEqual([{ module: 'churchwiki', right: 'edit category' }]);
    expect(rulesOf(intents.wikiPageCreate).requiredRights).toEqual(create);
    expect(rulesOf(intents.wikiPageUpdate).requiredRights).toEqual(update);
    expect(rulesOf(intents.wikiSectionAppend).requiredRights).toEqual(update);
  });
});

describe('the metadata of the tool', () => {
  const base = rulesOf(intents.wikiPageUpdate);

  it.each<[Sensitivity, UnattendedRule, Sensitivity, UnattendedRule]>([
    ['none', 'policy', 'personal', 'policy'],
    ['personal', 'policy', 'personal', 'policy'],
    ['personal', 'never', 'personal', 'never'],
    ['special', 'never', 'special', 'never'],
    // A tool cannot be special and policy by its types; at run time the
    // core still makes it never.
    ['special', 'policy', 'special', 'never'],
  ])(
    'with %s and %s gives %s and %s',
    (sensitivity, unattended, expectedSensitivity, expectedUnattended) => {
      const rules = withToolMeta(base, { sensitivity, unattended });
      expect(rules.sensitivity).toBe(expectedSensitivity);
      expect(rules.unattended).toBe(expectedUnattended);
      expect(rules.target).toBe(base.target);
      expect(Object.isFrozen(rules)).toBe(true);
    },
  );

  it('keeps a rule of never from the intent, also for a tool that is not special', () => {
    const rules = withToolMeta(
      { ...base, unattended: 'never' },
      { sensitivity: 'personal', unattended: 'policy' },
    );
    expect(rules.unattended).toBe('never');
  });

  it('lets a tool make its write one that cannot be taken back, never the other way (ADR 0029)', () => {
    const meta = { sensitivity: 'personal', unattended: 'policy' } as const;
    expect(withToolMeta(base, { ...meta, reversible: 'no' }).reversible).toBe(
      'no',
    );
    expect(
      withToolMeta(base, { ...meta, reversible: 'snapshot' }).reversible,
    ).toBe(base.reversible);
    expect(
      withToolMeta(
        { ...base, reversible: 'no' },
        { ...meta, reversible: 'snapshot' },
      ).reversible,
    ).toBe('no');
    expect(withToolMeta(base, meta).reversible).toBe(base.reversible);
  });

  it('cannot loosen the rules of the Pro module', () => {
    const rules = withToolMeta(rulesOf(intents.groupMemberAdd), {
      sensitivity: 'none',
      unattended: 'policy',
    });
    expect(rules.sensitivity).toBe('special');
    expect(rules.unattended).toBe('never');
  });
});

describe('the echo', () => {
  it('is allowed only for a tool of the core and a write of the core', () => {
    const update = rulesOf(intents.wikiPageUpdate);
    expect(echoAllowed(update, 'core')).toBe(true);
    expect(echoAllowed(update, 'plugin')).toBe(false);
  });

  it.each(['groupMemberAdd', 'serviceRequest', 'apiOperation'] as const)(
    'is never allowed for %s, also from the core',
    (kind) => {
      expect(echoAllowed(rulesOf(intents[kind]), 'core')).toBe(false);
    },
  );

  it('is not allowed once the tool makes a write of the core special', () => {
    const rules = withToolMeta(rulesOf(intents.wikiPageCreate), {
      sensitivity: 'special',
      unattended: 'never',
    });
    expect(echoAllowed(rules, 'core')).toBe(false);
  });

  it('is not allowed for a write of the Pro module, even from the core and not special', () => {
    const update = rulesOf(intents.wikiPageUpdate);
    expect(echoAllowed({ ...update, module: 'pro' }, 'core')).toBe(false);
  });

  it('needs a write that a snapshot undoes and that need not go to the queue', () => {
    const update = rulesOf(intents.wikiPageUpdate);
    expect(echoAllowed({ ...update, reversible: 'yes' }, 'core')).toBe(false);
    expect(echoAllowed({ ...update, alwaysQueue: true }, 'core')).toBe(false);
  });
});
