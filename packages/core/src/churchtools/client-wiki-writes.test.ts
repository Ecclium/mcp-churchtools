import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  isEccliumError,
  type LogFields,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertOnlyReads,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createChurchToolsClient } from './client.js';
import {
  wikiPageCreateBodySchema,
  wikiPageUpdateBodySchema,
} from './schemas.js';

// The writes of the client for the wiki and the read a plan needs
// (ADR 0072). Every request goes through the real transport on the
// ChurchTools double, which answers from interceptors and connects
// nowhere. Answers hold canaries in every field the client does not pass
// on, also in bodies it never reads.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

interface Line {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

// A clock that runs one second per reading.
const runningClock = () => {
  let now = 0;
  return Object.freeze({
    now: (): number => {
      now += 1_000;
      return now;
    },
  });
};

const setup = (requestsPerMinute = 300) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const client = createChurchToolsClient({
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute,
    clock: runningClock(),
  });
  const lines: Line[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  const ctx = (instance = doubleOrigin): TenantContext =>
    Object.freeze({
      instance,
      signal: new AbortController().signal,
      log: Object.freeze({
        debug: record,
        info: record,
        warn: record,
        error: record,
      }),
      clock: runningClock(),
    }) as unknown as TenantContext;
  return { double, client, writes: client.writes, ctx, lines };
};

const json = { headers: { 'content-type': 'application/json' } };

// The code and message of a call that fails.
const errorOf = async (
  call: Promise<unknown>,
): Promise<{ code: string; message: string }> => {
  try {
    await call;
  } catch (error) {
    if (isEccliumError(error)) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('expected the call to fail');
};

const guid = '00000000-0000-4000-8000-000000000001';
const listPath = '/api/wiki/categories/4/pages';
const pagePath = `${listPath}/${guid}`;
const name = makeCanary('name');
const email = makeCanary('email');

// The answer 201 to a new page in the form F16 shows, with a canary in
// every field the client does not read.
const createdAnswer = (data: Readonly<Record<string, unknown>> = {}) => ({
  data: {
    guid,
    wikiCategory: { id: 4, name: name.value, permissions: {} },
    title: 'Dienstplan',
    version: 1,
    text: `# Dienstplan ${email.value}`,
    isMarkdown: true,
    onStartpage: false,
    redirectTo: null,
    permissions: { write: true },
    meta: {
      createdPerson: {
        title: name.value,
        domainAttributes: { email: email.value },
      },
    },
    identifier: guid,
    '@deprecated': { identifier: 'guid' },
    ...data,
  },
});

const pageAnswer = (version: number, text: string) => ({
  data: { title: 'Dienstplan', isMarkdown: true, version, text },
});

const canaries = [name, email];

describe('creating a page', () => {
  it('sends POST with exactly title, text and isMarkdown true, and gives GUID, title, version and format', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: listPath, method: 'POST' })
      .reply(201, JSON.stringify(createdAnswer()), json);
    const created = await writes.createWikiPage(
      ctx(),
      4,
      'Dienstplan',
      '# Dienstplan\n\n- Ä und ö\n',
    );
    expect(created).toEqual({
      guid,
      title: 'Dienstplan',
      version: 1,
      isMarkdown: true,
    });
    expect(Object.getPrototypeOf(created)).toBeNull();
    expect(Object.isFrozen(created)).toBe(true);
    const [call] = double.calls();
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe(listPath);
    expect(call?.searchParams).toEqual({});
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.body).toBe(
      '{"title":"Dienstplan","text":"# Dienstplan\\n\\n- Ä und ö\\n","isMarkdown":true}',
    );
    // The body fits the schema the contract check compares, and has no
    // field besides.
    const sent = JSON.parse(call?.body ?? '') as Record<string, unknown>;
    expect(wikiPageCreateBodySchema.strict().safeParse(sent).success).toBe(
      true,
    );
    assertNoCanary([created, lines], canaries, 'result and log');
    expect(lines).toEqual([]);
  });

  // The page exists once ChurchTools answered 201; the write guard judges
  // a title or format other than sent from what comes back.
  it('gives back a title and format other than sent, as ChurchTools stored them', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: listPath, method: 'POST' })
      .reply(
        201,
        JSON.stringify(
          createdAnswer({ title: 'Anders', isMarkdown: false, version: 2 }),
        ),
        json,
      );
    expect(await writes.createWikiPage(ctx(), 4, 'Dienstplan', 'Text')).toEqual(
      { guid, title: 'Anders', version: 2, isMarkdown: false },
    );
  });

  it.each([
    ['no GUID', createdAnswer({ guid: undefined })],
    ['a GUID of another form', createdAnswer({ guid: 'Dienstplan' })],
    ['version 0', createdAnswer({ version: 0 })],
    ['no data', {}],
  ])('ends with upstream for an answer 201 with %s', async (_, answer) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: listPath, method: 'POST' })
      .reply(201, JSON.stringify(answer), json);
    expect(
      (await errorOf(writes.createWikiPage(ctx(), 4, 'Dienstplan', 'Text')))
        .code,
    ).toBe('upstream');
    expect(lines).toEqual([
      {
        event: 'churchtools_wiki_page_create_refused',
        fields: { code: 'upstream' },
      },
    ]);
  });

  it('ends with upstream for an answer 201 that is no JSON, and never logs its text', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: listPath, method: 'POST' })
      .reply(201, `created ${email.value}`, {
        headers: { 'content-type': 'text/plain' },
      });
    expect(
      (await errorOf(writes.createWikiPage(ctx(), 4, 'Dienstplan', 'Text')))
        .code,
    ).toBe('upstream');
    expect(lines).toEqual([
      {
        event: 'churchtools_wiki_page_create_refused',
        fields: { code: 'upstream' },
      },
    ]);
    assertNoCanary(lines, canaries, 'log');
  });

  it.each([
    [200, 'upstream'],
    [204, 'upstream'],
    [401, 'auth'],
    [403, 'permission'],
    [409, 'upstream'],
    [500, 'upstream'],
  ])(
    'ends with the code of status %i and never reads its body',
    async (status, code) => {
      const { double, writes, ctx, lines } = setup();
      double
        .intercept({ path: listPath, method: 'POST' })
        .reply(status, JSON.stringify(createdAnswer()), json);
      const error = await errorOf(
        writes.createWikiPage(ctx(), 4, 'Dienstplan', 'Text'),
      );
      expect(error.code).toBe(code);
      expect(lines).toEqual([
        {
          event: 'churchtools_wiki_page_create_status',
          fields: { status, code },
        },
      ]);
      assertNoCanary([error, lines], canaries, 'error and log');
    },
  );

  // A second page with the title of one in the same category gives 400
  // (F8). Without the meaning of the operation, 400 is internal.
  it('ends with conflict and a sentence on the title for 400', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: listPath, method: 'POST' })
      .reply(400, JSON.stringify({ message: email.value }), json);
    const error = await errorOf(
      writes.createWikiPage(ctx(), 4, 'Dienstplan', 'Text'),
    );
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('A page with this title may already exist');
    expect(lines).toEqual([
      {
        event: 'churchtools_wiki_page_create_status',
        fields: { status: 400, code: 'conflict' },
      },
    ]);
    assertNoCanary([error, lines], canaries, 'error and log');
  });

  it('ends with not_found for a category that does not exist', async () => {
    const { double, writes, ctx, lines } = setup();
    double.intercept({ path: listPath, method: 'POST' }).reply(404, '{}', json);
    expect(
      (await errorOf(writes.createWikiPage(ctx(), 4, 'Dienstplan', 'Text')))
        .code,
    ).toBe('not_found');
    expect(lines).toEqual([
      {
        event: 'churchtools_wiki_page_create_missing',
        fields: { status: 404, code: 'not_found' },
      },
    ]);
  });

  it('names the wait of a 429 from Retry-After', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: listPath, method: 'POST' })
      .reply(429, '{}', { headers: { 'retry-after': '30' } });
    expect(
      await errorOf(writes.createWikiPage(ctx(), 4, 'Dienstplan', 'Text')),
    ).toEqual({
      code: 'rate_limited',
      message:
        'ChurchTools limits the number of requests. Wait 30 seconds, then try again.',
    });
  });

  it('takes the longest title and a text of exactly 64 KiB, in one and in two bytes per character', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: listPath, method: 'POST' })
      .reply(201, JSON.stringify(createdAnswer()), json)
      .times(2);
    await writes.createWikiPage(ctx(), 4, 'T'.repeat(255), 'a'.repeat(65_536));
    await writes.createWikiPage(ctx(), 4, 'Ü', 'ä'.repeat(32_768));
    expect(double.calls()).toHaveLength(2);
  });

  it.each([
    ['category 0', 0, 'Dienstplan', 'Text'],
    ['a category that is no whole number', 1.5, 'Dienstplan', 'Text'],
    ['a category as text', '4', 'Dienstplan', 'Text'],
    ['an empty title', 4, '', 'Text'],
    ['a title of 256 characters', 4, 'T'.repeat(256), 'Text'],
    ['a title with a space at the start', 4, ' Dienstplan', 'Text'],
    ['a title with a space at the end', 4, 'Dienstplan ', 'Text'],
    ['a title with a line break', 4, 'Dienst\nplan', 'Text'],
    ['a title with a control character of C1', 4, 'Dienst\u0085plan', 'Text'],
    ['a title with DEL', 4, 'Dienst\u007fplan', 'Text'],
    ['a title with a lone surrogate', 4, 'Dienst\ud800', 'Text'],
    ['a title that is no text', 4, 1, 'Text'],
    ['an empty text', 4, 'Dienstplan', ''],
    ['a text one byte above 64 KiB', 4, 'Dienstplan', 'a'.repeat(65_537)],
    ['a text above 64 KiB in UTF-8 only', 4, 'Dienstplan', 'ä'.repeat(32_769)],
    ['a text with U+0000', 4, 'Dienstplan', 'Text\u0000'],
    ['a text with a lone surrogate', 4, 'Dienstplan', 'Text\udc00'],
    ['a text that is no text', 4, 'Dienstplan', null],
  ])(
    'refuses %s with validation before it asks ChurchTools',
    async (_, categoryId, title, text) => {
      const { double, writes, ctx, lines } = setup(6);
      const error = await errorOf(
        writes.createWikiPage(
          ctx('https://other.example'),
          categoryId as number,
          title as string,
          text as string,
        ),
      );
      expect(error.code).toBe('validation');
      expect(error.message).toContain('A title has 1 to 255 characters');
      expect(double.calls()).toEqual([]);
      expect(lines).toEqual([
        {
          event: 'churchtools_wiki_write_input_refused',
          fields: { code: 'validation' },
        },
      ]);
    },
  );

  // A throttle of 6 requests per minute has room for one at once. The
  // refused input above took none, so the same throttle is shown here.
  it('takes a place of the same throttle as a read, and asks nothing for another tenant', async () => {
    const { double, client, writes, ctx } = setup(6);
    expect(
      (
        await errorOf(
          writes.createWikiPage(ctx('https://other.example'), 4, 'D', 'T'),
        )
      ).code,
    ).toBe('internal');
    double
      .intercept({ path: listPath, method: 'POST' })
      .reply(201, JSON.stringify(createdAnswer()), json);
    await writes.createWikiPage(ctx(), 4, 'Dienstplan', 'Text');
    expect((await errorOf(client.whoami(ctx()))).code).toBe('rate_limited');
    expect(double.calls()).toHaveLength(1);
  });
});

describe('changing a page', () => {
  it('sends PATCH with exactly the text and reads nothing of the answer', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, `not even JSON ${email.value}`, {
        headers: { 'content-type': 'text/plain' },
      });
    await expect(
      writes.updateWikiPage(ctx(), 4, guid, 'Neuer Text'),
    ).resolves.toBeUndefined();
    const [call] = double.calls();
    expect(call?.method).toBe('PATCH');
    expect(call?.path).toBe(pagePath);
    expect(call?.body).toBe('{"text":"Neuer Text"}');
    const sent = JSON.parse(call?.body ?? '') as Record<string, unknown>;
    expect(wikiPageUpdateBodySchema.strict().safeParse(sent).success).toBe(
      true,
    );
    expect(lines).toEqual([]);
  });

  it.each([
    [201, 'upstream'],
    [204, 'upstream'],
    [400, 'internal'],
    [401, 'auth'],
    [403, 'permission'],
    [500, 'upstream'],
  ])('ends with the code of status %i', async (status, code) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(status, JSON.stringify({ message: email.value }), json);
    const error = await errorOf(writes.updateWikiPage(ctx(), 4, guid, 'T'));
    expect(error.code).toBe(code);
    expect(lines).toEqual([
      {
        event: 'churchtools_wiki_page_update_status',
        fields: { status, code },
      },
    ]);
    assertNoCanary([error, lines], canaries, 'error and log');
  });

  it('ends with not_found for a page that does not exist', async () => {
    const { double, writes, ctx, lines } = setup();
    double.intercept({ path: pagePath, method: 'PATCH' }).reply(404, '{}');
    expect(
      (await errorOf(writes.updateWikiPage(ctx(), 4, guid, 'T'))).code,
    ).toBe('not_found');
    expect(lines).toEqual([
      {
        event: 'churchtools_wiki_page_update_missing',
        fields: { status: 404, code: 'not_found' },
      },
    ]);
  });

  it.each([
    ['a title instead of a GUID', 4, 'Dienstplan', 'T'],
    ['a GUID with a path', 4, `${guid}/../x`, 'T'],
    ['category 0', 0, guid, 'T'],
    ['an empty text', 4, guid, ''],
    ['a text above 64 KiB', 4, guid, 'a'.repeat(65_537)],
  ])(
    'refuses %s with validation before it asks ChurchTools',
    async (_, categoryId, page, text) => {
      const { double, writes, ctx, lines } = setup();
      expect(
        (await errorOf(writes.updateWikiPage(ctx(), categoryId, page, text)))
          .code,
      ).toBe('validation');
      expect(double.calls()).toEqual([]);
      expect(lines.map((line) => line.event)).toEqual([
        'churchtools_wiki_write_input_refused',
      ]);
    },
  );
});

describe('the state of a page for a plan', () => {
  it('gives the page with the time of ChurchTools from the date header', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, JSON.stringify(pageAnswer(3, 'Text')), {
        headers: {
          'content-type': 'application/json',
          date: 'Sun, 01 Nov 2026 20:00:00 GMT',
        },
      });
    const state = await writes.wikiPageState(ctx(), 4, guid);
    expect(state).toEqual({
      page: {
        guid,
        title: 'Dienstplan',
        isMarkdown: true,
        version: 3,
        text: 'Text',
      },
      serverTime: Date.UTC(2026, 10, 1, 20, 0, 0),
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.getPrototypeOf(state)).toBeNull();
    assertOnlyReads(double);
  });

  it.each([
    ['without a date header', {}],
    ['with a date of another form', { date: 'Sunday, 01-Nov-26 20:00:00 GMT' }],
  ])('gives no time %s', async (_, headers) => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, JSON.stringify(pageAnswer(3, 'Text')), {
        headers: { 'content-type': 'application/json', ...headers },
      });
    expect((await writes.wikiPageState(ctx(), 4, guid)).serverTime).toBeNull();
  });

  it('fails as the read of a page does', async () => {
    const { double, writes, ctx, lines } = setup();
    double.intercept({ path: pagePath, method: 'GET' }).reply(404, '{}');
    expect((await errorOf(writes.wikiPageState(ctx(), 4, guid))).code).toBe(
      'not_found',
    );
    expect(
      (await errorOf(writes.wikiPageState(ctx(), 4, 'Dienstplan'))).code,
    ).toBe('validation');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_wiki_page_missing',
      'churchtools_wiki_input_refused',
    ]);
  });
});

// The read before, the write and the read after, as the write guard will
// run them: only the write counts against a dry run.
describe('a write between two reads', () => {
  it('reads the version before and after, and only the write is no read', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, JSON.stringify(pageAnswer(3, 'Alt')), json);
    double.intercept({ path: pagePath, method: 'PATCH' }).reply(200, '{}');
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, JSON.stringify(pageAnswer(4, 'Neu')), json);
    const before = await writes.wikiPageState(ctx(), 4, guid);
    assertOnlyReads(double);
    await writes.updateWikiPage(ctx(), 4, guid, 'Neu');
    const after = await writes.wikiPageState(ctx(), 4, guid);
    expect(after.page.version).toBe(before.page.version + 1);
    expect(after.page.text).toBe('Neu');
    expect(() => {
      assertOnlyReads(double);
    }).toThrow(`1 request(s) would write: PATCH ${pagePath}`);
  });
});
