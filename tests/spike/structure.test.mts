import { describe, expect, it } from 'vitest';

import { Guard } from '../../scripts/spike/lib/guard.mts';
import { Schemas, asOpenApi } from '../../scripts/spike/lib/spec.mts';
import {
  countClass,
  describe as describeValue,
} from '../../scripts/spike/lib/structure.mts';
import { makeCanaries, specification } from './support.mts';

const document = asOpenApi(specification);
if (document === undefined) {
  throw new Error('synthetic document is not accepted');
}
const schemas = new Schemas(document);
const person = { $ref: '#/components/schemas/Person' };

describe('countClass', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [2, '2–9'],
    [9, '2–9'],
    [10, '10–99'],
    [99, '10–99'],
    [100, '100–999'],
    [999, '100–999'],
    [1000, 'ab 1000'],
  ])('%i belongs to %s', (count, expected) => {
    expect(countClass(count)).toBe(expected);
  });
});

describe('describe', () => {
  it('names declared keys and hides every value', () => {
    const canaries = makeCanaries();
    const guard = new Guard();
    const value = {
      id: canaries.number,
      firstName: canaries.personName,
      lastName: '',
      email: canaries.personEmail,
      [canaries.groupName]: true,
      [canaries.dataKey]: canaries.personId,
    };
    guard.blockAll(value);
    const shape = describeValue(value, person, {
      guard,
      schemas,
      keys: 'specification',
    });
    expect(shape).toEqual({
      typ: 'Objekt',
      felder: {
        id: { typ: 'Zahl' },
        firstName: { typ: 'Text', inhalt: 'nicht leer' },
        lastName: { typ: 'Text', inhalt: 'leer' },
        email: { typ: 'Text', inhalt: 'nicht leer' },
        // Integer-like keys come first in a JavaScript object.
        '<key#1>': { typ: 'Text', inhalt: 'nicht leer' },
        '<key#2>': { typ: 'Wahrheitswert' },
      },
    });
    expect(guard.check(shape)).toEqual([]);
    const text = JSON.stringify(shape).toLowerCase();
    for (const secret of [
      canaries.personName,
      canaries.personEmail,
      canaries.personId,
      canaries.groupName,
      String(canaries.number),
    ]) {
      expect(text).not.toContain(secret.toLowerCase());
    }
  });

  it('never names a key without a schema, not even one that looks like a field', () => {
    const guard = new Guard();
    const shape = describeValue({ firstName: 'x', 12: 'y' }, undefined, {
      guard,
      schemas,
      keys: 'specification',
    });
    expect(Object.keys((shape as { felder: object }).felder)).toEqual([
      '<key#1>',
      '<key#2>',
    ]);
  });

  it('summarises lists by count class and distinct forms', () => {
    const guard = new Guard();
    const list = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0 ? 'a' : index,
    );
    expect(
      describeValue(list, undefined, { guard, schemas, keys: 'specification' }),
    ).toEqual({
      typ: 'Liste',
      anzahl: '10–99',
      formen: [{ typ: 'Text', inhalt: 'nicht leer' }, { typ: 'Zahl' }],
    });
  });

  it('shows lower-case right names and their truth values for permissions', () => {
    const guard = new Guard();
    const shape = describeValue(
      {
        churchwiki: { view: true, 'edit category': [3, 4] },
        'Jugend Zürich': {},
      },
      undefined,
      { guard, schemas, keys: 'lowercaseWords', booleanValues: true },
    );
    expect(shape).toEqual({
      typ: 'Objekt',
      felder: {
        churchwiki: {
          typ: 'Objekt',
          felder: {
            view: { typ: 'Wahrheitswert', wert: 'wahr' },
            'edit category': {
              typ: 'Liste',
              anzahl: '2–9',
              formen: [{ typ: 'Zahl' }],
            },
          },
        },
        '<key#1>': { typ: 'Objekt', felder: {} },
      },
    });
    expect(guard.check(shape)).toEqual([]);
  });

  it('stops at a fixed depth', () => {
    const guard = new Guard();
    let deep: unknown = 'x';
    for (let level = 0; level < 20; level++) {
      deep = [deep];
    }
    expect(
      JSON.stringify(
        describeValue(deep, undefined, {
          guard,
          schemas,
          keys: 'specification',
        }),
      ),
    ).toContain('zu tief');
  });
});
