import { describe, expect, it } from 'vitest';

import { SpikeError } from '../../scripts/spike/lib/errors.mts';
import { Guard } from '../../scripts/spike/lib/guard.mts';
import {
  classifyNetworkError,
  createClient,
  pathFor,
  userAgent,
  type FetchFunction,
} from '../../scripts/spike/lib/http.mts';
import { makeCanaries, origin } from './support.mts';

interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}

function recordingFetch(response: () => Response): {
  fetch: FetchFunction;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response());
    },
  };
}

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
};

const codeOf = async (action: () => Promise<unknown>): Promise<string> => {
  try {
    await action();
  } catch (error) {
    return error instanceof SpikeError ? error.code : 'no SpikeError';
  }
  return 'no error';
};

describe('pathFor', () => {
  it('fills templates with numbers and ID-like text only', () => {
    expect(pathFor('/api/wiki/categories/{}/pages/{}', 7, 'a1-B_2.c~')).toBe(
      '/api/wiki/categories/7/pages/a1-B_2.c~',
    );
    for (const bad of [
      '',
      '..',
      '.hidden',
      'a/b',
      'a?b',
      'a#b',
      'a%2Fb',
      'ä',
    ]) {
      expect(() => pathFor('/x/{}', bad)).toThrow(SpikeError);
    }
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => pathFor('/x/{}', bad)).toThrow(SpikeError);
    }
    expect(() => pathFor('/x/{}/{}', 1)).toThrow(SpikeError);
  });
});

describe('createClient', () => {
  it('sends the token only in the Login header, to the one origin', async () => {
    const { token } = makeCanaries();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const client = createClient({ origin, token, guard: new Guard(), fetch });
    await client.get({
      path: pathFor('/api/wiki/pages'),
      query: [
        ['wiki_category_ids[]', '7'],
        ['page', '1'],
      ],
    });
    await client.get({ path: '/api/whoami', auth: 'ohne' });
    await client.get({ path: '/api/whoami', auth: { invalidToken: 'wrong' } });

    const [first, second, third] = calls;
    const headers = new Headers(first?.init.headers);
    expect(first?.url.href).toBe(
      `${origin}/api/wiki/pages?wiki_category_ids%5B%5D=7&page=1`,
    );
    expect(headers.get('authorization')).toBe(`Login ${token}`);
    expect(headers.get('user-agent')).toBe(userAgent);
    expect(first?.init.redirect).toBe('manual');
    expect(first?.init.method).toBe('GET');
    expect(first?.url.href).not.toContain(token);
    expect(new Headers(second?.init.headers).has('authorization')).toBe(false);
    expect(new Headers(third?.init.headers).get('authorization')).toBe(
      'Login wrong',
    );
  });

  it('refuses a path that would leave the origin, before any request', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const client = createClient({
      origin,
      token: 't',
      guard: new Guard(),
      fetch,
    });
    expect(await codeOf(() => client.get({ path: '//example.org/x' }))).toBe(
      'INTERN',
    );
    expect(await codeOf(() => client.get({ path: 'api/whoami' }))).toBe(
      'INTERN',
    );
    expect(calls).toHaveLength(0);
  });

  it('does not follow a redirect', async () => {
    const { fetch } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: '/x' } }),
    );
    const client = createClient({
      origin,
      token: 't',
      guard: new Guard(),
      fetch,
    });
    expect(await codeOf(() => client.get({ path: '/api/whoami' }))).toBe(
      'HTTP_REDIRECT',
    );
  });

  it('stops reading a response that is too large', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ text: 'x'.repeat(2000) }),
    );
    const client = createClient({
      origin,
      token: 't',
      guard: new Guard(),
      fetch,
      maxBytes: 1000,
    });
    expect(await codeOf(() => client.get({ path: '/api/whoami' }))).toBe(
      'ANTWORT_ZU_GROSS',
    );
  });

  it('turns network errors into fixed codes, without their messages', async () => {
    const failing =
      (error: Error): FetchFunction =>
      () =>
        Promise.reject(error);
    const cases: readonly (readonly [Error, string])[] = [
      [
        new TypeError('fetch failed', {
          cause: { code: 'ENOTFOUND', hostname: origin },
        }),
        'NETZ_DNS',
      ],
      [
        new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }),
        'TLS',
      ],
      [
        new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
        'NETZ_VERBINDUNG',
      ],
      [new DOMException('The operation timed out.', 'TimeoutError'), 'TIMEOUT'],
      [new Error(`surprise ${origin}`), 'NETZ'],
    ];
    for (const [error, code] of cases) {
      const client = createClient({
        origin,
        token: 't',
        guard: new Guard(),
        fetch: failing(error),
      });
      const thrown = await client
        .get({ path: '/api/whoami' })
        .catch((caught: unknown) => caught);
      expect(thrown).toBeInstanceOf(SpikeError);
      expect((thrown as SpikeError).code).toBe(code);
      expect((thrown as SpikeError).message).toBe(code);
    }
    expect(classifyNetworkError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe(
      'TLS',
    );
  });

  it('puts every header value, cookie and response value on the block list', async () => {
    const canaries = makeCanaries();
    const { fetch } = recordingFetch(() => {
      const headers = new Headers({
        'content-type': 'application/json',
        'x-custom': canaries.headerValue,
      });
      headers.append(
        'set-cookie',
        `${canaries.cookieName}=${canaries.cookieValue}; Path=/; HttpOnly`,
      );
      return new Response(
        JSON.stringify({
          data: { firstName: canaries.personName, id: canaries.number },
        }),
        { status: 200, headers },
      );
    });
    const guard = new Guard();
    const client = createClient({ origin, token: 't', guard, fetch });
    const response = await client.get({ path: '/api/whoami' });
    expect(response.kind).toBe('JSON');
    expect(response.setCookies).toHaveLength(1);
    for (const value of [
      canaries.headerValue,
      canaries.cookieName,
      canaries.cookieValue,
      canaries.personName,
      String(canaries.number),
    ]) {
      guard.allowChecked(value);
      expect(guard.check({ [value]: null })).toEqual(['/#0']);
    }
  });

  it('can leave the values of the public specification off the block list', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ required: ['firstName'] }),
    );
    const guard = new Guard();
    const client = createClient({ origin, token: 't', guard, fetch });
    await client.get({
      path: '/system/runtime/swagger/openapi.json',
      blockValues: false,
    });
    guard.allowChecked('firstName');
    expect(guard.check({ firstName: null })).toEqual([]);
  });

  it('tells empty, JSON and other bodies apart', async () => {
    const bodies: readonly (readonly [Response, string])[] = [
      [new Response(null, { status: 204 }), 'leer'],
      [
        new Response('<html></html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
        'anderes Format',
      ],
      [
        new Response('{broken', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
        'anderes Format',
      ],
    ];
    for (const [response, kind] of bodies) {
      const client = createClient({
        origin,
        token: 't',
        guard: new Guard(),
        fetch: () => Promise.resolve(response),
      });
      expect((await client.get({ path: '/api/whoami' })).kind).toBe(kind);
    }
  });
});
