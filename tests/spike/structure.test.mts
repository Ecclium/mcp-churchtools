import { describe, expect, it } from 'vitest';

import { Guard } from '../../scripts/spike/lib/guard.mts';
import { Schemas, asOpenApi } from '../../scripts/spike/lib/spec.mts';
import {
  countClass,
  describe as describeValue,
  textFeatures,
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

  it('shows a declared key although a value names it, as @deprecated does', () => {
    const guard = new Guard();
    const value = {
      identifier: 'page-id-1',
      title: 'Ablauf eines Probentags',
      '@deprecated': { identifier: 'title' },
    };
    guard.blockAll(value);
    const shape = describeValue(
      value,
      { $ref: '#/components/schemas/Page' },
      { guard, schemas, keys: 'specification' },
    );
    expect(Object.keys((shape as { felder: object }).felder)).toEqual([
      'identifier',
      'title',
      '<key#1>',
    ]);
    expect(guard.check(shape)).toEqual([]);
  });

  it('still withholds a lower-case key that equals a value of the response', () => {
    const guard = new Guard();
    guard.blockAll(['Jugend']);
    const shape = describeValue({ jugend: { view: true } }, undefined, {
      guard,
      schemas,
      keys: 'lowercaseWords',
      booleanValues: true,
    });
    expect(guard.check(shape)).toEqual(['/felder/#0']);
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

  it('describes 50 fields of an object by default and more on request', () => {
    const guard = new Guard();
    const names = Array.from(
      { length: 60 },
      (_, index) => `feld${String(index)}`,
    );
    const schema = {
      type: 'object',
      properties: Object.fromEntries(
        names.map((name) => [name, { type: 'string' }]),
      ),
    };
    const value = Object.fromEntries(names.map((name) => [name, 'x']));
    const cut = describeValue(value, schema, {
      guard,
      schemas,
      keys: 'specification',
    }) as { felder: Record<string, unknown>; weitereFelder?: string };
    expect(Object.keys(cut.felder)).toHaveLength(50);
    expect(cut.weitereFelder).toBe('10–99');
    const whole = describeValue(value, schema, {
      guard,
      schemas,
      keys: 'specification',
      maxFields: 200,
    }) as { felder: Record<string, unknown>; weitereFelder?: string };
    expect(Object.keys(whole.felder)).toEqual(names);
    expect(whole.weitereFelder).toBeUndefined();
  });
});

describe('textFeatures', () => {
  it.each([
    ['2026-10-11', { format: 'Datum' }],
    [
      '2026-10-11T08:15:00Z',
      {
        format: 'Datum mit Zeit',
        trenner: 'T',
        sekunden: 'ja',
        bruchteile: 'keine',
        zone: 'Z',
      },
    ],
    [
      '2026-10-11 08:15',
      {
        format: 'Datum mit Zeit',
        trenner: 'Leerzeichen',
        sekunden: 'nein',
        bruchteile: 'keine',
        zone: 'keine',
      },
    ],
    [
      '2026-10-11T08:15:00.123+02:00',
      {
        format: 'Datum mit Zeit',
        trenner: 'T',
        sekunden: 'ja',
        bruchteile: '1-3 Stellen',
        zone: 'Versatz',
      },
    ],
    [
      '2026-10-11T08:15:00.123456+0200',
      {
        format: 'Datum mit Zeit',
        trenner: 'T',
        sekunden: 'ja',
        bruchteile: 'mehr',
        zone: 'Versatz',
      },
    ],
    ['11.10.2026', { format: 'anderer Text' }],
    ['2026-10-11 und mehr', { format: 'anderer Text' }],
    ['vor 2026-10-11', { format: 'anderer Text' }],
    ['vor 2026-10-11T08:15', { format: 'anderer Text' }],
    ['2026-10-11T08:15:00Z x', { format: 'anderer Text' }],
  ])('describes %s by features only', (text, expected) => {
    expect(textFeatures(text)).toEqual(expected);
  });
});

describe('describe with the features of texts', () => {
  const canaries = makeCanaries();
  const birthday = `19${String(canaries.number).slice(0, 2)}-04-17`;
  const value = { firstName: canaries.personName, birthday };

  it('shows the features of a date, never the date', () => {
    const guard = new Guard();
    guard.blockAll(value);
    const output = describeValue(value, person, {
      guard,
      schemas,
      keys: 'specification',
      textFormats: true,
    });
    expect(output).toEqual({
      typ: 'Objekt',
      felder: {
        firstName: {
          typ: 'Text',
          inhalt: 'nicht leer',
          format: 'anderer Text',
        },
        birthday: { typ: 'Text', inhalt: 'nicht leer', format: 'Datum' },
      },
    });
    expect(guard.check(output)).toEqual([]);
    expect(JSON.stringify(output)).not.toContain(birthday);
  });

  it('keeps every other description as it was', () => {
    const output = describeValue(value, person, {
      guard: new Guard(),
      schemas,
      keys: 'specification',
    });
    expect(JSON.stringify(output)).not.toContain('format');
  });
});
