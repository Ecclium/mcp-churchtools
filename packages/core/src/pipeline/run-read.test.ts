import type { DataClass } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import type { ShapeNode } from '../registry/index.js';
import { cutEntries, entryListOf, personNamesOf } from './run-read.js';

// The entries a read of a run passes on and the names of its persons
// (ADR 0033), on shapes built by hand.

const presence = { optional: false, nullable: false } as const;

const leaf = (
  dataClass: DataClass,
  ...types: ('string' | 'number' | 'boolean')[]
) => ({ ...presence, kind: 'leaf', dataClass, types }) as const;

const object = (fields: Readonly<Record<string, ShapeNode>>) =>
  ({ ...presence, kind: 'object', fields }) as const;

const array = (element: ShapeNode) =>
  ({ ...presence, kind: 'array', element }) as const;

const person = object({
  personId: leaf('personId', 'number'),
  firstName: leaf('name.first', 'string'),
  lastName: leaf('name.last', 'string'),
});

const listRoot = object({
  page: leaf('none', 'number'),
  people: array(person),
  more: leaf('none', 'boolean'),
});

describe('the list of entries of a result', () => {
  it('is the one field of the top level that is a list', () => {
    expect(entryListOf(listRoot)).toBe('people');
  });

  it('is none for a result with no list or with two', () => {
    expect(entryListOf(object({ text: leaf('untrusted', 'string') }))).toBe(
      undefined,
    );
    expect(entryListOf(object({ a: array(person), b: array(person) }))).toBe(
      undefined,
    );
  });
});

describe('cutting the entries', () => {
  const people = [1, 2, 3].map((id) => ({
    personId: id,
    firstName: 'Max',
    lastName: 'Mustermann',
  }));

  it('keeps a list that fits and passes on its own more', () => {
    const data = Object.freeze({ page: 1, people, more: true });
    const cut = cutEntries(data, listRoot, 3);
    expect(cut).toEqual({ data, entries: 3, more: true });
    expect(cut.data).toBe(data);
    expect(cutEntries({ page: 1, people, more: false }, listRoot, 5).more).toBe(
      false,
    );
  });

  it('keeps the first entries and says that more follow', () => {
    const cut = cutEntries({ page: 1, people, more: false }, listRoot, 2);
    expect(cut.entries).toBe(2);
    expect(cut.more).toBe(true);
    expect(cut.data).toEqual({
      page: 1,
      people: people.slice(0, 2),
      more: true,
    });
    expect(Object.isFrozen(cut.data)).toBe(true);
    expect(Object.isFrozen(cut.data['people'])).toBe(true);
  });

  it('says more without a field of its own only when it cut', () => {
    const root = object({ people: array(person) });
    const cut = cutEntries({ people }, root, 1);
    expect(cut.data).toEqual({ people: people.slice(0, 1) });
    expect(cut.more).toBe(true);
    expect(cutEntries({ people }, root, 3).more).toBe(false);
  });

  it('counts a result without a list as one entry and a missing list as none', () => {
    const page = object({ text: leaf('untrusted', 'string') });
    expect(cutEntries({ text: 'Plan' }, page, 1)).toEqual({
      data: { text: 'Plan' },
      entries: 1,
      more: false,
    });
    expect(cutEntries({ page: 1, more: true }, listRoot, 4)).toEqual({
      data: { page: 1, more: true },
      entries: 0,
      more: true,
    });
  });

  it('reads more only from a field that is a switch', () => {
    const root = object({
      people: array(person),
      more: leaf('none', 'string'),
    });
    expect(cutEntries({ people, more: 'yes' }, root, 5).more).toBe(false);
  });
});

describe('the names of the persons', () => {
  const key = (id: number): string => `p-${String(id)}`;

  it('maps what the model sees to first and last name in the level standard', () => {
    const names = personNamesOf(
      {
        page: 1,
        people: [
          { personId: 12, firstName: ' Max ', lastName: 'Mustermann' },
          { personId: 13, firstName: 'Erika', lastName: '' },
          { personId: 14, firstName: null, lastName: 'Muster' },
        ],
        more: false,
      },
      listRoot,
      key,
    );
    expect(names).toEqual({
      'p-12': 'Max Mustermann',
      'p-13': 'Erika',
      'p-14': 'Muster',
    });
    expect(Object.isFrozen(names)).toBe(true);
    expect(Object.getPrototypeOf(names)).toBe(null);
  });

  it('removes hidden characters from a name, as standard does', () => {
    const names = personNamesOf(
      { people: [{ personId: 12, firstName: 'Ma​x', lastName: 'M' }] },
      object({ people: array(person) }),
      String,
    );
    expect(names['12']).not.toContain('​');
  });

  it('knows a person without a name, in a list of IDs or beside another person', () => {
    const root = object({
      ids: array(leaf('personId', 'number')),
      pair: object({
        a: leaf('personId', 'number'),
        b: leaf('personId', 'number'),
        firstName: leaf('name.first', 'string'),
      }),
      lone: object({ personId: leaf('personId', 'number') }),
      gone: person,
    });
    const names = personNamesOf(
      {
        ids: [1, 2],
        pair: { a: 3, b: 4, firstName: 'Max' },
        lone: { personId: 5 },
        gone: null,
      },
      root,
      key,
    );
    expect(names).toEqual({
      'p-1': '',
      'p-2': '',
      'p-3': '',
      'p-4': '',
      'p-5': '',
    });
  });

  it('keeps a name over an empty one, whichever comes first', () => {
    const root = object({
      ids: array(leaf('personId', 'number')),
      people: array(person),
      later: array(leaf('personId', 'number')),
    });
    const names = personNamesOf(
      {
        ids: [12],
        people: [{ personId: 12, firstName: 'Max', lastName: 'Muster' }],
        later: [12],
      },
      root,
      key,
    );
    expect(names).toEqual({ 'p-12': 'Max Muster' });
  });

  it('walks tuples and skips an ID that is no number', () => {
    const root = object({
      pair: {
        ...presence,
        kind: 'tuple',
        items: [person, leaf('personId', 'number', 'string')],
      },
      odd: object({ personId: leaf('personId', 'number', 'string') }),
    });
    const names = personNamesOf(
      {
        pair: [{ personId: 7, firstName: 'Max', lastName: 'M' }, 'x'],
        odd: { personId: 'y' },
      },
      root,
      key,
    );
    expect(names).toEqual({ 'p-7': 'Max M' });
  });

  it('passes on what the key of an ID throws', () => {
    expect(() =>
      personNamesOf(
        { people: [{ personId: 1, firstName: 'A', lastName: 'B' }] },
        object({ people: array(person) }),
        () => {
          throw new TypeError('no pseudonym');
        },
      ),
    ).toThrow('no pseudonym');
  });
});
