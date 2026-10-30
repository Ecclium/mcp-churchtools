// The generated part of the operation catalog of the escape hatch (ADR
// 0067). The core does not read the facts, so this test holds the file in
// the core to exactly what the facts give, and shows with synthetic
// entries how each schema of a parameter becomes a kind.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  catalogOperations,
  catalogText,
  defaultCatalogFile,
  writeCatalog,
} from '../../scripts/docs/lib/catalog.mts';
import { mainCatalog } from '../../scripts/docs/refresh.mts';
import { SpikeError } from '../../scripts/spike/lib/errors.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';

const root = new URL('../../', import.meta.url);
const operationsFile = new URL(
  'packages/docs-index/data/operations.json',
  root,
);

const realEntries = (): readonly unknown[] =>
  (
    JSON.parse(readFileSync(operationsFile, 'utf8')) as {
      entries: readonly unknown[];
    }
  ).entries;

const ok = { status: '200', content: [{ mediaType: 'application/json' }] };

const entry = (
  parameters: readonly unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  operationId: 'get-things',
  method: 'get',
  path: '/things',
  tags: [],
  deprecated: false,
  parameters,
  responses: [ok],
  ...extra,
});

const query = (name: string, schema: unknown, required = false) => ({
  name,
  in: 'query',
  required,
  schema,
});

// The kind of each parameter, without name, place and need.
const kindsOf = (parameters: readonly unknown[]) =>
  catalogOperations([entry(parameters)])[0]?.parameters.map((parameter) => {
    const kind: Record<string, unknown> = { kind: parameter.kind };
    if (parameter.list === true) kind['list'] = true;
    if (parameter.values !== undefined) kind['values'] = parameter.values;
    return kind;
  });

describe('the generated part in the core', () => {
  it('is exactly what pnpm docs:refresh makes from operations.json', () => {
    expect(readFileSync(defaultCatalogFile, 'utf8')).toBe(
      catalogText(catalogOperations(realEntries())),
    );
  });

  it('holds every GET of the facts and nothing else', () => {
    const entries = realEntries() as readonly { method: string }[];
    const gets = entries.filter((item) => item.method === 'get').length;
    expect(catalogOperations(entries)).toHaveLength(gets);
    expect(gets).toBeGreaterThan(300);
  });
});

describe('catalogOperations', () => {
  it('takes only GET operations and puts /api in front of the path', () => {
    expect(
      catalogOperations([
        entry([], { method: 'post', operationId: 'post-things' }),
        entry([], { deprecated: true }),
      ]),
    ).toEqual([
      {
        operationId: 'get-things',
        method: 'get',
        path: '/api/things',
        deprecated: true,
        json: true,
        parameters: [],
      },
    ]);
  });

  it.each([
    ['integer', { type: ['integer'] }, { kind: 'integer' }],
    ['integer or null', { type: ['integer', 'null'] }, { kind: 'integer' }],
    [
      'integer with values',
      { type: ['integer'], enum: [1, 2] },
      { kind: 'integer' },
    ],
    ['number', { type: ['number'] }, { kind: 'number' }],
    ['boolean', { type: ['boolean'] }, { kind: 'boolean' }],
    ['text', { type: ['string'] }, { kind: 'string' }],
    ['text of a URI', { type: ['string'], format: 'uri' }, { kind: 'string' }],
    ['day', { type: ['string'], format: 'date' }, { kind: 'date' }],
    [
      'day or null',
      { type: ['null', 'string'], format: 'date' },
      { kind: 'date' },
    ],
    [
      'moment',
      { type: ['string'], format: 'date-time' },
      { kind: 'date-time' },
    ],
    [
      'fixed values',
      { type: ['string'], enum: ['asc', 'desc', null] },
      { kind: 'enum', values: ['asc', 'desc'] },
    ],
    [
      'fixed values that are no text',
      { type: ['string'], enum: [null] },
      { kind: 'unsupported' },
    ],
    [
      'day or moment with anyOf',
      {
        anyOf: [
          { type: ['string'], format: 'date' },
          { type: ['string'], format: 'date-time' },
        ],
      },
      { kind: 'date-or-date-time' },
    ],
    [
      'day or moment with oneOf and a name',
      {
        ref: 'AppointmentStartDate',
        oneOf: [
          { type: ['string'], format: 'date-time' },
          { type: ['string'], format: 'date' },
        ],
      },
      { kind: 'date-or-date-time' },
    ],
    [
      'a choice of days only',
      { oneOf: [{ type: ['string'], format: 'date' }] },
      { kind: 'date' },
    ],
    [
      'a choice of moments only',
      { anyOf: [{ type: ['string'], format: 'date-time' }] },
      { kind: 'date-time' },
    ],
    [
      'a choice of a number and a list',
      {
        oneOf: [
          { type: ['integer'] },
          { type: ['array'], items: { type: ['integer'] } },
        ],
      },
      { kind: 'unsupported' },
    ],
    ['an empty choice', { anyOf: [] }, { kind: 'unsupported' }],
    [
      'a choice of a text without format',
      { anyOf: [{ type: ['string'] }, 'x'] },
      { kind: 'unsupported' },
    ],
    ['no type', {}, { kind: 'unsupported' }],
    ['no schema', undefined, { kind: 'unsupported' }],
    ['two types', { type: ['integer', 'string'] }, { kind: 'unsupported' }],
    ['an object', { type: ['object'] }, { kind: 'unsupported' }],
  ])('makes %s a kind', (_name, schema, kind) => {
    expect(kindsOf([query('value', schema)])).toEqual([kind]);
  });

  it('makes a list of a kind under a name with [] and refuses one without', () => {
    const integers = { type: ['array'], items: { type: ['integer'] } };
    const values = {
      type: ['array'],
      items: { type: ['string'], enum: ['a'] },
    };
    expect(
      kindsOf([
        query('ids[]', integers),
        query('kinds[]', values),
        query('account_ids', integers),
        query('nested[]', { type: ['array'], items: integers }),
        query('things[]', { type: ['array'] }),
      ]),
    ).toEqual([
      { kind: 'integer', list: true },
      { kind: 'enum', list: true, values: ['a'] },
      { kind: 'unsupported' },
      { kind: 'unsupported' },
      { kind: 'unsupported' },
    ]);
  });

  it('makes a parameter the transport never sends unsupported', () => {
    const text = { type: ['string'] };
    expect(
      kindsOf([
        query('email-exact', text),
        query('login_token', text),
        query('With_Session', text),
        query('[]', text),
        query('ok_name[]', text),
        { name: 'Accept', in: 'header', required: false, schema: text },
        { name: 'session', in: 'cookie', required: false, schema: text },
        {
          name: 'thingId',
          in: 'path',
          required: true,
          schema: { type: ['string'] },
        },
      ]),
    ).toEqual([
      { kind: 'unsupported' },
      { kind: 'unsupported' },
      { kind: 'unsupported' },
      { kind: 'unsupported' },
      { kind: 'string' },
      { kind: 'unsupported' },
      { kind: 'unsupported' },
      { kind: 'string' },
    ]);
  });

  it.each([
    [
      'only JSON',
      [ok, { status: '404', content: [{ mediaType: 'text/html' }] }],
      true,
    ],
    [
      'JSON twice',
      [ok, { status: '201', content: [{ mediaType: 'application/json' }] }],
      true,
    ],
    ['no body', [{ status: '204', content: [] }], false],
    ['CSV', [{ status: '200', content: [{ mediaType: 'text/csv' }] }], false],
    [
      'JSON and a table',
      [
        {
          status: '200',
          content: [
            { mediaType: 'application/json' },
            { mediaType: 'text/csv' },
          ],
        },
      ],
      false,
    ],
  ])('marks an answer with %s', (_name, responses, json) => {
    expect(catalogOperations([entry([], { responses })])[0]?.json).toBe(json);
  });

  it.each([
    ['an entry that is no object', ['x'], 'entries'],
    ['a method that is no text', [entry([], { method: 1 })], 'method'],
    ['parameters that are no list', [entry([], { parameters: {} })], 'entries'],
    [
      'deprecated that is no boolean',
      [entry([], { deprecated: 'no' })],
      'entries',
    ],
    ['an ID that is no text', [entry([], { operationId: 1 })], 'operationId'],
    ['a path that is no text', [entry([], { path: null })], 'path'],
    ['a parameter that is no object', [entry(['x'])], 'parameters'],
    [
      'a parameter without required',
      [entry([{ name: 'a', in: 'query' }])],
      'parameters',
    ],
    [
      'a parameter without name',
      [entry([{ in: 'query', required: true }])],
      'parameters.name',
    ],
    [
      'a parameter without place',
      [entry([{ name: 'a', required: true }])],
      'parameters.in',
    ],
    ['answers that are no list', [entry([], { responses: {} })], 'responses'],
    [
      'an answer without content',
      [entry([], { responses: [{ status: '200' }] })],
      'responses',
    ],
    [
      'an answer without status',
      [entry([], { responses: [{ content: [] }] })],
      'responses.status',
    ],
    [
      'content without a media type',
      [entry([], { responses: [{ status: '200', content: ['x'] }] })],
      'responses.content',
    ],
  ])('stops at %s and names the place', (_name, entries, where) => {
    let error: unknown;
    try {
      catalogOperations(entries);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SpikeError);
    expect(error).toMatchObject({
      code: 'DATEI',
      hint: 'katalogUngueltig',
      where,
    });
  });
});

describe('catalogText and writing', () => {
  it('writes one operation per line in a module of the core', () => {
    const text = catalogText(catalogOperations([entry([])]));
    expect(text).toContain(
      "import { frozenOperations, type GeneratedOperation } from './types.js';",
    );
    expect(text).toContain(
      '    {"operationId":"get-things","method":"get","path":"/api/things","deprecated":false,"json":true,"parameters":[]},\n',
    );
    expect(text.endsWith('  ]);\n')).toBe(true);
  });

  it('pnpm docs:refresh --nur-katalog writes the file from operations.json', () => {
    const folder = mkdtempSync(join(tmpdir(), 'docs-catalog-'));
    const dataDir = pathToFileURL(`${folder}/`);
    writeFileSync(
      new URL('operations.json', dataDir),
      JSON.stringify({ entries: [entry([])] }),
    );
    const file = new URL('generated.ts', dataDir);
    const out: string[] = [];
    const io = {
      stdout: (text: string) => out.push(text),
      stderr: () => undefined,
    };
    expect(mainCatalog(io, dataDir, file)).toBe(exitCodes.ok);
    expect(JSON.parse(out.join(''))).toEqual({
      refresh: 'katalog',
      operationen: 1,
    });
    expect(readFileSync(file, 'utf8')).toBe(
      catalogText(catalogOperations([entry([])])),
    );
    expect(existsSync(new URL('generated.ts.refresh', dataDir))).toBe(false);
  });

  it('writes nothing for facts it cannot take and keeps the old file', () => {
    const folder = mkdtempSync(join(tmpdir(), 'docs-catalog-'));
    const dataDir = pathToFileURL(`${folder}/`);
    writeFileSync(
      new URL('operations.json', dataDir),
      JSON.stringify({ entries: [entry([], { path: 7 })] }),
    );
    const file = new URL('generated.ts', dataDir);
    writeFileSync(file, 'old');
    const err: string[] = [];
    const io = {
      stdout: () => undefined,
      stderr: (text: string) => err.push(text),
    };
    expect(mainCatalog(io, dataDir, file)).not.toBe(exitCodes.ok);
    expect(err.join('')).toContain('Stelle: path');
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('leaves the old file when the temporary file cannot be written', () => {
    const folder = mkdtempSync(join(tmpdir(), 'docs-catalog-'));
    const file = pathToFileURL(join(folder, 'generated.ts'));
    writeFileSync(file, 'old');
    writeFileSync(new URL(`${file.href}.refresh`), 'in the way');
    expect(() => {
      writeCatalog('new', file);
    }).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('old');
  });
});
