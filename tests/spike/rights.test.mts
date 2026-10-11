// The description of the effective rights. It must show which read rights
// are set and how their values look, never a value, and no value from an
// answer may withhold the name of a right.
import { describe, expect, it } from 'vitest';

import { SpikeError } from '../../scripts/spike/lib/errors.mts';
import { Guard } from '../../scripts/spike/lib/guard.mts';
import { describeEffectiveRights } from '../../scripts/spike/lib/rights.mts';

const ids = [48_213, 51_877];

function rights(
  values: Readonly<Record<string, unknown>> = {},
): Record<string, Record<string, unknown>> {
  return {
    churchwiki: {
      view: true,
      'view category': [ids[0]],
      'edit category': [],
    },
    churchdb: {
      view: false,
      'view alldata': [],
      'view hidden persons': false,
      ...values,
    },
    churchgroup: { view: false },
  };
}

describe('the description of the effective rights', () => {
  it('shows only the effective rights, with classes instead of values', () => {
    const guard = new Guard();
    const output = describeEffectiveRights(
      rights({ view: true, 'view alldata': ids }),
      guard,
    );
    expect(output).toEqual({
      churchwiki: {
        view: { typ: 'Wahrheitswert', wert: 'wahr' },
        'view category': {
          typ: 'Liste',
          anzahl: '1',
          elemente: { 'Zahl positiv': '1' },
        },
      },
      churchdb: {
        view: { typ: 'Wahrheitswert', wert: 'wahr' },
        'view alldata': {
          typ: 'Liste',
          anzahl: '2–9',
          elemente: { 'Zahl positiv': '2–9' },
        },
      },
    });
    expect(guard.check(output)).toEqual([]);
    const text = JSON.stringify(output);
    for (const id of ids) {
      expect(text).not.toContain(String(id));
    }
  });

  it.each([
    [[-1], { typ: 'Liste', anzahl: '1', elemente: { 'Zahl negativ': '1' } }],
    [[0], { typ: 'Liste', anzahl: '1', elemente: { 'Zahl 0': '1' } }],
    [['alle'], { typ: 'Liste', anzahl: '1', elemente: { Text: '1' } }],
    [
      [1.5, {}],
      {
        typ: 'Liste',
        anzahl: '2–9',
        elemente: { 'Zahl nicht ganz': '1', Objekt: '1' },
      },
    ],
    [[null], { typ: 'Liste', anzahl: '1', elemente: { anderes: '1' } }],
    [-1, { typ: 'Zahl', klasse: 'negativ' }],
    [7, { typ: 'Zahl', klasse: 'positiv' }],
    ['alle', { typ: 'Text', inhalt: 'nicht leer' }],
    [{ a: 1 }, { typ: 'Objekt', felder: '1' }],
    [null, { typ: 'null' }],
  ])('classifies %o without its value', (value, expected) => {
    const guard = new Guard();
    const output = describeEffectiveRights(
      rights({ 'view groups of grouptype': value }),
      guard,
    ) as Record<string, Record<string, unknown>>;
    expect(output['churchdb']?.['view groups of grouptype']).toEqual(expected);
    expect(guard.check(output as never)).toEqual([]);
  });

  it('leaves out a module without an effective right', () => {
    const output = describeEffectiveRights(rights(), new Guard());
    expect(Object.keys(output as object)).toEqual(['churchwiki']);
  });

  it('stops on an effective right that is not in its table', () => {
    expect(() =>
      describeEffectiveRights(
        rights({ 'view hidden persons': true }),
        new Guard(),
      ),
    ).toThrow(SpikeError);
    expect(() =>
      describeEffectiveRights(
        { ...rights(), churchcal: { view: true } },
        new Guard(),
      ),
    ).toThrow(SpikeError);
  });

  it('keeps the names of rights when answers put person and group on the block list', () => {
    const guard = new Guard();
    // Values of answers about persons and groups, as the probe reads them.
    guard.blockAll({ domainType: 'person', type: 'group', name: 'view' });
    const output = describeEffectiveRights(
      rights({
        view: true,
        'security level person': [1, 2],
        'security level group': [1],
        'view group': [ids[1]],
      }),
      guard,
    );
    expect(guard.check(output)).toEqual([]);
    expect(JSON.stringify(output)).toContain('security level person');
  });
});
