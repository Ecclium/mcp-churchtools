import { describe, expect, it } from 'vitest';

import {
  type AllowedHost,
  authorityOf,
  hostAllowed,
  isAllowedHost,
  loopbackHosts,
  originAllowed,
  parseAllowedHost,
  parseAllowedHosts,
} from './hosts.js';

// The grammar of the entries and the comparison of the headers against
// DNS rebinding (ADR 0073). Every refusal stands next to a case that
// passes, so each test fails without the rule it covers.

const entry = (text: string): AllowedHost => {
  const host = parseAllowedHost(text);
  if (host === undefined) throw new Error('no entry');
  return host;
};

describe('an entry of the allowed hosts', () => {
  it.each([
    ['mcp.example.org', 'mcp.example.org', undefined],
    ['MCP.Example.ORG', 'mcp.example.org', undefined],
    ['mcp.example.org:8443', 'mcp.example.org', 8443],
    ['localhost', 'localhost', undefined],
    ['localhost:1', 'localhost', 1],
    ['127.0.0.1:65535', '127.0.0.1', 65_535],
    ['10.0.0.1', '10.0.0.1', undefined],
    ['[::1]', '[::1]', undefined],
    ['[::1]:8787', '[::1]', 8787],
    ['[2001:db8::1]', '[2001:db8::1]', undefined],
    ['[2001:DB8::1]', '[2001:db8::1]', undefined],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example', undefined],
    ['a-b.example', 'a-b.example', undefined],
    [`${'a'.repeat(63)}.example`, `${'a'.repeat(63)}.example`, undefined],
  ])('reads %s', (text, name, port) => {
    expect(parseAllowedHost(text)).toEqual({ name, port });
  });

  it.each([
    ['nothing', ''],
    ['a space', 'mcp example.org'],
    ['a trailing dot', 'mcp.example.org.'],
    ['an empty label', 'mcp..example.org'],
    ['a hyphen at the start of a label', '-mcp.example.org'],
    ['a hyphen at the end of a label', 'mcp-.example.org'],
    ['an underscore', 'mcp_1.example.org'],
    ['a letter outside ASCII', 'bücher.example'],
    ['a label of 64 letters', `${'a'.repeat(64)}.example`],
    ['a name over 253 letters', `${'a.'.repeat(126)}ab`],
    ['a short IPv4 address', '127.1'],
    ['an IPv4 address in hex', '0x7f.0.0.1'],
    ['an IPv4 address with a leading zero', '127.000.0.1'],
    ['an IPv4 address with five parts', '1.2.3.4.5'],
    ['an octet over 255', '256.1.1.1'],
    ['a name that ends in a number', 'example.123'],
    ['an IPv4 address as one hex number', '0x7f000001'],
    ['a name that ends in a hex number', '10.0.0.0x1'],
    ['a name that ends in 0x', 'a.0x'],
    ['a short hex number', '0xff'],
    ['a user before the host', 'x@127.0.0.1'],
    ['a scheme', 'https://mcp.example.org'],
    ['a path', 'mcp.example.org/mcp'],
    ['port 0', 'mcp.example.org:0'],
    ['a port over 65535', 'mcp.example.org:65536'],
    ['a port with a leading zero', 'mcp.example.org:080'],
    ['an empty port', 'mcp.example.org:'],
    ['a port without a name', ':8787'],
    ['an IPv6 address without brackets', '::1'],
    ['an open bracket', '[::1'],
    ['an IPv6 address in long form', '[0:0:0:0:0:0:0:1]'],
    ['text after the bracket', '[::1]x'],
    ['an IPv6 address with a zone', '[fe80::1%25en0]'],
  ])('refuses %s', (_, text) => {
    expect(parseAllowedHost(text)).toBeUndefined();
  });
});

describe('a list of allowed hosts', () => {
  it('reads entries separated by commas, without spaces and repeats', () => {
    const result = parseAllowedHosts(
      ' mcp.example.org , localhost:8787,MCP.example.org',
    );
    expect(result).toEqual({
      ok: true,
      hosts: [
        { name: 'mcp.example.org', port: undefined },
        { name: 'localhost', port: 8787 },
      ],
    });
  });

  it('keeps an entry with a port apart from one without', () => {
    const result = parseAllowedHosts('mcp.example.org,mcp.example.org:8443');
    expect(result.ok && result.hosts).toHaveLength(2);
  });

  it.each([
    ['an empty list', '', 0],
    ['a list of spaces', '   ', 0],
    ['an empty entry', 'mcp.example.org,,localhost', 2],
    ['a comma at the end', 'mcp.example.org,', 2],
    ['an entry that is no host', 'mcp.example.org, 127.1', 2],
  ])('refuses %s and names only the place', (_, text, place) => {
    const result = parseAllowedHosts(text);
    expect(result).toEqual({ ok: false, entry: place });
    expect(JSON.stringify(result)).not.toContain('127.1');
  });
});

describe('the hosts of loopback', () => {
  it('names localhost, 127.0.0.1 and [::1] with the port of the server', () => {
    expect(loopbackHosts(8787).map(authorityOf)).toEqual([
      'localhost:8787',
      '127.0.0.1:8787',
      '[::1]:8787',
    ]);
  });

  it.each([0, 65_536, 1.5, Number.NaN])('refuses the port %s', (port) => {
    expect(() => loopbackHosts(port)).toThrow(RangeError);
  });
});

describe('the form of an entry', () => {
  it.each([
    [{ name: 'mcp.example.org', port: undefined }, true],
    [{ name: '[::1]', port: 8787 }, true],
    [{ name: '127.1', port: undefined }, false],
    [{ name: 'mcp.example.org', port: 0 }, false],
    [{ name: 'mcp.example.org', port: '8443' }, false],
    [{ port: 8443 }, false],
    [null, false],
    ['mcp.example.org', false],
  ])('tells %j apart', (value, expected) => {
    expect(isAllowedHost(value)).toBe(expected);
  });
});

describe('the header Host', () => {
  const hosts = [entry('mcp.example.org'), entry('localhost:8787')];

  it.each([
    'mcp.example.org',
    'MCP.example.org',
    'localhost:8787',
    'LocalHost:8787',
  ])('passes %s', (header) => {
    expect(hostAllowed(header, hosts)).toBe(true);
  });

  it.each([
    ['without a header', null],
    ['empty', ''],
    ['a port on an entry without one', 'mcp.example.org:443'],
    ['another port on an entry without one', 'mcp.example.org:8443'],
    ['no port on an entry with one', 'localhost'],
    ['another port', 'localhost:8788'],
    ['two values', 'mcp.example.org, mcp.example.org'],
    ['a user before the host', 'x@mcp.example.org'],
    ['a trailing dot', 'mcp.example.org.'],
    ['a short IPv4 address', '127.1:8787'],
    ['a space inside', 'mcp.example .org'],
    ['a letter outside ASCII', 'mcp.example.org '],
    ['another name', 'evil.example.org'],
  ])('refuses %s', (_, header) => {
    expect(hostAllowed(header, hosts)).toBe(false);
  });

  it('refuses everything without an entry', () => {
    expect(hostAllowed('localhost:8787', [])).toBe(false);
  });
});

describe('the header Origin', () => {
  const hosts = [
    entry('mcp.example.org'),
    entry('mcp.example.org:8443'),
    ...loopbackHosts(8787),
  ];

  it.each([
    ['without a header', null],
    ['https on an entry without a port', 'https://mcp.example.org'],
    ['https on an entry with a port', 'https://mcp.example.org:8443'],
    ['http on loopback', 'http://localhost:8787'],
    ['https on loopback', 'https://127.0.0.1:8787'],
    ['http on loopback over IPv6', 'http://[::1]:8787'],
  ])('passes %s', (_, header) => {
    expect(originAllowed(header, hosts)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['the opaque origin', 'null'],
    ['http on a name that is not loopback', 'http://mcp.example.org'],
    ['the default port written out', 'https://mcp.example.org:443'],
    ['another port', 'https://mcp.example.org:9443'],
    ['another port on loopback', 'http://localhost:8788'],
    ['a trailing slash', 'https://mcp.example.org/'],
    ['a path', 'https://mcp.example.org/mcp'],
    ['upper case', 'https://MCP.example.org'],
    ['a user', 'https://x@mcp.example.org'],
    ['two values', 'https://mcp.example.org, https://mcp.example.org'],
    ['another scheme', 'wss://mcp.example.org'],
    ['another name', 'https://evil.example.org'],
  ])('refuses %s', (_, header) => {
    expect(originAllowed(header, hosts)).toBe(false);
  });
});
