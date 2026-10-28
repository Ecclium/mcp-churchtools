import { readFileSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { allowsNull, run, typeClass } from '../../scripts/contract/check.mts';
import { createState, instanceId } from '../../scripts/spike/lib/env.mts';
import {
  capture,
  origin,
  privateFiles,
  specification,
} from '../spike/support.mts';

// The check reads only contract.json and the state file of 00-inventory,
// here with the synthetic OpenAPI document of the spike tests or a small
// document of its own.

const contract = readFileSync(
  new URL('../../packages/core/src/churchtools/contract.json', import.meta.url),
  'utf8',
);

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const withState = (document: unknown = specification) => {
  const files = privateFiles('unused');
  folders.push(files.folder);
  createState(files.stateFile, {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(origin),
    version: '3.137',
    specification: document as never,
  });
  return {
    ECCLIUM_SPIKE_BASE_URL: origin,
    ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
  };
};

interface Field {
  deklariert: boolean;
  typ: string;
  pflicht: boolean;
  nullable: boolean;
}

interface Result {
  churchtoolsVersion: string;
  operationen: Record<
    string,
    {
      pfad: string;
      dokumentiert: boolean;
      veraltet: boolean;
      parameter: Record<string, boolean>;
      felder?: Record<string, Field>;
      werteAlsMap?: boolean;
    }
  >;
  abweichungen: { operation: string; feld?: string; art: string }[];
}

const check = (
  document: unknown = specification,
  contractText = contract,
): Result => {
  const output = capture();
  expect(run(withState(document), contractText, output.io)).toBe(0);
  return JSON.parse(output.stdout()) as Result;
};

// A small document: a list that may be null, entries built with allOf from
// a referenced base, a list in a list, and a field that may be null.
const nestedDocument = {
  openapi: '3.0.3',
  info: { title: 'Synthetic test document', version: '0.0.0' },
  servers: [{ url: `${origin}/api` }],
  paths: {
    '/things': {
      get: {
        parameters: [{ name: 'from', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ThingList' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ThingList: {
        type: 'object',
        properties: {
          data: {
            anyOf: [
              { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
              { type: 'null' },
            ],
          },
        },
      },
      Thing: {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          {
            type: 'object',
            properties: { note: { type: 'string', nullable: true } },
          },
        ],
      },
      Base: {
        type: 'object',
        required: ['outer', 'tags'],
        properties: {
          outer: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              size: { type: 'string' },
            },
          },
          tags: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label'],
              properties: { label: { type: 'string' } },
            },
          },
          // Days as a map keyed by day, or as a list without a form for
          // its entries.
          days: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: { $ref: '#/components/schemas/Day' },
              },
              { type: 'array', items: {} },
            ],
          },
        },
      },
      Day: {
        type: 'object',
        properties: { start: { type: 'string' } },
      },
    },
  },
};

// The contract for that document, in the form contract.json has: two
// entries on one operation, and a building block without a path.
const nestedContract = JSON.stringify({
  things: {
    method: 'get',
    path: '/api/things',
    query: ['from', 'to'],
    response: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              outer: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  size: { type: 'integer' },
                  gone: {
                    type: 'object',
                    properties: { deeper: { type: 'string' } },
                  },
                },
                required: ['title', 'size'],
              },
              tags: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { label: { type: 'string' } },
                  required: ['label'],
                },
              },
              note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              days: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { start: { type: 'string' } },
                      required: ['start'],
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: {
                      type: 'object',
                      properties: { start: { type: 'string' } },
                      required: ['start'],
                    },
                  },
                ],
              },
            },
            required: ['outer', 'tags', 'note'],
          },
        },
      },
      required: ['data'],
    },
  },
  thingTags: {
    method: 'get',
    path: '/api/things',
    query: [],
    response: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: { tags: { type: 'array' } },
          },
        },
      },
    },
  },
  meta: { meta: { type: 'object' } },
});

describe('the contract check', () => {
  it('reports every operation of the contract in its order', () => {
    const result = check();
    const operations = Object.entries(
      JSON.parse(contract) as Record<string, { path?: unknown }>,
    )
      .filter(([, entry]) => typeof entry.path === 'string')
      .map(([name]) => name);
    // 28 entries on 27 operations: event and eventAssignments share one.
    expect(operations).toHaveLength(28);
    expect(Object.keys(result.operationen)).toEqual(operations);
    expect(result.churchtoolsVersion).toBe('3.137');
    expect(result.operationen['whoami']).toMatchObject({
      pfad: '/api/whoami',
      dokumentiert: true,
      parameter: { only_allow_authenticated: true },
    });
    expect(Object.keys(result.operationen['whoami']?.felder ?? {})).toEqual([
      'data',
      'data.id',
      'data.guid',
      'data.firstName',
      'data.lastName',
      'data.email',
      'meta',
      'meta.simulatingUserId',
    ]);
    expect(result.operationen['permissions']).toMatchObject({
      dokumentiert: true,
      werteAlsMap: true,
    });
    expect(result.operationen['permissions']?.felder).toBeUndefined();
  });

  it('reads the fields of the entries of a list and below them', () => {
    const result = check();
    const searchPersons = result.operationen['searchPersons'];
    expect(searchPersons?.parameter).toEqual({
      query: true,
      page: true,
      limit: true,
    });
    expect(searchPersons?.felder).toMatchObject({
      'data[].id': { deklariert: true, typ: 'integer' },
      'data[].firstName': { deklariert: true, typ: 'string' },
      'data[].lastName': { deklariert: true, typ: 'string' },
    });
    expect(
      Object.keys(result.operationen['appointments']?.felder ?? {}),
    ).toEqual(
      expect.arrayContaining([
        'data[].appointment.base.calendar.id',
        // The address may be null: its name comes from the object form of
        // anyOf in the contract.
        'data[].appointment.base.address.name',
      ]),
    );
    expect(Object.keys(result.operationen['songs']?.felder ?? {})).toContain(
      'data[].arrangements[].key',
    );
  });

  it('follows references, allOf and lists that may be null', () => {
    const result = check(nestedDocument, nestedContract);
    expect(result.operationen['things']?.felder).toEqual({
      data: { deklariert: true, typ: 'array', pflicht: false, nullable: true },
      'data[].outer': {
        deklariert: true,
        typ: 'object',
        pflicht: true,
        nullable: false,
      },
      'data[].outer.title': {
        deklariert: true,
        typ: 'string',
        pflicht: true,
        nullable: false,
      },
      'data[].outer.size': {
        deklariert: true,
        typ: 'string',
        pflicht: false,
        nullable: false,
      },
      'data[].outer.gone': {
        deklariert: false,
        typ: 'unbekannt',
        pflicht: false,
        nullable: false,
      },
      'data[].outer.gone.deeper': {
        deklariert: false,
        typ: 'unbekannt',
        pflicht: false,
        nullable: false,
      },
      'data[].tags': {
        deklariert: true,
        typ: 'array',
        pflicht: true,
        nullable: false,
      },
      'data[].tags[].label': {
        deklariert: true,
        typ: 'string',
        pflicht: true,
        nullable: false,
      },
      'data[].note': {
        deklariert: true,
        typ: 'string',
        pflicht: false,
        nullable: true,
      },
      'data[].days': {
        deklariert: true,
        typ: 'mehrere',
        pflicht: false,
        nullable: false,
      },
      // The list form of the document says nothing about its entries, the
      // map form describes its values.
      'data[].days[].start': {
        deklariert: false,
        typ: 'unbekannt',
        pflicht: false,
        nullable: false,
      },
      'data[].days{}.start': {
        deklariert: true,
        typ: 'string',
        pflicht: false,
        nullable: false,
      },
    });
  });

  it('compares two entries on one operation with the same answer', () => {
    const result = check(nestedDocument, nestedContract);
    expect(Object.keys(result.operationen)).toEqual(['things', 'thingTags']);
    expect(result.operationen['thingTags']).toMatchObject({
      pfad: '/api/things',
      dokumentiert: true,
      felder: { 'data[].tags': { deklariert: true, typ: 'array' } },
    });
  });

  it('lists each deviation once, nothing below a field that is missing', () => {
    const result = check(nestedDocument, nestedContract);
    expect(result.abweichungen).toEqual([
      { operation: 'things', feld: 'to', art: 'parameter nicht deklariert' },
      { operation: 'things', feld: 'data', art: 'nicht Pflicht' },
      { operation: 'things', feld: 'data', art: 'nullable' },
      { operation: 'things', feld: 'data[].outer.size', art: 'anderer Typ' },
      { operation: 'things', feld: 'data[].outer.size', art: 'nicht Pflicht' },
      {
        operation: 'things',
        feld: 'data[].outer.gone',
        art: 'nicht deklariert',
      },
      { operation: 'things', feld: 'data[].note', art: 'nicht Pflicht' },
      {
        operation: 'things',
        feld: 'data[].days[].start',
        art: 'nicht deklariert',
      },
      {
        operation: 'things',
        feld: 'data[].days{}.start',
        art: 'nicht Pflicht',
      },
      { operation: 'thingTags', feld: 'data', art: 'nullable' },
    ]);
  });

  it('marks a deprecated operation as a deviation', () => {
    const document = structuredClone(nestedDocument);
    Object.assign(document.paths['/things'].get, { deprecated: true });
    const result = check(document, nestedContract);
    expect(result.operationen['things']?.veraltet).toBe(true);
    expect(result.abweichungen).toContainEqual({
      operation: 'things',
      art: 'veraltet',
    });
  });

  it('says not documented once per operation when the document lacks it', () => {
    const result = check({ ...nestedDocument, paths: {} }, nestedContract);
    expect(result.operationen['things']).toMatchObject({
      dokumentiert: false,
      parameter: { from: false, to: false },
    });
    expect(result.abweichungen).toEqual([
      { operation: 'things', art: 'nicht dokumentiert' },
      { operation: 'thingTags', art: 'nicht dokumentiert' },
    ]);
  });

  it('refuses a missing state file without reading anything else', () => {
    const output = capture();
    expect(
      run({ ECCLIUM_SPIKE_BASE_URL: origin }, contract, output.io),
    ).not.toBe(0);
    expect(output.stdout()).toBe('');
  });

  it('refuses a contract that is no JSON or holds an unknown method', () => {
    const output = capture();
    expect(run(withState(), '{', output.io)).not.toBe(0);
    expect(run(withState(), '[]', output.io)).not.toBe(0);
    expect(
      run(
        withState(),
        JSON.stringify({ x: { method: 'head', path: '/api/x' } }),
        output.io,
      ),
    ).not.toBe(0);
    expect(output.stdout()).toBe('');
  });

  it('names type classes and null with fixed words', () => {
    expect(typeClass(undefined)).toBe('unbekannt');
    expect(typeClass({ type: 'string' })).toBe('string');
    expect(typeClass({ type: ['string', 'null'] })).toBe('string');
    expect(typeClass({ type: ['string', 'integer'] })).toBe('mehrere');
    expect(typeClass({})).toBe('ohne Typ');
    expect(typeClass({ type: 'file' })).toBe('anderes');
    expect(typeClass({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe(
      'string',
    );
    expect(
      typeClass({ oneOf: [{ type: 'string' }, { type: 'integer' }] }),
    ).toBe('mehrere');
    expect(allowsNull(undefined)).toBe(false);
    expect(allowsNull({ nullable: true })).toBe(true);
    expect(allowsNull({ type: ['string', 'null'] })).toBe(true);
    expect(allowsNull({ type: 'string' })).toBe(false);
    expect(allowsNull({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe(
      true,
    );
  });

  it('follows references in the parts of a schema', () => {
    const named = { type: 'integer' };
    const resolve = (node: unknown) =>
      node === 'ref' ? named : (node as Record<string, unknown>);
    expect(typeClass({ anyOf: ['ref', { type: 'null' }] }, resolve)).toBe(
      'integer',
    );
    expect(allowsNull({ anyOf: ['ref'] }, resolve)).toBe(false);
  });
});
