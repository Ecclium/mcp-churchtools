// Features of answers without values: known error keys, the echo of a sent
// text and the hint @deprecated. None of them may show a value of the
// answer or the text the probe sent.
import { describe, expect, it } from 'vitest';

import { Guard } from '../../scripts/spike/lib/guard.mts';
import {
  describeDeprecation,
  describeEcho,
  describeErrorKeys,
} from '../../scripts/spike/lib/response-flags.mts';
import { Schemas, asOpenApi } from '../../scripts/spike/lib/spec.mts';
import { makeCanaries } from './support.mts';

const canaries = makeCanaries();
const marker = 'Spikeprobe';

const document = asOpenApi({
  openapi: '3.0.3',
  paths: {},
  components: {
    schemas: {
      Group: {
        type: 'object',
        properties: {
          '@deprecated': { type: 'object' },
          identifier: { type: 'string' },
          guid: { type: 'string' },
        },
      },
    },
  },
});
if (document === undefined) {
  throw new Error('document not accepted');
}
const schemas = new Schemas(document);
const groupSchema = { $ref: '#/components/schemas/Group' };

describe('the known error keys', () => {
  it('says which are there and counts the others, never a value', () => {
    const guard = new Guard();
    const body = {
      message: canaries.personName,
      translatedMessage: canaries.groupName,
      messageKey: 'error.unknown',
      args: { id: canaries.personId },
      [canaries.dataKey]: canaries.personEmail,
    };
    guard.blockAll(body);
    const output = describeErrorKeys(body, guard);
    expect(output).toEqual({
      message: 'ja',
      translatedMessage: 'ja',
      messageKey: 'ja',
      args: 'ja',
      errors: 'nein',
      weitereSchluessel: '1',
    });
    expect(guard.check(output)).toEqual([]);
  });

  it('names an answer that is no object', () => {
    expect(describeErrorKeys([], new Guard())).toBe('kein Objekt');
  });
});

describe('the echo of a sent text', () => {
  it('finds the text in any spelling and names the known key, not the text', () => {
    const guard = new Guard();
    const body = {
      message: `Kein Treffer für ${marker.toUpperCase()}`,
      args: { query: marker },
      data: [{ title: `${marker} Nord` }],
    };
    guard.blockAll(body);
    const output = describeEcho(body, marker, guard);
    expect(output).toEqual({
      echo: 'ja',
      unter: ['anderer Schlüssel', 'args', 'message'],
    });
    expect(guard.check(output)).toEqual([]);
    expect(JSON.stringify(output).toLowerCase()).not.toContain(
      marker.toLowerCase(),
    );
  });

  it('says no where the text does not come back', () => {
    expect(
      describeEcho({ message: canaries.personName }, marker, new Guard()),
    ).toEqual({ echo: 'nein', unter: [] });
  });
});

describe('the hint @deprecated', () => {
  it('names a pair only if the schema declares both fields', () => {
    const guard = new Guard();
    const object = {
      '@deprecated': { identifier: 'guid', [canaries.dataKey]: 'name' },
      guid: canaries.personId,
    };
    guard.blockAll(object);
    const output = describeDeprecation(object, groupSchema, schemas, guard);
    expect(output).toEqual({
      veraltet: 'vorhanden',
      ersetzt: [{ veraltet: 'identifier', ersatz: 'guid' }],
      andere: '1',
    });
    expect(guard.check(output)).toEqual([]);
  });

  it('shows no name the schema does not declare', () => {
    const guard = new Guard();
    const object = { '@deprecated': { identifier: canaries.personName } };
    guard.blockAll(object);
    const output = describeDeprecation(object, groupSchema, schemas, guard);
    expect(output).toEqual({ veraltet: 'vorhanden', ersetzt: [], andere: '1' });
    expect(JSON.stringify(output)).not.toContain(canaries.personName);
  });

  it('counts a pair with a name of the form of a field the schema does not declare', () => {
    const guard = new Guard();
    const object = {
      '@deprecated': { identifier: 'kanarienfeld', kanarienalt: 'guid' },
    };
    guard.blockAll(object);
    const output = describeDeprecation(object, groupSchema, schemas, guard);
    expect(output).toEqual({
      veraltet: 'vorhanden',
      ersetzt: [],
      andere: '2–9',
    });
    expect(JSON.stringify(output)).not.toContain('kanarien');
  });

  it('tells a missing hint and one of another form apart', () => {
    expect(describeDeprecation({}, groupSchema, schemas, new Guard())).toEqual({
      veraltet: 'fehlt',
    });
    expect(
      describeDeprecation(
        { '@deprecated': 'bald' },
        groupSchema,
        schemas,
        new Guard(),
      ),
    ).toEqual({ veraltet: 'vorhanden', ersetzt: 'anderer Wert' });
  });
});
