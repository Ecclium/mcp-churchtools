import {
  type CatalogEntry,
  createToolCatalog,
  toolsetNames,
} from '@ecclium/mcp-churchtools-core';
import { dataClassOf, objectKindOf } from '@ecclium/mcp-churchtools-plugin-api';
import { syntheticDocsIndex } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { createCorePlugin } from './index.js';

// The IDs each tool of the core gives the audit (ADR 0028): its pages are
// sized so that no call names more than the 100 IDs an audit line holds.

const catalog = createToolCatalog({
  core: createCorePlugin({ docs: syntheticDocsIndex() }),
  plugins: [],
  readOnly: true,
  toolsets: new Set(toolsetNames),
});

interface Def {
  readonly type: string;
  readonly [key: string]: unknown;
}

const defOf = (schema: unknown): Def =>
  (schema as { readonly _zod: { readonly def: Def } })._zod.def;

// The smallest maximum the checks of an array declare.
const maxOf = (def: Def): number => {
  let bound = Number.POSITIVE_INFINITY;
  for (const check of (def['checks'] as unknown[] | undefined) ?? []) {
    const checkDef = defOf(check) as Def & {
      readonly check?: string;
      readonly maximum?: number;
    };
    if (checkDef.check === 'max_length' && checkDef.maximum !== undefined) {
      bound = Math.min(bound, checkDef.maximum);
    }
  }
  return bound;
};

const wrappers = ['optional', 'nullable', 'default', 'readonly'];

// The most IDs a value of a schema can name: a leaf of the classes
// personId or groupId, or, in the input, a leaf with a kind of object.
const mostIds = (schema: unknown, input: boolean): number => {
  const def = defOf(schema);
  if (wrappers.includes(def.type)) return mostIds(def['innerType'], input);
  switch (def.type) {
    case 'object':
      return Object.values(def['shape'] as Record<string, unknown>).reduce(
        (sum: number, field) => sum + mostIds(field, input),
        0,
      );
    case 'array': {
      const each = mostIds(def['element'], input);
      return each === 0 ? 0 : each * maxOf(def);
    }
    case 'union':
      return Math.max(
        ...(def['options'] as unknown[]).map((option) =>
          mostIds(option, input),
        ),
      );
    case 'record':
      return mostIds(def['valueType'], input) === 0
        ? 0
        : Number.POSITIVE_INFINITY;
    default: {
      const dataClass = dataClassOf(schema as z.core.$ZodType);
      if (dataClass === 'personId' || dataClass === 'groupId') return 1;
      return input && objectKindOf(schema as z.core.$ZodType) !== undefined
        ? 1
        : 0;
    }
  }
};

const entries = catalog.list();

describe('the IDs of the tools of the core', () => {
  it('stay within the 100 of an audit line for every tool', () => {
    expect(entries.length).toBeGreaterThanOrEqual(32);
    const over: string[] = [];
    for (const entry of entries) {
      const most = mostIds(entry.input, true) + mostIds(entry.output, false);
      if (most > 100) over.push(`${entry.name}: ${String(most)}`);
    }
    expect(over).toEqual([]);
  });

  it('read the IDs of the escape hatch from the checked request, not from its input', () => {
    const entry = catalog.get('ct_api_execute_read') as CatalogEntry;
    expect(entry.inputRefs).toBeUndefined();
  });

  it.each([
    ['ct_persons_get', { personId: 'person' }],
    ['ct_persons_get_groups', { personId: 'person' }],
    ['ct_groups_get', { groupId: 'group' }],
    ['ct_groups_get_members', { groupId: 'group' }],
    ['ct_events_get', { eventId: 'event' }],
    ['ct_events_get_agenda', { eventId: 'event' }],
    ['ct_services_get_assignments', { eventId: 'event' }],
    [
      'ct_appointments_get',
      { calendarId: 'calendar', appointmentId: 'appointment' },
    ],
    ['ct_songs_get', { songId: 'song' }],
    ['ct_wiki_pages_list', { categoryId: 'wiki_category' }],
    ['ct_wiki_page_get', { categoryId: 'wiki_category', guid: 'wiki_page' }],
    ['ct_wiki_search', { categoryId: 'wiki_category' }],
  ])('names the kind of each ID of the input of %s', (name, expected) => {
    const refs = catalog.get(name)?.inputRefs;
    expect(refs?.kind).toBe('object');
    const fields = refs?.kind === 'object' ? refs.fields : {};
    expect(
      Object.fromEntries(
        Object.entries(fields).map(([key, node]) => [
          key,
          node.kind === 'leaf' ? node.domain : node.kind,
        ]),
      ),
    ).toEqual(expected);
  });

  it.each([
    ['ct_appointments_list', 'calendarIds', 'calendar'],
    ['ct_bookings_list', 'resourceIds', 'resource'],
  ])(
    'names the kind of each ID of a list in the input of %s',
    (name, field, kind) => {
      const refs = catalog.get(name)?.inputRefs;
      expect(refs).toEqual({
        kind: 'object',
        fields: {
          [field]: { kind: 'list', element: { kind: 'leaf', domain: kind } },
        },
      });
    },
  );

  it('gives tools without IDs in the input none', () => {
    for (const name of [
      'ct_whoami',
      'ct_persons_search',
      'ct_groups_search',
      'ct_search',
      'ct_events_list',
      'ct_calendars_list',
      'ct_docs_search_api',
    ]) {
      expect(catalog.get(name)?.inputRefs, name).toBeUndefined();
    }
  });
});
