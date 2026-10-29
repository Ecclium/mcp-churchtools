// Tests of the client for the academy. The answers are synthetic; no test
// reaches the real host (see tests/fixtures/README.md).
import { describe, expect, it } from 'vitest';

import {
  academyOrigin,
  academyPauseMs,
  createAcademyClient,
  maxAcademyPauseMs,
  type AcademyClient,
} from '../../scripts/spike/lib/academy.mts';
import { SpikeError } from '../../scripts/spike/lib/errors.mts';
import {
  userAgent,
  type FetchFunction,
} from '../../scripts/spike/lib/http.mts';

/** One request the synthetic academy received. */
interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}

interface Academy {
  readonly client: AcademyClient;
  readonly calls: Call[];
  readonly waits: number[];
}

function academy(
  answer: (url: URL) => Response = () =>
    new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    }),
): Academy {
  const calls: Call[] = [];
  const waits: number[] = [];
  const fetch: FetchFunction = (input, init) => {
    calls.push({ url: input, init });
    return Promise.resolve(answer(input));
  };
  const client = createAcademyClient({
    fetch,
    wait: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });
  return { client, calls, waits };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof SpikeError ? error.code : 'anderer Fehler';
  }
  return 'kein Fehler';
}

describe('the client for the academy', () => {
  it('sends only GET to the academy, without a token, a cookie or a redirect', async () => {
    const { client, calls } = academy();
    await client.get({ path: '/robots.txt' });
    await client.get({
      path: '/de/wp-json/wp/v2/docs',
      query: [
        ['per_page', '50'],
        ['page', '2'],
        ['_fields', 'id,modified_gmt,content'],
      ],
    });
    expect(calls).toHaveLength(2);
    for (const { url, init } of calls) {
      expect(url.origin).toBe(academyOrigin);
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('manual');
      expect(init.credentials).toBe('omit');
      const headers = new Headers(init.headers);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('cookie')).toBe(false);
      expect(headers.get('user-agent')).toBe(userAgent);
    }
    expect(calls[1]?.url.search).toBe(
      '?per_page=50&page=2&_fields=id%2Cmodified_gmt%2Ccontent',
    );
  });

  it('reaches only the fixed paths and query parameters', async () => {
    const refused = [
      { path: '/wp-admin/' },
      { path: '/de/wp-json/wp/v2/users' },
      { path: '/de/wp-json/wp/v2/docs/12' },
      { path: '/de/wp-json/wp/v2/docs?search=x' },
      { path: '/de/wp-json/wp/v2/docs#x' },
      { path: '/deu/wp-json/wp/v2/docs' },
      { path: '//example.church.tools/de/help/' },
      { path: 'https://example.church.tools/robots.txt' },
      { path: '/de/./wp-json/' },
      { path: '/de/%2e%2e/wp-json/' },
      { path: '/de/help/', query: [['search', 'x']] as const },
      { path: '/de/help/', query: [['page', '1&x=2']] as const },
      { path: '/de/help/', query: [['page', '']] as const },
    ];
    for (const request of refused) {
      const { client, calls } = academy();
      expect(await codeOf(client.get(request)), request.path).toBe('INTERN');
      expect(calls, request.path).toEqual([]);
    }
    const allowed = [
      '/robots.txt',
      '/de/help/',
      '/de/wp-json/',
      '/de/wp-json/wp/v2/docs',
      '/de/wp-json/wp/v2/doc_category',
      '/de/wp-json/wp/v2/knowledge_base',
      '/en/wp-json/wp/v2/docs',
    ];
    for (const path of allowed) {
      const { client, calls } = academy();
      await client.get({ path });
      expect(calls.map((call) => call.url.pathname)).toEqual([path]);
    }
  });

  it('waits between two requests, longer after a Crawl-delay, never shorter', async () => {
    const { client, waits } = academy();
    await client.get({ path: '/robots.txt' });
    expect(waits).toEqual([]);
    await client.get({ path: '/de/help/' });
    client.slowDown(5000);
    await client.get({ path: '/de/wp-json/' });
    client.slowDown(1000);
    await client.get({ path: '/de/wp-json/' });
    expect(waits).toEqual([academyPauseMs, 5000, 5000]);
    expect(() => {
      client.slowDown(maxAcademyPauseMs + 1);
    }).toThrow(SpikeError);
    expect(() => {
      client.slowDown(Number.NaN);
    }).toThrow(SpikeError);
  });

  it('waits also after a request that failed', async () => {
    const { client, waits } = academy(() => new Response('', { status: 500 }));
    await client.get({ path: '/robots.txt' });
    await client.get({ path: '/robots.txt' });
    expect(waits).toEqual([academyPauseMs]);
  });

  it('refuses a redirect and an oversized answer', async () => {
    const redirect = academy(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://example.church.tools/' },
        }),
    );
    expect(await codeOf(redirect.client.get({ path: '/de/help/' }))).toBe(
      'HTTP_REDIRECT',
    );
    const calls: URL[] = [];
    const large = createAcademyClient({
      fetch: (input) => {
        calls.push(input);
        return Promise.resolve(new Response('x'.repeat(2048)));
      },
      wait: () => Promise.resolve(),
      maxBytes: 1024,
    });
    expect(await codeOf(large.get({ path: '/de/help/' }))).toBe(
      'ANTWORT_ZU_GROSS',
    );
    expect(calls).toHaveLength(1);
  });

  it('maps a network error to a fixed code', async () => {
    const client = createAcademyClient({
      fetch: () =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
          }),
        ),
      wait: () => Promise.resolve(),
    });
    expect(await codeOf(client.get({ path: '/robots.txt' }))).toBe('NETZ_DNS');
  });

  it('returns the text of every answer and parses only JSON', async () => {
    const { client } = academy((url) =>
      url.pathname === '/robots.txt'
        ? new Response('User-agent: *\nDisallow: /wp-admin/\n', {
            headers: { 'content-type': 'text/plain' },
          })
        : url.pathname === '/de/help/'
          ? new Response('{"nicht":"json"}', {
              headers: { 'content-type': 'text/html' },
            })
          : new Response('{kaputt', {
              headers: { 'content-type': 'application/json' },
            }),
    );
    const robots = await client.get({ path: '/robots.txt' });
    expect(robots.text).toContain('Disallow: /wp-admin/');
    expect(robots.body).toBeUndefined();
    expect((await client.get({ path: '/de/help/' })).body).toBeUndefined();
    const broken = await client.get({ path: '/de/wp-json/' });
    expect(broken.body).toBeUndefined();
    expect(broken.text).toBe('{kaputt');
  });
});
