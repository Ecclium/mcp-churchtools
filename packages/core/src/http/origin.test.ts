import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { isEventName } from '../logger/index.js';
import * as http from './index.js';
import {
  type OriginCode,
  originCodes,
  parseChurchToolsOrigin,
} from './origin.js';

// Every host here lies under .example (RFC 2606) or is the placeholder of
// the project, so the secret scan of this repository lets the file pass.
// Each case of a rule is caught by that rule alone: without it, the case
// passes or gets the code of a later rule, so a test of the code notices a
// missing rule.

// A host of 253 characters, the longest DNS allows, in labels of at most 63.
const longestHost = [
  'a'.repeat(63),
  'b'.repeat(63),
  'c'.repeat(63),
  'd'.repeat(53),
  'example',
].join('.');
const longestAddress = `https://${longestHost}:65535/`;

describe('parseChurchToolsOrigin', () => {
  it.each([
    ['https://example.church.tools', 'https://example.church.tools'],
    ['https://example.church.tools/', 'https://example.church.tools'],
    ['https://demo-tenant.example', 'https://demo-tenant.example'],
    ['https://demo.example:8443', 'https://demo.example:8443'],
    ['https://demo.example:8443/', 'https://demo.example:8443'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
    ['https://localhost.example', 'https://localhost.example'],
    ['https://10.example', 'https://10.example'],
    [longestAddress, longestAddress.slice(0, -1)],
  ])('accept %s', (input, origin) => {
    const result = parseChurchToolsOrigin(input);
    expect(result).toEqual({ ok: true, origin });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });

  const refused: [OriginCode, string][] = [
    ['url_too_long', `${longestAddress}/`],
    ['url_too_long', `https://${'a'.repeat(100_000)}.example`],
    ['url_invalid', ''],
    ['url_invalid', 'demo.example'],
    ['url_invalid', 'https://'],
    ['url_invalid', 'https://demo.example:65536'],
    ['url_invalid', 'https://de mo.example'],
    ['url_invalid', 'https://demo.123'],
    ['url_not_https', 'http://demo.example'],
    ['url_not_https', 'wss://demo.example'],
    ['url_not_https', 'file:///etc/hosts'],
    ['url_credentials', 'https://user@demo.example'],
    ['url_credentials', 'https://user:pw@demo.example'],
    ['url_credentials', 'https://:pw@demo.example'],
    ['url_path', 'https://demo.example/api'],
    ['url_path', 'https://demo.example//'],
    ['url_path', 'https://demo.example?a=1'],
    ['url_path', 'https://demo.example/#top'],
    ['url_path', 'https://demo.example/?'],
    ['url_path', 'https://demo.example/#'],
    ['url_ip_address', 'https://192.0.2.1'],
    ['url_ip_address', 'https://3221225985'],
    ['url_ip_address', 'https://0xC0.0.2.1'],
    ['url_ip_address', 'https://192.0.2'],
    ['url_ip_address', 'https://[2001:db8::1]'],
    ['url_ip_address', 'https://[::ffff:192.0.2.1]'],
    ['url_trailing_dot', 'https://demo.example.'],
    ['url_trailing_dot', 'https://demo.example./'],
    ['url_localhost', 'https://localhost'],
    ['url_localhost', 'https://LOCALHOST'],
    ['url_localhost', 'https://localhost:8443'],
    ['url_localhost', 'https://demo.localhost'],
    ['url_single_label', 'https://intranet'],
    ['url_single_label', 'https://churchtools:8443'],
    ['url_host', 'https://my_host.example'],
    ['url_host', 'https://-demo.example'],
    ['url_host', 'https://demo-.example'],
    ['url_host', 'https://demo..example'],
    ['url_host', 'https://*.example'],
    ['url_host', `https://${'a'.repeat(64)}.example`],
    ['url_host', `https://e${longestHost}`],
    ['url_port', 'https://demo.example:0'],
    ['url_port', 'https://demo.example:0/'],
    ['url_not_canonical', 'https://DEMO.example'],
    ['url_not_canonical', 'HTTPS://demo.example'],
    ['url_not_canonical', 'https://demo.example:443'],
    ['url_not_canonical', 'https://demo.example:'],
    ['url_not_canonical', 'https://demo.example:08443'],
    ['url_not_canonical', 'https://dem%6F.example'],
    ['url_not_canonical', 'https://demo%2Eexample'],
    ['url_not_canonical', ' https://demo.example'],
    ['url_not_canonical', 'https://demo.example '],
    ['url_not_canonical', 'https://de\tmo.example'],
    ['url_not_canonical', 'https://\uff44emo.example'],
    ['url_not_canonical', 'https://b\u00fccher.example'],
    ['url_not_canonical', 'https:demo.example'],
    ['url_not_canonical', 'https:/demo.example'],
    ['url_not_canonical', 'https:///demo.example'],
    ['url_not_canonical', 'https:\\\\demo.example'],
    ['url_not_canonical', 'https://@demo.example'],
  ];

  it.each(refused)('refuse with %s: %j', (code, input) => {
    const result = parseChurchToolsOrigin(input);
    expect(result).toEqual({ ok: false, code });
    expect(Object.keys(result)).toEqual(['ok', 'code']);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });

  // A login token copied with an address from the browser sits in the
  // query, so the search for ? and # must leave nothing in the statics of
  // regular expressions.
  it('leave an address with a query out of the statics of regular expressions', () => {
    const token = makeCanary('token').cores[0] ?? '';
    expect(/primed/.exec('primed')).not.toBeNull();
    expect(
      parseChurchToolsOrigin(`https://demo.example/?login_token=${token}`),
    ).toEqual({ ok: false, code: 'url_path' });
    const statics = RegExp as unknown as Record<string, unknown>;
    for (const name of [
      '$_',
      'input',
      'lastMatch',
      'leftContext',
      'rightContext',
    ]) {
      expect(String(statics[name]), name).not.toContain(token);
    }
  });

  it('have a case for every code', () => {
    expect(new Set(refused.map(([code]) => code))).toEqual(
      new Set(originCodes),
    );
  });

  it('throw a TypeError without the value for anything but a string', () => {
    const value = 'https://demo.example';
    const call = () =>
      parseChurchToolsOrigin(new String(value) as unknown as string);
    expect(call).toThrow(TypeError);
    expect(call).toThrow('An address must be a string.');
  });
});

describe('originCodes', () => {
  it('is frozen and has each code once', () => {
    expect(Object.isFrozen(originCodes)).toBe(true);
    expect(new Set(originCodes).size).toBe(originCodes.length);
  });

  // The configuration reports a code as the log event config_<code>.
  it('fit the name of a log event behind a prefix', () => {
    for (const code of originCodes) {
      expect(isEventName(`config_${code}`), code).toBe(true);
    }
  });
});

describe('the entry of http', () => {
  it('passes on the check of the address', () => {
    expect(http.parseChurchToolsOrigin).toBe(parseChurchToolsOrigin);
    expect(http.originCodes).toBe(originCodes);
  });
});
