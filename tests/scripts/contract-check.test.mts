import { readFileSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { allowsNull, run, typeClass } from '../../scripts/contract/check.mts';
import {
  catalogOperations,
  catalogText,
} from '../../scripts/docs/lib/catalog.mts';
import { operationFacts } from '../../scripts/docs/lib/operations.mts';
import { createState, instanceId } from '../../scripts/spike/lib/env.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
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

// The generated part of the catalog of the escape hatch, which the check
// compares with the document as well.
const catalog = readFileSync(
  new URL(
    '../../packages/core/src/churchtools/catalog/generated.ts',
    import.meta.url,
  ),
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
  expect(run(withState(document), contractText, output.io, catalog)).toBe(0);
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
      run({ ECCLIUM_SPIKE_BASE_URL: origin }, contract, output.io, catalog),
    ).not.toBe(0);
    expect(output.stdout()).toBe('');
  });

  it('refuses a contract that is no JSON or holds an unknown method', () => {
    const output = capture();
    expect(run(withState(), '{', output.io, catalog)).not.toBe(0);
    expect(run(withState(), '[]', output.io, catalog)).not.toBe(0);
    expect(
      run(
        withState(),
        JSON.stringify({ x: { method: 'head', path: '/api/x' } }),
        output.io,
        catalog,
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

// A document with one operation whose answer is the given schema, and a
// contract that reads the given fields of `data` from it.
const oneOperation = (
  thing: unknown,
  components: Record<string, unknown> = {},
  parameters: { operation?: unknown[]; path?: unknown[] } = {},
) => ({
  openapi: '3.0.3',
  info: { title: 'Synthetic test document', version: '0.0.0' },
  servers: [{ url: `${origin}/api` }],
  paths: {
    '/things': {
      ...(parameters.path === undefined ? {} : { parameters: parameters.path }),
      get: {
        ...(parameters.operation === undefined
          ? {}
          : { parameters: parameters.operation }),
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: thing } },
              },
            },
          },
        },
      },
    },
  },
  components: { schemas: components },
});
const reading = (data: unknown, query: string[] = []) =>
  JSON.stringify({
    things: {
      method: 'get',
      path: '/api/things',
      query,
      response: { type: 'object', properties: { data } },
    },
  });
const fieldsOf = (result: Result) => result.operationen['things']?.felder;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

describe('the contract check with fields in several parts', () => {
  it('reads a field from every part of allOf that declares it', () => {
    const client = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          required: ['a', 'b'],
        },
      },
    };
    const result = check(
      oneOperation(
        { allOf: [ref('Base'), ref('More')] },
        {
          Base: {
            type: 'object',
            properties: {
              outer: {
                type: 'object',
                required: ['a'],
                properties: { a: { type: 'string' } },
              },
            },
          },
          More: {
            type: 'object',
            properties: {
              outer: {
                type: 'object',
                required: ['b'],
                properties: { b: { type: 'string' } },
              },
            },
          },
        },
      ),
      reading(client),
    );
    expect(fieldsOf(result)).toMatchObject({
      'data.outer.a': { deklariert: true, pflicht: true },
      'data.outer.b': { deklariert: true, pflicht: true },
    });
    expect(result.abweichungen).toEqual([]);
  });

  it('gives the same answer whatever the order of the parts', () => {
    const client = {
      type: 'object',
      properties: { note: { type: 'string' } },
    };
    const plain = { properties: { note: { type: 'string' } } };
    const nullable = { properties: { note: { nullable: true } } };
    const forward = check(
      oneOperation({ allOf: [plain, nullable] }),
      reading(client),
    );
    const backward = check(
      oneOperation({ allOf: [nullable, plain] }),
      reading(client),
    );
    expect(fieldsOf(forward)).toEqual(fieldsOf(backward));
    expect(fieldsOf(forward)?.['data.note']).toMatchObject({
      typ: 'string',
      nullable: true,
    });
    expect(forward.abweichungen).toEqual(backward.abweichungen);
  });

  it('reads the alternatives of oneOf together', () => {
    const client = {
      type: 'object',
      properties: { id: { type: 'integer' }, guid: { type: 'string' } },
      required: ['id', 'guid'],
    };
    const result = check(
      oneOperation({
        oneOf: [
          {
            type: 'object',
            required: ['id', 'guid'],
            properties: { id: { type: 'string' }, guid: { type: 'string' } },
          },
          {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'integer', nullable: true },
              guid: { type: 'string' },
            },
          },
          { type: 'null' },
        ],
      }),
      reading(client),
    );
    // Two types: no other type to report. Null in one alternative counts.
    // Required only where every alternative but null requires it.
    expect(fieldsOf(result)).toMatchObject({
      'data.id': { typ: 'mehrere', pflicht: true, nullable: true },
      'data.guid': { typ: 'string', pflicht: false, nullable: false },
    });
    expect(result.abweichungen).toEqual([
      { operation: 'things', feld: 'data', art: 'nullable' },
      { operation: 'things', feld: 'data.id', art: 'nullable' },
      { operation: 'things', feld: 'data.guid', art: 'nicht Pflicht' },
    ]);
  });

  it('requires nothing that only some alternatives require', () => {
    const client = {
      type: 'object',
      properties: { id: { type: 'integer' }, guid: { type: 'string' } },
      required: ['id', 'guid'],
    };
    const result = check(
      oneOperation({
        type: 'object',
        properties: { id: { type: 'integer' }, guid: { type: 'string' } },
        oneOf: [{ required: ['id'] }, { required: ['guid'] }],
      }),
      reading(client),
    );
    expect(result.abweichungen).toEqual([
      { operation: 'things', feld: 'data.id', art: 'nicht Pflicht' },
      { operation: 'things', feld: 'data.guid', art: 'nicht Pflicht' },
    ]);
  });

  it('reads the entries of every list among the alternatives', () => {
    const client = {
      type: 'array',
      items: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
      },
    };
    const result = check(
      oneOperation({
        oneOf: [
          { type: 'array', items: { properties: { a: { type: 'string' } } } },
          { type: 'array', items: { properties: { b: { type: 'string' } } } },
        ],
      }),
      reading(client),
    );
    expect(fieldsOf(result)).toMatchObject({
      'data[].a': { deklariert: true },
      'data[].b': { deklariert: true },
    });
  });

  it('finds no field of Object.prototype', () => {
    // Parsed, so that __proto__ is an own key, as in contract.json.
    const client: unknown = JSON.parse(
      '{"type":"object","properties":{"constructor":{"type":"string"},"__proto__":{"type":"string"}}}',
    );
    const result = check(
      oneOperation({ type: 'object', properties: {} }),
      reading(client),
    );
    expect(fieldsOf(result)?.['data.constructor']).toMatchObject({
      deklariert: false,
    });
    expect(fieldsOf(result)?.['data.__proto__']).toMatchObject({
      deklariert: false,
    });
  });

  it('takes the parameters the path declares for every operation on it', () => {
    const result = check(
      oneOperation(
        { type: 'string' },
        {},
        {
          path: [{ name: 'page', in: 'query', schema: { type: 'integer' } }],
          operation: [{ name: 'limit', in: 'query', schema: {} }],
        },
      ),
      reading({ type: 'string' }, ['page', 'limit', 'other']),
    );
    expect(result.operationen['things']?.parameter).toEqual({
      page: true,
      limit: true,
      other: false,
    });
  });

  it('stops with a fixed hint on a document that branches too much', () => {
    // Every level refers twice to the next one: 2^20 ways down.
    const components = Object.fromEntries(
      Array.from({ length: 20 }, (_, level) => [
        `Level${String(level)}`,
        {
          allOf: [
            ref(`Level${String(level + 1)}`),
            ref(`Level${String(level + 1)}`),
          ],
        },
      ]),
    );
    const output = capture();
    const code = run(
      withState(oneOperation(ref('Level0'), components)),
      reading({ type: 'object', properties: { x: { type: 'string' } } }),
      output.io,
      catalog,
    );
    expect(code).not.toBe(0);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(hints.dokumentZuVerschachtelt);
  });

  it.each([
    ['no JSON', '{'],
    ['a list', '[]'],
    ['an entry that is no object', JSON.stringify({ x: 1 })],
    [
      'an unknown method',
      JSON.stringify({ x: { method: 'head', path: '/api/x' } }),
    ],
    ['a method without a path', JSON.stringify({ x: { method: 'get' } })],
    ['a path without a method', JSON.stringify({ x: { path: '/api/x' } })],
    [
      'parameters that are no list',
      JSON.stringify({ x: { method: 'get', path: '/api/x', query: 'page' } }),
    ],
  ])('names the contract, not the state file, for %s', (_, text) => {
    const output = capture();
    expect(run(withState(), text, output.io, catalog)).not.toBe(0);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(hints.vertragUngueltig);
  });
});

// A small document of its own for the part katalog: two GET operations,
// one of them with a parameter of the path and one of the query, and a
// POST, which the catalog leaves out.
const answer = {
  '200': {
    description: 'The things.',
    content: { 'application/json': { schema: { type: 'object' } } },
  },
};
const catalogDocument = (): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: { title: 'Synthetic API', version: '0.1.0' },
  paths: {
    '/things': {
      get: {
        operationId: 'get-things',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: answer,
      },
      post: { operationId: 'post-things', responses: answer },
    },
    '/things/{thingId}': {
      get: {
        operationId: 'get-things-thingId',
        parameters: [
          {
            name: 'thingId',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: answer,
      },
    },
  },
});

// The generated part as the refresh writes it from a document.
const catalogOf = (document: unknown): string =>
  catalogText(catalogOperations(operationFacts(document as never)));

interface CatalogResult {
  katalog: {
    abgleich: string;
    operationen?: number;
    imDokument?: number;
    gleich?: number;
    abweichungen?: { operation: string; feld?: string; art: string }[];
  };
}

const checkCatalog = (
  document: unknown,
  catalogText: string,
): CatalogResult => {
  const output = capture();
  expect(run(withState(document), contract, output.io, catalogText)).toBe(0);
  return JSON.parse(output.stdout()) as CatalogResult;
};

describe('the part katalog of the contract check', () => {
  it('finds nothing when the catalog is what the document gives', () => {
    const document = catalogDocument();
    expect(checkCatalog(document, catalogOf(document)).katalog).toEqual({
      abgleich: 'moeglich',
      operationen: 2,
      imDokument: 2,
      gleich: 2,
      abweichungen: [],
    });
  });

  it('reads the generated part of the core in its form', () => {
    // The generated part of the core must at least read back in its form.
    const result = checkCatalog(catalogDocument(), catalog).katalog;
    expect(result.abgleich).toBe('moeglich');
    expect(result.operationen).toBeGreaterThan(300);
  });

  it('names what the document adds, drops or changes', () => {
    const before = catalogOf(catalogDocument());
    const document = catalogDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const things = document.paths['/things']?.['get'];
    const thing = document.paths['/things/{thingId}']?.['get'];
    if (things === undefined || thing === undefined) throw new Error('form');
    // A parameter of another kind, a new one, and the operation deprecated.
    things['parameters'] = [
      { name: 'limit', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { type: 'string' } },
    ];
    things['deprecated'] = true;
    // The other operation gone, two new ones, one with a name of another
    // form than those of the catalog.
    delete document.paths['/things/{thingId}'];
    document.paths['/widgets'] = {
      get: { operationId: 'get-widgets', responses: answer },
    };
    document.paths['/gadgets'] = {
      get: { operationId: 'getGadgets', responses: answer },
    };
    const result = checkCatalog(document, before).katalog;
    expect(result).toMatchObject({
      abgleich: 'moeglich',
      operationen: 2,
      imDokument: 3,
      gleich: 0,
    });
    expect(result.abweichungen).toEqual([
      { operation: 'get-things', art: 'veraltet' },
      { operation: 'get-things', feld: 'limit', art: 'anderer Parameter' },
      { operation: 'get-things', feld: 'sort', art: 'neuer Parameter' },
      { operation: 'get-things-thingId', art: 'nicht im Dokument' },
      { operation: 'get-widgets', art: 'neu im Dokument' },
      { operation: 'unlesbar', art: 'neu im Dokument' },
    ]);
  });

  it('names another path and a parameter the document drops', () => {
    const before = catalogOf(catalogDocument());
    const document = catalogDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const things = document.paths['/things'];
    if (things === undefined) throw new Error('form');
    const get = things['get'];
    if (get === undefined) throw new Error('form');
    get['parameters'] = [];
    delete document.paths['/things'];
    document.paths['/stuff'] = { get };
    expect(checkCatalog(document, before).katalog.abweichungen).toEqual([
      { operation: 'get-things', art: 'anderer Pfad' },
      { operation: 'get-things', feld: 'limit', art: 'Parameter fehlt' },
    ]);
  });

  it('says so when the document has a form the facts cannot hold, and checks the client', () => {
    const document = catalogDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    // The same operationId twice, on which the refresh stops as well.
    document.paths['/others'] = {
      get: { operationId: 'get-things', responses: answer },
    };
    expect(
      checkCatalog(document, catalogOf(catalogDocument())).katalog,
    ).toEqual({ abgleich: 'nicht moeglich' });
  });

  it.each([
    ['an empty text', ''],
    ['no list of operations', 'export const x = 1;\n'],
    [
      'a line that is no JSON',
      'frozenOperations([\n  {"operationId":\n  ]);\n',
    ],
    [
      'an operation without parameters',
      'frozenOperations([\n  {"operationId":"get-x","method":"get","path":"/api/x","deprecated":false,"json":true},\n  ]);\n',
    ],
    [
      'an operation with another method',
      'frozenOperations([\n  {"operationId":"get-x","method":"post","path":"/api/x","deprecated":false,"json":true,"parameters":[]},\n  ]);\n',
    ],
  ])('refuses a catalog of another form: %s', (_, text) => {
    const output = capture();
    expect(run(withState(), contract, output.io, text)).not.toBe(0);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(hints.katalogDateiUngueltig);
  });
});
