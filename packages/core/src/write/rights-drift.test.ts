import type {
  GrantedRights,
  IsoDate,
  RightRef,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { checkPolicy } from '../policy/check.js';
import type { UnattendedEntry } from '../policy/schema.js';
import {
  editCategoriesOf,
  rightsBeyond,
  rightsDriftAccepted,
  type RunAccountNeeds,
  wikiEditRight,
} from './rights-drift.js';

// Rights an account of a run should not have, and the exception of the
// policy that lets its runs write all the same (ADR 0032).

const guid = '0000000a-0000-4000-8000-000000000001';
const view: RightRef = { module: 'churchwiki', right: 'view' };

const entriesOf = (
  unattended: readonly unknown[],
): readonly UnattendedEntry[] => {
  const result = checkPolicy({ schema: 'policy.v1', unattended });
  if (!result.ok) throw new Error(result.code);
  return result.policy.unattended;
};

const routineEntry = (target: unknown, more: Record<string, unknown> = {}) => ({
  routine: 'dienstplan-report',
  credential: 'bericht',
  target,
  tools: ['ct_wiki_page_append_section'],
  maxPerRun: 1,
  maxPerDay: 2,
  ...more,
});

const needsOf = (
  rights: readonly RightRef[],
  categories: readonly number[] = [],
): RunAccountNeeds => ({ rights, editCategories: new Set(categories) });

// Values ChurchTools could send that the type of the rights does not name,
// such as `false` or an ID as text.
const granted = (value: unknown): GrantedRights => value as GrantedRights;

describe('the categories the entries of an account write to', () => {
  it('are those of the targets of categories and of pages, each once', () => {
    const entries = entriesOf([
      routineEntry({ kind: 'wiki_category', id: 12, name: 'Berichte' }),
      routineEntry(
        { kind: 'wiki_page', categoryId: 13, guid, name: 'Dienstplan' },
        { tools: ['ct_wiki_page_update'] },
      ),
      routineEntry(
        { kind: 'wiki_category', id: 12, name: 'Berichte' },
        { routine: 'wiki-hygiene' },
      ),
      routineEntry(
        { kind: 'calendar', id: 3, name: 'Gottesdienste' },
        { tools: ['ct_appointments_create'] },
      ),
      routineEntry(
        { kind: 'resource', id: 4, name: 'Beamer' },
        { tools: ['ct_bookings_create'] },
      ),
    ]);
    expect([...editCategoriesOf(entries)]).toEqual([12, 13]);
  });

  it('are none without entries', () => {
    expect(editCategoriesOf([]).size).toBe(0);
  });
});

describe('the rights of an account beyond what its routines need', () => {
  it('are none when every granted right is needed', () => {
    expect(
      rightsBeyond(
        { churchwiki: { view: true, 'edit category': [12, 13] } },
        needsOf([view, wikiEditRight], [12, 13]),
      ),
    ).toEqual([]);
  });

  it('count only a right that is true or a list with entries', () => {
    expect(
      rightsBeyond(
        granted({
          churchwiki: { view: true, 'view category': [] },
          churchdb: { 'view alldata': false, view: [] },
          churchcal: {},
        }),
        needsOf([view]),
      ),
    ).toEqual([]);
  });

  it('name a granted right no tool needs, also one of another module with the same name', () => {
    expect(
      rightsBeyond(
        {
          churchwiki: { view: true },
          churchcal: { view: [3] },
          churchdb: { 'view alldata': [1] },
        },
        needsOf([view]),
      ),
    ).toEqual([
      { module: 'churchcal', right: 'view' },
      { module: 'churchdb', right: 'view alldata' },
    ]);
  });

  it.each([
    ['every category at once', true, [12]],
    ['a category outside the entries', [12, 14], [12]],
    ['an ID that is no number', [12, '13'], [12, 13]],
    ['NaN as an ID', [12, Number.NaN], [12]],
  ])(
    'name the right to edit categories of the wiki for %s',
    (_name, value, categories) => {
      expect(
        rightsBeyond(
          granted({ churchwiki: { 'edit category': value } }),
          needsOf([wikiEditRight], categories),
        ),
      ).toEqual([wikiEditRight]);
    },
  );

  it('name the right to edit categories when no tool needs it, whatever its list', () => {
    expect(
      rightsBeyond(
        { churchwiki: { 'edit category': [12] } },
        needsOf([view], [12]),
      ),
    ).toEqual([wikiEditRight]);
  });

  // Only the right to edit categories of the wiki is compared with the
  // targets of the policy; the scope of every other right is not.
  it('compare the list of no other needed right with the categories', () => {
    expect(
      rightsBeyond(
        {
          churchwiki: { 'view category': [99] },
          churchcal: { 'edit category': [3] },
        },
        needsOf(
          [
            { module: 'churchwiki', right: 'view category' },
            { module: 'churchcal', right: 'edit category' },
          ],
          [12],
        ),
      ),
    ).toEqual([]);
  });

  it('come in the order of the answer, frozen', () => {
    const beyond = rightsBeyond(
      {
        churchwiki: {
          'edit category': true,
          view: true,
          'edit masterdata': true,
        },
        churchdb: { 'view alldata': [1] },
      },
      needsOf([view, wikiEditRight], [12]),
    );
    expect(beyond).toEqual([
      wikiEditRight,
      { module: 'churchwiki', right: 'edit masterdata' },
      { module: 'churchdb', right: 'view alldata' },
    ]);
    expect(Object.isFrozen(beyond)).toBe(true);
    expect(beyond.every((ref) => Object.isFrozen(ref))).toBe(true);
    expect(Object.isFrozen(wikiEditRight)).toBe(true);
  });
});

describe('the exception for rights of a routine', () => {
  const day = (text: string): IsoDate => text as IsoDate;
  const excepted = entriesOf([
    routineEntry(
      { kind: 'wiki_category', id: 12, name: 'Berichte' },
      { acceptRightsDrift: { from: '2026-11-01', until: '2026-11-10' } },
    ),
  ]);

  it.each([
    ['its first day', '2026-11-01'],
    ['a day within', '2026-11-05'],
    ['its last day', '2026-11-10'],
  ])('holds on %s', (_name, today) => {
    expect(rightsDriftAccepted(excepted, day(today))).toBe(true);
  });

  it.each([
    ['the day before its first', '2026-10-31'],
    ['the day after its last', '2026-11-11'],
    ['a day of another year', '2027-11-05'],
  ])('does not hold on %s', (_name, today) => {
    expect(rightsDriftAccepted(excepted, day(today))).toBe(false);
  });

  it('does not hold without a day, without an exception or without entries', () => {
    expect(rightsDriftAccepted(excepted, undefined)).toBe(false);
    const without = entriesOf([
      routineEntry({ kind: 'wiki_category', id: 12, name: 'Berichte' }),
    ]);
    expect(rightsDriftAccepted(without, day('2026-11-05'))).toBe(false);
    expect(rightsDriftAccepted([], day('2026-11-05'))).toBe(false);
  });
});
