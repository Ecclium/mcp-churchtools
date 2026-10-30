import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import type {
  ReadApi,
  TenantAssignment,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  makeCanaries,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from '../core-plugin.js';
import {
  categoriesPerCall,
  noCategoryVisible,
  pastLastCategory,
  wikiCategoriesListTool,
} from './categories.js';
import { pageNotFound, partOutOfRange, wikiPageGetTool } from './page.js';
import {
  emptyPageMoreFollow,
  noPageListed,
  pastLastPage,
  wikiPagesListTool,
} from './pages.js';
import { splitIntoParts } from '../parts.js';
import { categoryRefused, wikiRefused } from './rights.js';

// The three tools of the wiki run through the pipeline of the core on the
// double of ChurchTools, as the server runs them, with the toolset wiki
// only. They hold no special data, so no audit file is needed.

type AuditSink = ToolPipelineOptions['audit'];
type AuditDraft = Parameters<AuditSink['record']>[0];
type LineWriter = ToolPipelineOptions['logging']['writer'];

const canary = makeCanaries();
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const json = { headers: { 'content-type': 'application/json' } };
const guid = '00000000-0000-4000-8000-000000000001';
const pagePath = `/api/wiki/categories/4/pages/${guid}`;
const atPages = (path: string): boolean =>
  path.split('?')[0] === '/api/wiki/pages';

const request = (): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const setup = () => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const lines: string[] = [];
  const drafts: AuditDraft[] = [];
  const writer: LineWriter = Object.freeze({
    write: (line: string) => {
      lines.push(line);
      return true;
    },
  });
  const audit: AuditSink = Object.freeze({
    record: (draft: AuditDraft) => {
      drafts.push(draft);
      return true;
    },
    hasFile: false,
    ready: () => true,
    failures: () => 0,
  });
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(),
    catalog: createToolCatalog({
      core: createCorePlugin(),
      toolsets: new Set(['wiki'] as const),
      plugins: [],
      readOnly: true,
    }),
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: { writer, minLevel: 'debug' },
  });
  const call = (name: string, input: unknown) =>
    pipeline.call(name, input, request());
  return { double, lines, drafts, call };
};

// A text in the data envelope: the markers with the boundary of the call
// around it.
const enveloped = (text: string): unknown =>
  expect.stringMatching(
    new RegExp(
      `^<<data-[^>]+>>${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}<</data-[^>]+>>$`,
      'u',
    ),
  ) as unknown;

const categoryList = (count: number) =>
  JSON.stringify({
    data: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      name: `Kategorie ${String(index + 1)}`,
      permissions: { canEdit: false, canDelete: false },
    })),
    meta: { count },
    permissions: { editMasterData: false },
  });

const pageEntry = (index: number) => ({
  guid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  title: `Seite ${String(index)}`,
  version: index,
  isMarkdown: true,
  meta: { modifiedPerson: { title: 'Person A' } },
});

const pageList = (count: number, current = 1, lastPage = 1) =>
  JSON.stringify({
    data: Array.from({ length: count }, (_, index) => pageEntry(index + 1)),
    meta: {
      count,
      pagination: { total: count, limit: 50, current, lastPage },
    },
  });

const pageAnswer = (text: string | null, version = 3) =>
  JSON.stringify({
    data: {
      guid,
      title: 'Seite A',
      version,
      isMarkdown: true,
      text,
      meta: { modifiedPerson: { title: 'Person A' } },
    },
  });

describe('ct_wiki_categories_list', () => {
  it('lists ID and name of each category, the name in the data envelope', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(200, categoryList(2), json);
    const outcome = await call('ct_wiki_categories_list', {});
    expect(outcome.ok && outcome.data).toEqual({
      page: 1,
      categories: [
        { id: 1, name: enveloped('Kategorie 1') },
        { id: 2, name: enveloped('Kategorie 2') },
      ],
      more: false,
      notice: null,
    });
  });

  it('pages through the categories, 25 per call', async () => {
    const { double, call } = setup();
    for (let index = 0; index < 3; index += 1) {
      double
        .intercept({ path: '/api/wiki/categories', method: 'GET' })
        .reply(200, categoryList(51), json);
    }
    const first = await call('ct_wiki_categories_list', {});
    const third = await call('ct_wiki_categories_list', { page: 3 });
    const fourth = await call('ct_wiki_categories_list', { page: 4 });
    expect(categoriesPerCall).toBe(25);
    expect(first.ok && first.data.categories).toHaveLength(25);
    expect(first.ok && first.data.more).toBe(true);
    expect(third.ok && third.data).toEqual({
      page: 3,
      categories: [{ id: 51, name: enveloped('Kategorie 51') }],
      more: false,
      notice: null,
    });
    expect(fourth.ok && fourth.data.notice).toBe(pastLastCategory);
  });

  it('names the right for an empty list', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(200, categoryList(0), json);
    const empty = await call('ct_wiki_categories_list', {});
    expect(empty.ok && empty.data.notice).toBe(noCategoryVisible);
    expect(noCategoryVisible).toContain('"view category" in churchwiki');
  });

  it('passes 25 names of 255 quotes and of 255 wide characters within the limit of a result', async () => {
    const { double, call } = setup();
    for (const sign of ['"', '語']) {
      double.intercept({ path: '/api/wiki/categories', method: 'GET' }).reply(
        200,
        JSON.stringify({
          data: Array.from({ length: 25 }, (_, index) => ({
            id: index + 1,
            name: sign.repeat(255),
          })),
        }),
        json,
      );
      const outcome = await call('ct_wiki_categories_list', {});
      expect(outcome.ok && outcome.data.categories).toHaveLength(25);
    }
  });

  it('names the right view when ChurchTools refuses the wiki', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(403, '{}', json);
    const outcome = await call('ct_wiki_categories_list', {});
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'permission',
      message: wikiRefused,
      missingRights: [{ module: 'churchwiki', right: 'view' }],
    });
  });

  it.each([
    ['a page 0', { page: 0 }],
    ['a page beyond 40', { page: 41 }],
    ['an argument the model made up', { limit: 100 }],
  ])('refuses %s with validation, before any request', async (_, input) => {
    const { double, call } = setup();
    const outcome = await call('ct_wiki_categories_list', input);
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
  });
});

describe('ct_wiki_pages_list', () => {
  it('lists the first page of a category with GUID, title, format and version', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: atPages, method: 'GET' })
      .reply(200, pageList(2, 1, 2), json);
    const outcome = await call('ct_wiki_pages_list', { categoryId: 4 });
    expect(outcome.ok && outcome.data).toEqual({
      categoryId: 4,
      page: 1,
      pages: [
        {
          guid: '00000000-0000-4000-8000-000000000001',
          title: enveloped('Seite 1'),
          isMarkdown: true,
          version: 1,
        },
        {
          guid: '00000000-0000-4000-8000-000000000002',
          title: enveloped('Seite 2'),
          isMarkdown: true,
          version: 2,
        },
      ],
      more: true,
      notice: null,
    });
    expect(double.calls()[0]?.searchParams).toEqual({
      'wiki_category_ids[]': '4',
      page: '1',
      limit: '25',
    });
  });

  it('names the right for an empty first page and says the list ended for a later one', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: atPages, method: 'GET' })
      .reply(200, pageList(0), json);
    double
      .intercept({ path: atPages, method: 'GET' })
      .reply(200, pageList(0, 3, 2), json);
    const first = await call('ct_wiki_pages_list', { categoryId: 4 });
    expect(first.ok && first.data.notice).toBe(noPageListed);
    expect(noPageListed).toContain('"view category" in churchwiki');
    const later = await call('ct_wiki_pages_list', { categoryId: 4, page: 3 });
    expect(later.ok && later.data).toMatchObject({
      page: 3,
      pages: [],
      more: false,
      notice: pastLastPage,
    });
  });

  // ChurchTools may count pages the account cannot see, so an empty page
  // with further ones reported does not end the list.
  it('says that further pages may follow when an empty page still has more', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: atPages, method: 'GET' })
      .reply(200, pageList(0, 2, 5), json);
    const outcome = await call('ct_wiki_pages_list', {
      categoryId: 4,
      page: 2,
    });
    expect(outcome.ok && outcome.data).toMatchObject({
      pages: [],
      more: true,
      notice: emptyPageMoreFollow,
    });
  });

  it('passes 25 titles of 255 quotes and of 255 wide characters within the limit of a result', async () => {
    const { double, call } = setup();
    for (const sign of ['"', '語']) {
      double.intercept({ path: atPages, method: 'GET' }).reply(
        200,
        JSON.stringify({
          data: Array.from({ length: 25 }, (_, index) => ({
            ...pageEntry(index + 1),
            title: sign.repeat(255),
          })),
          meta: {
            pagination: { total: 25, limit: 25, current: 1, lastPage: 1 },
          },
        }),
        json,
      );
      const outcome = await call('ct_wiki_pages_list', { categoryId: 4 });
      expect(outcome.ok && outcome.data.pages).toHaveLength(25);
    }
  });

  it('names both rights when ChurchTools refuses the list', async () => {
    const { double, call } = setup();
    double.intercept({ path: atPages, method: 'GET' }).reply(403, '{}', json);
    const outcome = await call('ct_wiki_pages_list', { categoryId: 4 });
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'permission',
      message: categoryRefused,
      missingRights: [
        { module: 'churchwiki', right: 'view' },
        { module: 'churchwiki', right: 'view category' },
      ],
    });
  });

  it.each([
    ['no category', {}],
    ['a category 0', { categoryId: 0 }],
    ['a category as text', { categoryId: '4' }],
    ['a page 0', { categoryId: 4, page: 0 }],
    ['a page beyond 1000', { categoryId: 4, page: 1001 }],
    ['an argument the model made up', { categoryId: 4, limit: 100 }],
  ])('refuses %s with validation, before any request', async (_, input) => {
    const { double, call } = setup();
    const outcome = await call('ct_wiki_pages_list', input);
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
  });
});

describe('ct_wiki_page_get', () => {
  it('reads the newest version and gives its text whole as one part', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer('# Titel\n\nText'), json);
    const outcome = await call('ct_wiki_page_get', { categoryId: 4, guid });
    expect(outcome.ok && outcome.data).toEqual({
      categoryId: 4,
      guid,
      title: enveloped('Seite A'),
      isMarkdown: true,
      version: 3,
      part: 1,
      parts: 1,
      text: enveloped('# Titel\n\nText'),
    });
  });

  it('reads the version asked for and gives the part asked for', async () => {
    const { double, call } = setup();
    const lines = Array.from(
      { length: 4_000 },
      (_, index) => `Zeile ${String(index)}`,
    );
    double
      .intercept({ path: `${pagePath}/versions/2`, method: 'GET' })
      .reply(200, pageAnswer(lines.join('\n'), 2), json);
    const outcome = await call('ct_wiki_page_get', {
      categoryId: 4,
      guid,
      version: 2,
      part: 2,
    });
    expect(outcome.ok && outcome.data).toMatchObject({
      version: 2,
      part: 2,
      parts: 3,
    });
    expect(outcome.ok && outcome.data.text).toEqual(
      enveloped(splitIntoParts(lines.join('\n'))[1] ?? ''),
    );
  });

  it('passes the largest part of a text of quotes within the limit of a result', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer('"'.repeat(20_000)), json);
    const outcome = await call('ct_wiki_page_get', { categoryId: 4, guid });
    expect(outcome.ok && outcome.data).toMatchObject({ part: 1, parts: 3 });
  });

  it('reads a page without text as one empty part', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer(null), json);
    const outcome = await call('ct_wiki_page_get', { categoryId: 4, guid });
    expect(outcome.ok && outcome.data).toMatchObject({
      part: 1,
      parts: 1,
      text: enveloped(''),
    });
  });

  it('names the number of parts for a part beyond the last', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer('kurz'), json);
    const outcome = await call('ct_wiki_page_get', {
      categoryId: 4,
      guid,
      part: 2,
    });
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'validation',
      message: partOutOfRange(1),
    });
  });

  it.each([
    [404, { code: 'not_found', message: pageNotFound }],
    [
      403,
      {
        code: 'permission',
        message: categoryRefused,
        missingRights: [
          { module: 'churchwiki', right: 'view' },
          { module: 'churchwiki', right: 'view category' },
        ],
      },
    ],
  ])(
    'turns status %i into an error the model can act on',
    async (status, error) => {
      const { double, call } = setup();
      double
        .intercept({ path: pagePath, method: 'GET' })
        .reply(status, '{}', json);
      const outcome = await call('ct_wiki_page_get', { categoryId: 4, guid });
      expect(!outcome.ok && outcome.error).toEqual(error);
    },
  );

  it.each([
    ['a title instead of a GUID', { categoryId: 4, guid: 'Startseite' }],
    ['a path in the GUID', { categoryId: 4, guid: `${guid}/versions` }],
    ['no category', { guid }],
    ['a version 0', { categoryId: 4, guid, version: 0 }],
    ['a part 0', { categoryId: 4, guid, part: 0 }],
    ['an argument the model made up', { categoryId: 4, guid, raw: true }],
  ])('refuses %s with validation, before any request', async (_, input) => {
    const { double, call } = setup();
    const outcome = await call('ct_wiki_page_get', input);
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
  });

  it('keeps title and text out of log and audit', async () => {
    const { double, lines, drafts, call } = setup();
    const title = makeCanary('name');
    double.intercept({ path: pagePath, method: 'GET' }).reply(
      200,
      JSON.stringify({
        data: {
          title: title.value,
          version: 1,
          isMarkdown: true,
          text: `Text von ${canary.name.value}`,
        },
      }),
      json,
    );
    const outcome = await call('ct_wiki_page_get', { categoryId: 4, guid });
    // Title and text reached the result, so the check below proves something.
    assertPlanted(outcome, [title, canary.name], 'result');
    expect(lines.length).toBeGreaterThan(0);
    expect(drafts).toEqual([
      expect.objectContaining({ tool: 'ct_wiki_page_get', outcome: 'ok' }),
    ]);
    assertNoCanary([lines, drafts], [title, canary.name], 'log and audit');
  });
});

// The layer of the tools, without client and pipeline: whatever the read
// access hands them, they pass on only their fields.
describe('the layer of the tools', () => {
  const leak = makeCanaries();
  const call = { ctx: {} as TenantContext };

  it('copies only ID and name of a category', async () => {
    const read = {
      wikiCategories: () =>
        Promise.resolve([{ id: 1, name: 'A', note: leak.name.value }]),
    } as unknown as ReadApi;
    const result = await wikiCategoriesListTool.execute({
      ...call,
      input: {},
      read,
    });
    expect(result.categories).toEqual([{ id: 1, name: 'A' }]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only GUID, title, format and version of a page in a list', async () => {
    const read = {
      wikiPages: () =>
        Promise.resolve({
          pages: [
            {
              guid,
              title: 'A',
              isMarkdown: true,
              version: 1,
              text: leak.email.value,
            },
          ],
          more: false,
        }),
    } as unknown as ReadApi;
    const result = await wikiPagesListTool.execute({
      ...call,
      input: { categoryId: 4 },
      read,
    });
    expect(result.pages).toEqual([
      { guid, title: 'A', isMarkdown: true, version: 1 },
    ]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the fields of a page', async () => {
    const read = {
      wikiPage: () =>
        Promise.resolve({
          guid,
          title: 'A',
          isMarkdown: false,
          version: 2,
          text: '<p>Text</p>',
          author: leak.name.value,
        }),
    } as unknown as ReadApi;
    const result = await wikiPageGetTool.execute({
      ...call,
      input: { categoryId: 4, guid },
      read,
    });
    expect(result).toEqual({
      categoryId: 4,
      guid,
      title: 'A',
      isMarkdown: false,
      version: 2,
      part: 1,
      parts: 1,
      text: '<p>Text</p>',
    });
    assertNoCanary(result, leak.all, 'result of the tool');
  });
});

// The fields of each result with their classes: free text stands in the
// data envelope, everything else describes the wiki, not a person.
describe('the output of the tools of the wiki', () => {
  const catalog = createToolCatalog({
    core: createCorePlugin(),
    toolsets: new Set(['wiki'] as const),
    plugins: [],
    readOnly: true,
  });
  const classes = (name: string, path: readonly string[]): unknown => {
    let node = catalog.get(name)?.shape.root as unknown as {
      fields?: Record<string, unknown>;
      element?: unknown;
      dataClass?: unknown;
    };
    for (const step of path) {
      node = (
        step === '[]' ? node.element : node.fields?.[step]
      ) as typeof node;
    }
    return Object.fromEntries(
      Object.entries(node.fields ?? {}).map(([key, value]) => [
        key,
        (value as { dataClass?: unknown }).dataClass ?? 'object',
      ]),
    );
  };

  it('declares exactly its fields, each with its class', () => {
    expect(classes('ct_wiki_categories_list', [])).toEqual({
      page: 'none',
      categories: 'object',
      more: 'none',
      notice: 'none',
    });
    expect(classes('ct_wiki_categories_list', ['categories', '[]'])).toEqual({
      id: 'none',
      name: 'untrusted',
    });
    expect(classes('ct_wiki_pages_list', ['pages', '[]'])).toEqual({
      guid: 'none',
      title: 'untrusted',
      isMarkdown: 'none',
      version: 'none',
    });
    expect(classes('ct_wiki_page_get', [])).toEqual({
      categoryId: 'none',
      guid: 'none',
      title: 'untrusted',
      isMarkdown: 'none',
      version: 'none',
      part: 'none',
      parts: 'none',
      text: 'untrusted',
    });
  });
});
