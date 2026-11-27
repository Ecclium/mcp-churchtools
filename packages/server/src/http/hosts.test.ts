import { describe, expect, it } from 'vitest';

import {
  type AllowedHost,
  authorityOf,
  hostAllowed,
  loopbackHosts,
  originAllowed,
  parseAllowedHost,
} from './hosts.js';

// The comparison of the headers against DNS rebinding (ADR 0073); the
// grammar of the entries has its tests in the configuration of core. Every
// refusal stands next to a case that passes, so each test fails without
// the rule it covers.

const entry = (text: string): AllowedHost => {
  const host = parseAllowedHost(text);
  if (host === undefined) throw new Error('no entry');
  return host;
};

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
