// Tests of the facts pnpm docs:refresh takes from its three sources: the
// operations of an OpenAPI document, the rights of an answer of
// GET /api/permissions/global and the help pages of the Academy
// (ADR 0066). The sources are synthetic and built at run time: no
// document, page or right here is taken from ChurchTools. Each result
// must pass the checks of the package.
import { createHash } from 'node:crypto';

import {
  parseFactFiles,
  shapeDepth,
  type Shape,
} from '@ecclium/mcp-churchtools-docs-index';
import { describe, expect, it } from 'vitest';

import {
  academyPages,
  readAcademy,
  type AcademyRead,
  type Term,
} from '../../scripts/docs/lib/academy.mts';
import {
  factFileTexts,
  openApiNotice,
  type RefreshedFacts,
} from '../../scripts/docs/lib/files.mts';
import {
  factDepth,
  operationFacts,
} from '../../scripts/docs/lib/operations.mts';
import { rightFacts } from '../../scripts/docs/lib/rights.mts';
import type {
  AcademyClient,
  AcademyResponse,
} from '../../scripts/spike/lib/academy.mts';
import { SpikeError } from '../../scripts/spike/lib/errors.mts';
import type { OpenApiDocument } from '../../scripts/spike/lib/spec.mts';

const hosted = (label: string): string => [label, 'church', 'tools'].join('.');

// An object nested `levels` deep below its first property.
function deep(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let level = 0; level < levels; level += 1) {
    schema = {
      type: 'object',
      properties: { [`level${String(level)}`]: schema },
    };
  }
  return schema;
}

const member = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
};

function syntheticDocument(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Synthetic API',
      version: '0.1.0',
      license: { name: 'CC BY 4.0', url: 'https://example.org/licence' },
      contact: {
        name: 'Synthetic Forum',
        url: 'https://example.com/forum',
        email: 'someone@example.com',
      },
    },
    servers: [{ url: `https://${hosted('demo-tenant')}/api` }],
    paths: {
      '/api/synthetic/things': {
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'From the path.',
            schema: { type: 'integer', default: 10 },
          },
        ],
        get: {
          operationId: 'listSyntheticThings',
          tags: ['Things', 'Synthetic', 'Things'],
          summary: '  List   synthetic  things ',
          description:
            'Requires view things.<br>Use <id> and see https://example.com/x or [docs](https://example.com/d).',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'From the operation.',
              schema: { type: 'integer' },
            },
            {
              name: 'query',
              in: 'query',
              example: 'Person A',
              schema: { type: ['string', 'null'], examples: ['x'] },
            },
          ],
          responses: {
            '401': { description: 'No login.' },
            '200': {
              description: 'The things.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: member },
                      meta: deep(5),
                      kind: { type: 'string', const: 'thing' },
                      ratio: { type: 'number', enum: [0.5, 1] },
                    },
                  },
                },
                '*/*': {},
              },
            },
          },
          externalDocs: { url: 'https://example.com/docs' },
          security: [{ login: [] }],
          'x-last-checked': '2026-10-29',
        },
        post: {
          operationId: 'postSyntheticInternal',
          'x-internal': true,
          responses: {},
        },
      },
      '/api/synthetic/things/{thingId}': {
        get: {
          operationId: 'getSyntheticThing',
          deprecated: true,
          parameters: [
            {
              name: 'thingId',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': {
              description: 'One thing.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SyntheticMember' },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: { SyntheticMember: member } },
  };
}

function withOperation(
  extra: Record<string, unknown>,
  path = '/api/synthetic/extra',
): OpenApiDocument {
  const document = syntheticDocument();
  return {
    ...document,
    paths: {
      ...(document['paths'] as Record<string, unknown>),
      [path]: { get: extra },
    },
  };
}

function whereOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof SpikeError) {
      return error.where;
    }
    throw error;
  }
  return undefined;
}

// Every schema of an operation, to look at them all at once.
function shapesOf(entry: Readonly<Record<string, unknown>>): Shape[] {
  const found: Shape[] = [];
  const parameters = entry['parameters'] as { schema?: Shape }[];
  for (const parameter of parameters) {
    if (parameter.schema !== undefined) found.push(parameter.schema);
  }
  const responses = entry['responses'] as { content: { schema?: Shape }[] }[];
  for (const response of responses) {
    for (const body of response.content) {
      if (body.schema !== undefined) found.push(body.schema);
    }
  }
  return found;
}

function emptyFacts(): RefreshedFacts {
  const origin = {
    retrievedAt: '2026-10-29T08:00:00Z',
    sha256: 'a'.repeat(64),
    churchToolsVersion: '3.138',
  };
  return {
    operations: [],
    rights: [],
    academy: [],
    operationsNotice: 'Synthetische Fakten.',
    openapi: { ...origin, documentVersion: '0.1.0' },
    permissions: origin,
    academyOrigin: { retrievedAt: origin.retrievedAt, pages: [] },
  };
}

describe('operationFacts', () => {
  const entries = operationFacts(syntheticDocument());
  const list = entries.find(
    (entry) => entry['operationId'] === 'listSyntheticThings',
  );

  it('takes every operation but the internal ones, sorted by their ID', () => {
    expect(entries.map((entry) => entry['operationId'])).toEqual([
      'getSyntheticThing',
      'listSyntheticThings',
    ]);
    expect(entries[0]?.['deprecated']).toBe(true);
  });

  it('writes the fields in the order of the format', () => {
    expect(Object.keys(list ?? {})).toEqual([
      'operationId',
      'method',
      'path',
      'tags',
      'summary',
      'description',
      'deprecated',
      'parameters',
      'responses',
    ]);
  });

  it('cleans the texts and takes neither servers, examples, defaults nor extensions', () => {
    expect(list?.['tags']).toEqual(['Synthetic', 'Things']);
    expect(list?.['summary']).toBe('List synthetic things');
    expect(list?.['description']).toBe(
      'Requires view things.\nUse &lt;id> and see (link removed) or docs.',
    );
    const text = JSON.stringify(entries);
    for (const word of [
      'servers',
      'example',
      'default',
      'externalDocs',
      'security',
      'x-last-checked',
      'demo-tenant',
      'Person A',
      'Internal',
    ]) {
      expect(text).not.toContain(word);
    }
  });

  it('lets a parameter of the operation replace the one of the path and sorts them', () => {
    expect(list?.['parameters']).toEqual([
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'From the operation.',
        schema: { type: ['integer'] },
      },
      {
        name: 'query',
        in: 'query',
        required: false,
        schema: { type: ['null', 'string'] },
      },
    ]);
  });

  it(`cuts schemas to ${String(factDepth)} steps and names schemas of components`, () => {
    for (const shape of entries.flatMap(shapesOf)) {
      expect(shapeDepth(shape)).toBeLessThanOrEqual(factDepth);
    }
    const one = entries[0]?.['responses'] as {
      content: { schema?: Shape }[];
    }[];
    expect(one[0]?.content[0]?.schema).toMatchObject({
      type: ['object'],
      ref: 'SyntheticMember',
    });
    const answer = (
      list?.['responses'] as {
        content: { mediaType: string; schema?: Shape }[];
      }[]
    )[0];
    expect(answer?.content.map((body) => body.mediaType)).toEqual([
      '*/*',
      'application/json',
    ]);
    const properties = answer?.content[1]?.schema?.properties ?? [];
    expect(properties.map((property) => property.name)).toEqual([
      'data',
      'kind',
      'meta',
      'ratio',
    ]);
    expect(properties[0]?.schema.items).toMatchObject({
      ref: 'SyntheticMember',
      properties: [
        { name: 'id', required: true },
        { name: 'name', required: false },
      ],
    });
    expect(properties[1]?.schema.enum).toEqual(['thing']);
    expect(properties[3]?.schema.enum).toBeUndefined();
  });

  it('passes the checks of the docs index', () => {
    const facts = parseFactFiles(
      factFileTexts({
        ...emptyFacts(),
        operations: entries,
        operationsNotice: openApiNotice(syntheticDocument(), '3.138'),
      }),
    );
    expect(facts.operations.entries).toHaveLength(2);
  });

  it.each([
    [
      'an unknown kind of schema',
      withOperation({
        operationId: 'getExtra',
        responses: {
          '200': {
            content: { 'application/json': { schema: { type: 'file' } } },
          },
        },
      }),
      'operations[0].responses[0].content[0].schema.type',
    ],
    [
      'an ID used twice',
      withOperation({ operationId: 'getSyntheticThing', responses: {} }),
      'operations[1].operationId',
    ],
    [
      'an ID of another form',
      withOperation({ operationId: 'get extra', responses: {} }),
      'operations[0].operationId',
    ],
    [
      'a property whose name would change',
      withOperation({
        operationId: 'getExtra',
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { '<b>': { type: 'string' } },
                },
              },
            },
          },
        },
      }),
      'operations[0].responses[0].content[0].schema.properties[0].name',
    ],
    [
      'a parameter in an unknown place',
      withOperation({
        operationId: 'getExtra',
        parameters: [{ name: 'x', in: 'body' }],
        responses: {},
      }),
      'operations[0].parameters[1.0].in',
    ],
  ])('stops at %s and names only the place', (_name, document, where) => {
    expect(whereOf(() => operationFacts(document))).toBe(where);
  });
});

describe('openApiNotice', () => {
  it('names title, versions, the contact by name and the licence, without hosts', () => {
    const notice = openApiNotice(syntheticDocument(), '3.138');
    expect(notice).toContain('«Synthetic API»');
    expect(notice).toContain('Version 0.1.0 des Dokuments');
    expect(notice).toContain('ChurchTools 3.138');
    expect(notice).toContain('Kontakt laut Dokument: Synthetic Forum.');
    expect(notice).toContain('LICENSES/CC-BY-4.0.txt');
    expect(notice).not.toContain('example.com');
  });

  it('refuses a document under another licence, which needs a new decision', () => {
    const document = syntheticDocument();
    const other = {
      ...document,
      info: { ...(document['info'] as object), license: { name: 'MIT' } },
    };
    expect(whereOf(() => openApiNotice(other, '3.138'))).toBe(
      'openapi.info.license',
    );
  });
});

describe('rightFacts', () => {
  const answer = {
    data: {
      churchwiki: { view: true, 'view category': [17, 23] },
      churchcore: { 'administer persons': false, 'Chosen Name 7': true },
      churchdb: { 'view group': [], view: false },
    },
  };

  it('takes module, name and kind, sorted, never a value', () => {
    const { entries, skipped } = rightFacts(answer);
    expect(entries).toEqual([
      {
        module: 'churchcore',
        name: 'administer persons',
        kind: 'boolean',
        pages: [],
      },
      { module: 'churchdb', name: 'view', kind: 'boolean', pages: [] },
      { module: 'churchdb', name: 'view group', kind: 'list', pages: [] },
      { module: 'churchwiki', name: 'view', kind: 'boolean', pages: [] },
      { module: 'churchwiki', name: 'view category', kind: 'list', pages: [] },
    ]);
    expect(skipped).toBe(1);
    expect(JSON.stringify(entries)).not.toMatch(/17|23|Chosen/);
  });

  it('stops at a value that is neither true or false nor a list', () => {
    expect(
      whereOf(() => rightFacts({ data: { churchwiki: { view: 'ja' } } })),
    ).toBe('rights.data[0][0]');
    expect(whereOf(() => rightFacts({ rights: {} }))).toBe('rights.data');
  });

  it('passes the checks of the docs index', () => {
    const facts = parseFactFiles(
      factFileTexts({ ...emptyFacts(), rights: rightFacts(answer).entries }),
    );
    expect(facts.rights.entries).toHaveLength(5);
  });
});

const academy = 'https://churchtools.academy';

function terms(
  entries: readonly [number, string, number][],
): Map<number, Term> {
  return new Map(entries.map(([id, slug, parent]) => [id, { slug, parent }]));
}

function doc(
  id: number,
  slug: string,
  category: number,
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    slug,
    link: `${academy}/de/help/synthetisch/${slug}/`,
    status: 'publish',
    modified_gmt: '2026-10-01T12:00:00',
    title: { rendered: `Seite ${slug} &amp; mehr` },
    content: { rendered: `<p>Text von ${slug}.</p>`, protected: false },
    doc_category: [category],
    knowledge_base: [11],
    ...changes,
  };
}

function syntheticRead(docs: readonly Record<string, unknown>[]): AcademyRead {
  return {
    retrievedAt: '2026-10-29T08:00:00Z',
    categories: terms([
      [1, 'gruppen', 0],
      [2, 'mitglieder', 1],
      [3, 'website', 0],
      [4, 'integrationen', 0],
      [5, 'api', 4],
    ]),
    bases: terms([
      [10, 'churchtools-module', 0],
      [11, 'gruppen-basis', 10],
    ]),
    docs,
  };
}

describe('academyPages', () => {
  it('takes the pages of the sections and counts the others', () => {
    const read = syntheticRead([
      doc(1, 'b-seite', 2),
      doc(2, 'a-seite', 1),
      doc(3, 'website-seite', 3),
      doc(4, 'entwurf', 1, { status: 'draft' }),
      doc(5, 'ohne-basis', 1, { knowledge_base: [] }),
      doc(6, 'nur-bild', 1, {
        content: { rendered: '<p><img src="a.png"></p>', protected: false },
      }),
      doc(7, 'geschuetzt', 1, {
        content: { rendered: '<p>x</p>', protected: true },
      }),
    ]);
    const pages = academyPages(read, ['gruppen']);
    expect(pages.entries).toEqual([
      {
        path: '/de/help/synthetisch/a-seite/',
        title: 'Seite a-seite & mehr',
        section: 'gruppen',
        knowledgeBase: 'churchtools-module',
        modified: '2026-10-01',
        text: 'Text von a-seite.',
      },
      {
        path: '/de/help/synthetisch/b-seite/',
        title: 'Seite b-seite & mehr',
        section: 'gruppen',
        knowledgeBase: 'churchtools-module',
        modified: '2026-10-01',
        text: 'Text von b-seite.',
      },
    ]);
    expect(pages.fetched).toEqual([
      {
        path: '/de/help/synthetisch/a-seite/',
        sha256: createHash('sha256')
          .update('<p>Text von a-seite.</p>')
          .digest('hex'),
      },
      {
        path: '/de/help/synthetisch/b-seite/',
        sha256: createHash('sha256')
          .update('<p>Text von b-seite.</p>')
          .digest('hex'),
      },
    ]);
    expect(pages).toMatchObject({
      otherSections: 1,
      notPublic: 2,
      withoutBase: 1,
      withoutText: 1,
    });
  });

  it('takes a further category below another section', () => {
    const read = syntheticRead([doc(1, 'rest', 5)]);
    expect(academyPages(read, ['gruppen'], []).entries).toEqual([]);
    expect(academyPages(read, ['gruppen'], ['api']).entries[0]?.section).toBe(
      'integrationen',
    );
  });

  it('stops at a link outside the German pages of the Academy and at a path used twice', () => {
    expect(
      whereOf(() =>
        academyPages(
          syntheticRead([
            doc(1, 'x', 1, { link: 'https://example.com/de/help/x/' }),
          ]),
          ['gruppen'],
        ),
      ),
    ).toBe('academy.docs[0].link');
    expect(
      whereOf(() =>
        academyPages(
          syntheticRead([doc(1, 'x', 1, { link: `${academy}/en/help/x/` })]),
          ['gruppen'],
        ),
      ),
    ).toBe('academy.docs[0].link');
    expect(
      whereOf(() =>
        academyPages(syntheticRead([doc(1, 'x', 1), doc(2, 'x', 2)]), [
          'gruppen',
        ]),
      ),
    ).toBe('academy.pages[1].path');
  });

  it('passes the checks of the docs index', () => {
    const pages = academyPages(
      syntheticRead([doc(1, 'a', 1), doc(2, 'b', 2)]),
      ['gruppen'],
    );
    const facts = parseFactFiles(
      factFileTexts({
        ...emptyFacts(),
        academy: pages.entries,
        academyOrigin: {
          retrievedAt: '2026-10-29T08:00:00Z',
          pages: pages.fetched,
        },
      }),
    );
    expect(facts.academy.entries).toHaveLength(2);
  });
});

describe('readAcademy', () => {
  interface Asked {
    readonly path: string;
    readonly query: readonly (readonly [string, string])[];
  }

  function client(
    robots: string,
    lists: Record<string, readonly unknown[][]>,
  ): { academy: AcademyClient; asked: Asked[]; pauses: number[] } {
    const asked: Asked[] = [];
    const pauses: number[] = [];
    const academy: AcademyClient = {
      get(request) {
        asked.push({ path: request.path, query: request.query ?? [] });
        if (request.path === '/robots.txt') {
          return Promise.resolve(answer(200, robots, 'text/plain'));
        }
        const pages = lists[request.path] ?? [];
        const page = Number(
          request.query?.find(([name]) => name === 'page')?.[1] ?? '1',
        );
        return Promise.resolve(
          answer(
            200,
            JSON.stringify(pages[page - 1] ?? []),
            'application/json',
            {
              'x-wp-totalpages': String(Math.max(1, pages.length)),
            },
          ),
        );
      },
      slowDown(milliseconds) {
        pauses.push(milliseconds);
      },
    };
    return { academy, asked, pauses };
  }

  function answer(
    status: number,
    text: string,
    type: string,
    headers: Record<string, string> = {},
  ): AcademyResponse {
    return {
      status,
      headers: new Headers({ 'content-type': type, ...headers }),
      text,
      body: type.includes('json') ? JSON.parse(text) : undefined,
    };
  }

  const now = () => new Date('2026-10-29T08:00:00.789Z');

  it('reads robots.txt, both taxonomies and every page of the help pages, never the authors', async () => {
    const { academy, asked, pauses } = client(
      'User-agent: *\nCrawl-delay: 5\n',
      {
        '/de/wp-json/wp/v2/doc_category': [
          [{ id: 1, slug: 'gruppen', parent: 0 }],
        ],
        '/de/wp-json/wp/v2/knowledge_base': [
          [{ id: 10, slug: 'basis', parent: 0 }],
        ],
        '/de/wp-json/wp/v2/docs': [[doc(1, 'a', 1)], [doc(2, 'b', 1)]],
      },
    );
    const read = await readAcademy(academy, now);
    expect(read.retrievedAt).toBe('2026-10-29T08:00:00Z');
    expect(read.docs).toHaveLength(2);
    expect(read.categories.get(1)).toEqual({ slug: 'gruppen', parent: 0 });
    expect(pauses).toEqual([5000]);
    expect(asked.map((request) => request.path)).toEqual([
      '/robots.txt',
      '/de/wp-json/wp/v2/doc_category',
      '/de/wp-json/wp/v2/knowledge_base',
      '/de/wp-json/wp/v2/docs',
      '/de/wp-json/wp/v2/docs',
    ]);
    for (const request of asked.slice(1)) {
      const fields =
        request.query.find(([name]) => name === '_fields')?.[1] ?? '';
      expect(fields).not.toMatch(/author/);
    }
  });

  it('stops when robots.txt forbids a path or asks for too long a pause', async () => {
    for (const robots of [
      'User-agent: *\nDisallow: /de/wp-json/\n',
      'User-agent: ecclium-docs-refresh\nDisallow: /\n',
      'User-agent: *\nCrawl-delay: 60\n',
    ]) {
      const { academy } = client(robots, {});
      await expect(readAcademy(academy, now)).rejects.toMatchObject({
        hint: 'academyNichtLesbar',
      });
    }
  });
});

describe('SpikeError', () => {
  it('keeps a place of field names and indices and drops anything else', () => {
    const where = (place: string) =>
      new SpikeError('ANTWORT_UNGUELTIG', 'quelleUngueltig', place).where;
    expect(where('operations[3].parameters[1.0].in')).toBe(
      'operations[3].parameters[1.0].in',
    );
    expect(where('a value: with spaces')).toBeUndefined();
    expect(where('x'.repeat(201))).toBeUndefined();
  });
});
