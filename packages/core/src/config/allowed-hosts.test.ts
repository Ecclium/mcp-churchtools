import { describe, expect, it } from 'vitest';

import {
  isAllowedHost,
  isHttpBindAddress,
  loopbackBindAddresses,
  maxAllowedHostsLength,
  parseAllowedHost,
  parseAllowedHosts,
} from './allowed-hosts.js';

// The grammar of the allowed hosts and of the address of the server over
// HTTP (ADR 0073), which the loader and the way in of the server share.
// Every refusal stands next to a case that passes, so each test fails
// without the rule it covers.

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

describe('the address the server over HTTP binds to', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.0.0.1', '::1', '::', '2001:db8::1'])(
    'takes %s',
    (text) => {
      expect(isHttpBindAddress(text)).toBe(true);
    },
  );

  it.each([
    ['a name', 'localhost'],
    ['a DNS name', 'mcp.example.org'],
    ['IPv6 in brackets', '[::1]'],
    ['a port', '127.0.0.1:8765'],
    ['a short IPv4 address', '127.1'],
    ['a leading zero', '127.000.0.1'],
    ['IPv6 in long form', '0:0:0:0:0:0:0:1'],
    ['IPv6 in capitals', '2001:DB8::1'],
    ['IPv6 with a zone', 'fe80::1%en0'],
    ['nothing', ''],
    ['a space', ' 127.0.0.1'],
  ])('refuses %s', (_, text) => {
    expect(isHttpBindAddress(text)).toBe(false);
  });

  it('names exactly the addresses of loopback', () => {
    expect(loopbackBindAddresses).toEqual(['127.0.0.1', '::1']);
    expect(loopbackBindAddresses.every(isHttpBindAddress)).toBe(true);
  });

  it('refuses a value that is no text', () => {
    expect(isHttpBindAddress(1 as unknown as string)).toBe(false);
    expect(parseAllowedHost(1 as unknown as string)).toBeUndefined();
    expect(parseAllowedHosts(1 as unknown as string)).toEqual({
      ok: false,
      entry: 0,
    });
  });
});

describe('the longest list', () => {
  it('fits 16 names of 253 characters with a port each', () => {
    const name = `${'a'.repeat(61)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;
    expect(name).toHaveLength(253);
    const list = Array.from({ length: 16 }, () => `${name}:65535`).join(',');
    expect(list).toHaveLength(maxAllowedHostsLength);
    expect(parseAllowedHosts(list).ok).toBe(true);
  });
});
