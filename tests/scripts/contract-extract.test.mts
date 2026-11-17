// The contract check in CI (ADR 0076): the extract of the OpenAPI document
// in the repository, its writer and reader, and the comparison with the
// list of the known deviations.
import { readFileSync } from 'node:fs';

import { looksLikeOpenApiDocument } from '@ecclium/mcp-churchtools-docs-index';
import { describe, expect, it } from 'vitest';

import {
  compareContract,
  contractOperations,
  mainExtractCheck,
  mismatchCode,
  readAccepted,
  runExtract,
} from '../../scripts/contract/check.mts';
import {
  buildExtract,
  documentOf,
  type Extract,
  extractText,
  maxExtractBytes,
  maxSchemaDepth,
  readExtract,
} from '../../scripts/contract/extract.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import {
  normalizeTemplate,
  type OpenApiDocument,
} from '../../scripts/spike/lib/spec.mts';
import { capture, origin, specification } from '../spike/support.mts';

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const contract = read('../../packages/core/src/churchtools/contract.json');
const extractFile = read('../../scripts/contract/openapi-extract.json');
const acceptedFile = read('../../scripts/contract/accepted-deviations.json');

interface Output {
  abgleich: string;
  churchtoolsVersion: string;
  operationen: number;
  abweichungen: number;
  bekannt: number;
  neu: { operation: string; feld?: string; art: string }[];
  nichtMehr: { operation: string; feld?: string; art: string }[];
}

const check = (
  contractText = contract,
  extractText_ = extractFile,
  acceptedText = acceptedFile,
) => {
  const output = capture();
  const code = runExtract(contractText, extractText_, acceptedText, output.io);
  return { code, output };
};

const parsed = (output: ReturnType<typeof capture>): Output =>
  JSON.parse(output.stdout()) as Output;

// The contract with one more field the client reads in the answer of
// whoami, which no document declares.
const contractWithNewField = (): string => {
  const value = JSON.parse(contract) as Record<
    string,
    {
      response: {
        properties: {
          data: {
            properties: Record<string, unknown>;
            required: string[];
          };
        };
      };
    }
  >;
  const data = value['whoami']?.response.properties.data;
  if (data === undefined) throw new Error('whoami without data');
  data.properties['nichtImDokument'] = { type: 'string' };
  data.required.push('nichtImDokument');
  return JSON.stringify(value);
};

const extractValue = (): Record<string, unknown> =>
  JSON.parse(extractFile) as Record<string, unknown>;

describe('the extract in the repository', () => {
  it('gives exactly the known deviations, with 0', () => {
    const { code, output } = check();
    expect(code, output.stderr()).toBe(exitCodes.ok);
    const result = parsed(output);
    expect(result).toMatchObject({
      abgleich: 'auszug',
      operationen: contractOperations(contract).length,
      neu: [],
      nichtMehr: [],
    });
    expect(result.bekannt).toBe(readAccepted(acceptedFile).length);
    expect(result.abweichungen).toBe(result.bekannt);
    expect(output.stderr()).toBe('');
  });

  it('stands in the form the refresh writes, byte by byte', () => {
    expect(extractText(readExtract(extractFile))).toBe(extractFile);
    expect(Buffer.byteLength(extractFile, 'utf8')).toBeLessThan(
      maxExtractBytes,
    );
  });

  // The document may drop an operation of the client; the comparison then
  // names it as not documented, which the list must hold.
  it('holds only operations of the client, each once', () => {
    const extract = readExtract(extractFile);
    const ofClient = new Set(
      contractOperations(contract).map(
        (operation) =>
          `${operation.method} ${normalizeTemplate(operation.path)}`,
      ),
    );
    const held = extract.operations.map(
      (operation) => `${operation.method} ${normalizeTemplate(operation.path)}`,
    );
    expect(new Set(held).size).toBe(held.length);
    for (const operation of held) expect(ofClient).toContain(operation);
  });

  it('stands in canonical order, which a refresh keeps', () => {
    const extract = readExtract(extractFile);
    const sorted = (list: readonly string[]) =>
      [...list].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    const order = extract.operations.map(
      (operation) =>
        `${operation.path} ${String(methods.indexOf(operation.method))}`,
    );
    expect(order).toEqual(sorted(order));
    expect(Object.keys(extract.schemas)).toEqual(
      sorted(Object.keys(extract.schemas)),
    );
    for (const operation of extract.operations) {
      const places = operation.parameters.map(
        (parameter) => `${parameter.in} ${parameter.name}`,
      );
      expect(places).toEqual(sorted(places));
    }
    // Every list of properties in its order.
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const value = node as Record<string, unknown>;
      const properties = value['properties'];
      if (typeof properties === 'object' && properties !== null) {
        const names = Object.keys(properties);
        expect(names).toEqual(sorted(names));
      }
      Object.values(value).forEach(visit);
    };
    visit(extract);
  });

  it('is no raw source and names no host, only its source and licence', () => {
    expect(looksLikeOpenApiDocument(extractFile)).toBe(false);
    expect(extractFile).not.toContain('://');
    expect(extractFile).not.toContain('church.tools');
    const extract = readExtract(extractFile);
    expect(extract.notice).toContain('CC BY 4.0');
    expect(extract.notice).toContain('LICENSES/CC-BY-4.0.txt');
  });
});

describe('the comparison with the list of the known deviations', () => {
  it('ends with 1 and names a deviation the list does not hold', () => {
    const { code, output } = check(contractWithNewField());
    expect(code).toBe(mismatchCode);
    expect(parsed(output).neu).toEqual([
      {
        operation: 'whoami',
        feld: 'data.nichtImDokument',
        art: 'nicht deklariert',
      },
    ]);
    expect(output.stderr()).toContain('accepted-deviations.json');
  });

  it('ends with 1 and names a known deviation that no longer occurs', () => {
    const list = JSON.parse(acceptedFile) as { entries: unknown[] };
    list.entries.push({
      operation: 'whoami',
      feld: 'data.guid',
      art: 'nicht Pflicht',
      grund: 'Ein Eintrag, der nicht mehr zutrifft.',
    });
    const { code, output } = check(contract, extractFile, JSON.stringify(list));
    expect(code).toBe(mismatchCode);
    expect(parsed(output).nichtMehr).toEqual([
      { operation: 'whoami', feld: 'data.guid', art: 'nicht Pflicht' },
    ]);
  });

  it('ends with 1 when the list leaves out a deviation that occurs', () => {
    const list = JSON.parse(acceptedFile) as { entries: unknown[] };
    list.entries.shift();
    const { code, output } = check(contract, extractFile, JSON.stringify(list));
    expect(code).toBe(mismatchCode);
    expect(parsed(output).neu).toHaveLength(1);
  });

  const entry = {
    operation: 'whoami',
    feld: 'data.firstName',
    art: 'nicht Pflicht',
    grund: 'Belegt.',
  };
  it.each([
    ['no JSON', '{'],
    ['another format', JSON.stringify({ format: 'x', entries: [] })],
    [
      'a further key',
      JSON.stringify({
        format: 'ecclium.contract.accepted.v1',
        entries: [],
        more: 1,
      }),
    ],
    ['an entry without a reason', [{ ...entry, grund: ' ' }]],
    ['an entry of an unknown kind', [{ ...entry, art: 'anders' }]],
    ['an entry with a further key', [{ ...entry, quelle: 'x' }]],
    ['an entry twice', [entry, entry]],
  ])('refuses a list with %s, with 2', (_, list) => {
    const text =
      typeof list === 'string'
        ? list
        : JSON.stringify({
            format: 'ecclium.contract.accepted.v1',
            entries: list,
          });
    const { code, output } = check(contract, extractFile, text);
    expect(code).toBe(exitCodes.configuration);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(hints.listeUngueltig);
  });
});

describe('the files of the check in CI', () => {
  const missing = new URL('file:///nicht-vorhanden/datei.json');
  it.each([
    ['the extract', missing, undefined, hints.auszugUngueltig],
    ['the list', undefined, missing, hints.listeUngueltig],
  ])('ends with 2 when %s is missing', (_, extract, accepted, hint) => {
    const output = capture();
    const code = mainExtractCheck(contract, output.io, extract, accepted);
    expect(code).toBe(exitCodes.configuration);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(hint);
  });
});

describe('the reader of the extract', () => {
  const withSchema = (schema: unknown): string => {
    const value = extractValue();
    const operations = value['operations'] as Record<string, unknown>[];
    const first = operations[0] as {
      responses: Record<string, unknown>;
    };
    first.responses['200'] = schema;
    return JSON.stringify(value);
  };

  it.each([
    ['a text', withSchema({ type: 'string', description: 'Ein Text' })],
    ['an example', withSchema({ type: 'string', example: 'Person A' })],
    ['an extension', withSchema({ type: 'string', 'x-internal': true })],
    [
      'a reference outside the extract',
      withSchema({ $ref: '#/components/schemas/Unbekannt' }),
    ],
    [
      'servers',
      JSON.stringify({ ...extractValue(), servers: [{ url: origin }] }),
    ],
    ['openapi', JSON.stringify({ openapi: '3.0.3', ...extractValue() })],
    ['another format', JSON.stringify({ ...extractValue(), format: 'x' })],
    [
      'a source without its hash',
      JSON.stringify({
        ...extractValue(),
        source: { ...(extractValue()['source'] as object), sha256: 'x' },
      }),
    ],
    [
      'a type of another form',
      withSchema({ type: 'max.mustermann@example.org' }),
    ],
    [
      'a parameter in another place',
      (() => {
        const value = extractValue();
        const operations = value['operations'] as {
          parameters: { in: string }[];
        }[];
        const first = operations.find(
          (operation) => operation.parameters.length > 0,
        );
        if (first?.parameters[0] !== undefined) {
          first.parameters[0].in = 'Gemeinde Musterstadt';
        }
        return JSON.stringify(value);
      })(),
    ],
    [
      'a version of ChurchTools with three numbers',
      JSON.stringify({
        ...extractValue(),
        source: {
          ...(extractValue()['source'] as object),
          churchToolsVersion: '3.138.2',
        },
      }),
    ],
    [
      'more than the largest size',
      `${extractFile}${' '.repeat(maxExtractBytes)}`,
    ],
  ])('refuses an extract with %s, with 2', (_, text) => {
    const { code, output } = check(contract, text);
    expect(code).toBe(exitCodes.configuration);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(hints.auszugUngueltig);
  });
});

// A document of an instance writes every schema out in place; the extract
// names those equal to a named schema, as the facts of the docs index do.
const inlinedDocument = (): OpenApiDocument => {
  const base = {
    type: 'object',
    description: 'Basis',
    required: ['id'],
    properties: {
      id: { type: 'integer', example: 1 },
      email: { type: 'string', nullable: true, format: 'email' },
    },
  };
  return {
    openapi: '3.0.3',
    info: { title: 'Synthetic test document', version: '0.0.0' },
    servers: [{ url: `${origin}/api` }],
    paths: {
      '/whoami': {
        get: {
          parameters: [
            {
              name: 'only_allow_authenticated',
              in: 'query',
              description: 'Text',
              schema: { type: 'boolean' },
            },
          ],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: structuredClone(base) },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Base: base, Other: { type: 'string' } } },
  };
};

const needs = [
  { method: 'get' as const, path: '/api/whoami', status: 200, request: false },
];
const source = {
  retrievedAt: '2026-11-17T00:00:00Z',
  sha256: '0'.repeat(64),
  documentVersion: '0.0.0',
  churchToolsVersion: '3.138',
};

describe('buildExtract', () => {
  it('names a schema equal to a named one, and keeps only what the check reads', () => {
    const extract = buildExtract(inlinedDocument(), needs, source, 'Hinweis');
    expect(extract.operations).toEqual([
      {
        method: 'get',
        path: '/api/whoami',
        deprecated: false,
        parameters: [
          { name: 'only_allow_authenticated', in: 'query', required: false },
        ],
        responses: {
          '200': {
            type: 'object',
            properties: { data: { $ref: '#/components/schemas/Base' } },
          },
        },
      },
    ]);
    // Only the named schema it reaches, without its text and example.
    expect(extract.schemas).toEqual({
      Base: {
        type: 'object',
        required: ['id'],
        properties: {
          email: { type: 'string', nullable: true },
          id: { type: 'integer' },
        },
      },
    });
    expect(readExtract(extractText(extract))).toEqual(extract);
  });

  it('gives the check over the extract what it gives over the whole document', () => {
    const operations = contractOperations(contract);
    for (const document of [inlinedDocument(), specification]) {
      const extract = buildExtract(
        document,
        operations.map((operation) => ({
          method: operation.method,
          path: operation.path,
          status: operation.status,
          request: operation.request !== undefined,
        })),
        source,
        'Hinweis',
      );
      const whole = compareContract(document, operations);
      const part = compareContract(documentOf(extract), operations);
      expect(part.report).toEqual(whole.report);
      expect(part.deviations).toEqual(whole.deviations);
    }
  });

  it('refuses a reference outside the named schemas', () => {
    const document = inlinedDocument();
    const paths = document.paths as Record<string, unknown>;
    paths['/whoami'] = {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/responses/Thing' },
              },
            },
          },
        },
      },
    };
    expect(() => buildExtract(document, needs, source, 'Hinweis')).toThrow(
      expect.objectContaining({ hint: 'quelleUngueltig' }),
    );
  });

  it('refuses a reference to a name of another form', () => {
    const document = inlinedDocument();
    const paths = document.paths as Record<string, unknown>;
    paths['/whoami'] = {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Per%20son' },
              },
            },
          },
        },
      },
    };
    expect(() => buildExtract(document, needs, source, 'Hinweis')).toThrow(
      expect.objectContaining({ hint: 'quelleUngueltig' }),
    );
  });

  it('refuses a schema deeper than it reads', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let level = 0; level <= maxSchemaDepth + 1; level += 1) {
      schema = { type: 'object', properties: { inner: schema } };
    }
    const document = inlinedDocument();
    const paths = document.paths as Record<
      string,
      { get: { responses: Record<string, unknown> } }
    >;
    const whoami = paths['/whoami'];
    if (whoami === undefined) throw new Error('no whoami');
    whoami.get.responses['200'] = {
      content: { 'application/json': { schema } },
    };
    expect(() => buildExtract(document, needs, source, 'Hinweis')).toThrow(
      expect.objectContaining({ hint: 'quelleUngueltig' }),
    );
  });

  it('leaves out an operation the document does not document', () => {
    const extract: Extract = buildExtract(
      inlinedDocument(),
      [
        ...needs,
        { method: 'get', path: '/api/persons', status: 200, request: false },
      ],
      source,
      'Hinweis',
    );
    expect(extract.operations.map((operation) => operation.path)).toEqual([
      '/api/whoami',
    ]);
  });
});
