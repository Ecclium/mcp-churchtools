import { describe, expect, it } from 'vitest';

import {
  auditFieldSchemas,
  createObjectRefCollector,
  type ObjectDomain,
  objectDomains,
  objectRefOf,
} from './index.js';

const guid = 'a1b2c3d4-0000-4000-8000-00000000000f';

describe('objectRefOf', () => {
  it('writes whole numbers and digits as they are', () => {
    expect(objectRefOf('person', 12)).toBe('person:12');
    expect(objectRefOf('person', 0)).toBe('person:0');
    expect(objectRefOf('group', '7')).toBe('group:7');
    expect(objectRefOf('song', Number.MAX_SAFE_INTEGER)).toBe(
      `song:${String(Number.MAX_SAFE_INTEGER)}`,
    );
  });

  it('writes a GUID in lower case', () => {
    expect(objectRefOf('wiki_page', guid.toUpperCase())).toBe(
      `wiki_page:${guid}`,
    );
  });

  it.each([
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['an unsafe integer', 2 ** 53],
    ['not a number', Number.NaN],
    ['a name', 'Max'],
    ['an e-mail address', 'max.mustermann@example.org'],
    ['17 digits', '1'.repeat(17)],
    ['an empty text', ''],
    ['a GUID with a suffix', `${guid}x`],
    ['a long text', 'a'.repeat(10_000_000)],
    ['null', null],
    ['an object', { id: 1 }],
    ['a boolean', true],
  ])('gives nothing for %s', (_what, value) => {
    expect(objectRefOf('person', value)).toBeUndefined();
  });

  it('gives nothing for a domain outside the closed list', () => {
    expect(objectRefOf('mustermann' as ObjectDomain, 1)).toBeUndefined();
  });

  it('makes only entries the audit schema takes', () => {
    for (const domain of objectDomains) {
      for (const value of [0, '1'.repeat(16), guid.toUpperCase()]) {
        const ref = objectRefOf(domain as ObjectDomain, value);
        expect(auditFieldSchemas.objectRef.safeParse(ref).success, ref).toBe(
          true,
        );
      }
    }
  });
});

describe('createObjectRefCollector', () => {
  it('keeps each entry once, in the order it came', () => {
    const refs = createObjectRefCollector();
    expect(refs.add('group', 7)).toBe(true);
    expect(refs.add('person', 12)).toBe(true);
    expect(refs.add('group', '7')).toBe(true);
    expect(refs.add('person', 'Max')).toBe(false);
    expect(refs.list()).toEqual({ refs: ['group:7', 'person:12'], omitted: 0 });
  });

  it('keeps the first 100 and counts the distinct ones after them', () => {
    const refs = createObjectRefCollector();
    for (let id = 1; id <= 130; id += 1) refs.add('person', id);
    refs.add('person', 120);
    refs.add('person', 1);
    const list = refs.list();
    expect(list.refs).toHaveLength(100);
    expect(list.refs[0]).toBe('person:1');
    expect(list.refs[99]).toBe('person:100');
    expect(list.omitted).toBe(30);
  });

  it('gives a frozen copy that later entries do not change', () => {
    const refs = createObjectRefCollector();
    refs.add('event', 1);
    const first = refs.list();
    refs.add('event', 2);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.refs)).toBe(true);
    expect(first.refs).toEqual(['event:1']);
    expect(Object.isFrozen(refs)).toBe(true);
  });

  it('stops keeping track of entries at a bound and still counts', () => {
    const refs = createObjectRefCollector();
    for (let id = 0; id < 100_000; id += 1) refs.add('person', id);
    // Past the bound, a repeated entry is counted again, never kept.
    refs.add('person', 100_000);
    refs.add('person', 100_000);
    const list = refs.list();
    expect(list.refs).toHaveLength(100);
    expect(list.omitted).toBe(99_902);
  });
});
