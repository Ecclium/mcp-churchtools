import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { Secret } from './secret.js';
import { checkRequestTarget, type TargetCode, targetCodes } from './target.js';

// Hosts lie under .example (RFC 2606), and the one host under church.tools
// is the placeholder of the project, so the secret scan lets the file pass.
// Each refused case is caught by its own rule: without that rule, the case
// passes or gets the code of a later rule.

const origin = 'https://demo.example';
const canary = makeCanary('token');
const token = new Secret(canary.value);

const check = (target: string | URL, from = origin, secret = token) =>
  checkRequestTarget(
    typeof target === 'string' ? new URL(target) : target,
    from,
    secret,
  );

describe('checkRequestTarget', () => {
  it.each([
    ['https://demo.example/api/whoami', '/api/whoami'],
    ['https://demo.example/', '/'],
    [
      'https://demo.example/api/persons?page=1&limit=50&ids[]=1&ids[]=2',
      '/api/persons?page=1&limit=50&ids[]=1&ids[]=2',
    ],
    [
      'https://demo.example/api/whoami?only_allow_authenticated=true',
      '/api/whoami?only_allow_authenticated=true',
    ],
    ['https://demo.example:443/api', '/api'],
    ['https://DEMO.Example/api', '/api'],
    ['https://demo.example\\api', '/api'],
    ['https://demo.example/a%2F..%2Fb', '/a%2F..%2Fb'],
  ])('accept %s', (target, path) => {
    const result = check(target);
    expect(result).toEqual({ ok: true, path });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accept the placeholder instance and an origin with a port', () => {
    expect(
      check(
        'https://example.church.tools/api/whoami',
        'https://example.church.tools',
      ),
    ).toEqual({ ok: true, path: '/api/whoami' });
    expect(
      check('https://demo.example:8443/api', 'https://demo.example:8443'),
    ).toEqual({ ok: true, path: '/api' });
  });

  // The parser turns an international name into Punycode, the form the
  // configuration accepts, so both name the same origin.
  it('accept an international name for its Punycode origin', () => {
    expect(
      check('https://b\u00fccher.example/api', 'https://xn--bcher-kva.example'),
    ).toEqual({ ok: true, path: '/api' });
  });

  const withToken = (place: 'path' | 'encoded' | 'value' | 'query'): URL => {
    const url = new URL('https://demo.example/api');
    switch (place) {
      case 'path':
        url.pathname = `/api/${canary.value}`;
        break;
      case 'encoded':
        url.pathname = `/api/${encodeURIComponent(canary.value)}`;
        break;
      case 'value':
        url.searchParams.set('query', canary.value);
        break;
      case 'query':
        url.search = `?query=${encodeURIComponent(canary.value)}`;
        break;
    }
    return url;
  };

  const refused: [TargetCode, string | URL][] = [
    ['target_not_https', 'http://demo.example/api'],
    ['target_not_https', 'wss://demo.example/api'],
    ['target_not_https', 'file:///api'],
    ['target_credentials', 'https://user@demo.example/api'],
    ['target_credentials', 'https://:pw@demo.example/api'],
    ['target_credentials', 'https://other.example%2F@demo.example/api'],
    ['target_origin', 'https://other.example/api'],
    ['target_origin', 'https://sub.demo.example/api'],
    ['target_origin', 'https://demo.example./api'],
    ['target_origin', 'https://demo.example:8443/api'],
    ['target_origin', 'https://0xC0.0.2.1/api'],
    ['target_origin', 'https://[::1]/api'],
    ['target_origin', 'https://b\u00fccher.example/api'],
    ['target_origin', 'https://demo\uff0eexample.example/api'],
    ['target_fragment', 'https://demo.example/api#'],
    ['target_fragment', 'https://demo.example/api#part'],
    ['target_path', 'https://demo.example//other.example/api'],
    ['target_parameter_name', 'https://demo.example/api?login.token=1'],
    ['target_parameter_name', 'https://demo.example/api?login+token=1'],
    ['target_parameter_name', 'https://demo.example/api?login[token=1'],
    ['target_parameter_name', 'https://demo.example/api?ids[0]=1'],
    ['target_parameter_name', 'https://demo.example/api?=1'],
    ['target_parameter_name', 'https://demo.example/api?[]=1'],
    ['target_parameter_name', 'https://demo.example/api?a-b=1'],
    ['target_parameter_name', 'https://demo.example/api?%00=1'],
    ['target_forbidden_parameter', 'https://demo.example/api?login_token=1'],
    ['target_forbidden_parameter', 'https://demo.example/api?LOGIN_TOKEN=1'],
    ['target_forbidden_parameter', 'https://demo.example/api?login%5Ftoken=1'],
    ['target_forbidden_parameter', 'https://demo.example/api?with_session=1'],
    ['target_forbidden_parameter', 'https://demo.example/api?with_session[]=1'],
    ['target_token', withToken('path')],
    ['target_token', withToken('encoded')],
    ['target_token', withToken('value')],
    ['target_token', withToken('query')],
  ];

  it.each(refused)('refuse with %s: %s', (code, target) => {
    const result = check(target);
    expect(result).toEqual({ ok: false, code });
    expect(Object.keys(result)).toEqual(['ok', 'code']);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('have a case for every code', () => {
    expect(new Set(refused.map(([code]) => code))).toEqual(
      new Set(targetCodes),
    );
  });

  // Each form of the token passes once the transport sends another token,
  // so the cases above are caught by the token, not by their shape.
  it('accept the same targets for another token', () => {
    const other = new Secret(makeCanary('token').value);
    for (const place of ['path', 'encoded', 'value', 'query'] as const) {
      expect(check(withToken(place), origin, other).ok, place).toBe(true);
    }
  });

  it('find a plain token in the path and the query', () => {
    const core = canary.cores[0] ?? '';
    const plain = new Secret(core);
    expect(check(`https://demo.example/api/${core}`, origin, plain)).toEqual({
      ok: false,
      code: 'target_token',
    });
    expect(
      check(`https://demo.example/api?query=${core}`, origin, plain),
    ).toEqual({ ok: false, code: 'target_token' });
  });

  // The parser keeps escapes in a path as they come, in either case.
  it('decode escapes in upper and lower case in the path', () => {
    const [first = '', second = ''] = canary.cores;
    const braced = new Secret(`${first}{}${second}`);
    for (const escaped of ['%7B%7D', '%7b%7d', '%7B%7d']) {
      expect(
        check(
          `https://demo.example/api/${first}${escaped}${second}`,
          origin,
          braced,
        ),
        escaped,
      ).toEqual({ ok: false, code: 'target_token' });
    }
    // An escape of a space or a lone % stays as it is.
    for (const escaped of ['%20%7d', '%7%7d', '%G7%7d']) {
      expect(
        check(
          `https://demo.example/api/${first}${escaped}${second}`,
          origin,
          braced,
        ).ok,
        escaped,
      ).toBe(true);
    }
  });

  it('leave the target and the token out of the statics of regular expressions', () => {
    expect(/primed/.exec('primed')).not.toBeNull();
    for (const place of ['path', 'encoded', 'value', 'query'] as const) {
      expect(check(withToken(place)).ok).toBe(false);
    }
    expect(check('https://demo.example/api?login_token=1').ok).toBe(false);
    const statics = RegExp as unknown as Record<string, unknown>;
    for (const name of ['$_', 'input', 'lastMatch', 'leftContext']) {
      const text = String(statics[name]);
      for (const core of canary.cores) expect(text, name).not.toContain(core);
      expect(text, name).not.toContain('login_token');
    }
  });

  it('read the target only through the built-in serialiser', () => {
    const fake = { href: 'https://demo.example/api' } as unknown as URL;
    expect(() => check(fake)).toThrow(TypeError);
    expect(() => check(fake)).toThrow('A request target must be a URL.');
    const proxy = new Proxy(new URL('https://demo.example/api'), {});
    expect(() => check(proxy)).toThrow('A request target must be a URL.');
  });

  // A real URL can carry its own properties over the getters of its class.
  // The check reads a fresh copy, so they change nothing.
  it('ignore own properties of the target that shadow its getters', () => {
    const url = new URL('https://other.example/api?login_token=1');
    for (const [key, value] of [
      ['href', 'https://demo.example/api'],
      ['origin', origin],
      ['search', ''],
      ['searchParams', new URLSearchParams()],
    ] as const) {
      Object.defineProperty(url, key, { value });
    }
    expect(check(url)).toEqual({ ok: false, code: 'target_origin' });
  });
});

describe('targetCodes', () => {
  it('is frozen and has each code once', () => {
    expect(Object.isFrozen(targetCodes)).toBe(true);
    expect(new Set(targetCodes).size).toBe(targetCodes.length);
  });
});
