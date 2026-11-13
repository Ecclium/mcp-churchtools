import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  aclCompleteLine,
  aclHeader,
  aclLinePatterns,
  type EgressTarget,
  egressTargetsOf,
  renderEgressAcl,
} from './acl.js';

// The list of targets of the proxy (ADR 0035), from the parts of a
// configuration the command reads. All names are made up.

const provider = (alias: string, endpoint: string) => ({
  alias,
  endpoint,
  info: {} as never,
  structuredOutput: true,
  apiKeyFile: '/path/to/key',
});

// The suffix of the names of a pair, as the list makes it.
const suffix = (host: string, port: string): string =>
  createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0, 16);

const base = {
  churchtoolsOrigin: 'https://example.church.tools',
  providers: undefined,
  runnerPingOrigin: undefined,
  egressAllowLan: [] as readonly string[],
};

describe('egressTargetsOf', () => {
  it('names ChurchTools, each provider and the ping, each origin once with its roles', () => {
    const found = egressTargetsOf({
      ...base,
      providers: [
        provider('default', 'https://model.example.org/v1/chat/completions'),
        provider('zweit', 'https://model.example.org/v2/chat'),
        provider('lokal', 'https://llm.example.org:8443/v1/chat/completions'),
      ],
      runnerPingOrigin: 'https://ping.example.org',
      egressAllowLan: ['https://llm.example.org:8443'],
    });
    expect(found).toEqual({
      ok: true,
      targets: [
        {
          host: 'example.church.tools',
          port: '443',
          lan: false,
          roles: ['ChurchTools'],
        },
        {
          host: 'model.example.org',
          port: '443',
          lan: false,
          roles: ['Anbieter ‹default›', 'Anbieter ‹zweit›'],
        },
        {
          host: 'llm.example.org',
          port: '8443',
          lan: true,
          roles: ['Anbieter ‹lokal›'],
        },
        {
          host: 'ping.example.org',
          port: '443',
          lan: false,
          roles: ['Ping des Runners'],
        },
      ],
    });
  });

  it('takes ChurchTools in the local network on a port of its own', () => {
    const found = egressTargetsOf({
      ...base,
      churchtoolsOrigin: 'https://example.church.tools:8443',
      egressAllowLan: ['https://example.church.tools:8443'],
    });
    expect(found.ok && found.targets).toEqual([
      {
        host: 'example.church.tools',
        port: '8443',
        lan: true,
        roles: ['ChurchTools'],
      },
    ]);
  });

  it('refuses every target on a port other than 443 outside the local network, by its roles', () => {
    expect(
      egressTargetsOf({
        ...base,
        churchtoolsOrigin: 'https://example.church.tools:8443',
        providers: [
          provider('default', 'https://model.example.org:9443/v1/chat'),
        ],
        runnerPingOrigin: 'https://ping.example.org:8443',
      }),
    ).toEqual({
      ok: false,
      roles: ['ChurchTools', 'Anbieter ‹default›', 'Ping des Runners'],
    });
  });

  it.each([
    'http://example.church.tools',
    'https://192.0.2.5',
    'https://Example.church.tools',
    'https://example.church.tools:0',
    'https://example.church.tools:70000',
    'https://example.church.tools:443:1',
    'https://example',
  ])('throws for an origin it could not have checked: %s', (origin) => {
    expect(() =>
      egressTargetsOf({ ...base, churchtoolsOrigin: origin }),
    ).toThrow(TypeError);
  });
});

describe('renderEgressAcl', () => {
  it('writes per target a name, a port and the pair in its list, after a comment', () => {
    const one = suffix('example.church.tools', '443');
    const two = suffix('llm.example.org', '8443');
    expect(
      renderEgressAcl([
        {
          host: 'example.church.tools',
          port: '443',
          lan: false,
          roles: ['ChurchTools'],
        },
        {
          host: 'llm.example.org',
          port: '8443',
          lan: true,
          roles: ['Anbieter ‹lokal›'],
        },
      ]),
    ).toEqual([
      aclHeader,
      '# ChurchTools',
      `acl ecclium_host_${one} dstdomain -n example.church.tools`,
      `acl ecclium_port_${one} port 443`,
      `acl ecclium_public all-of ecclium_host_${one} ecclium_port_${one}`,
      '# Anbieter ‹lokal›, lokales Netz',
      `acl ecclium_host_${two} dstdomain -n llm.example.org`,
      `acl ecclium_port_${two} port 8443`,
      `acl ecclium_lan all-of ecclium_host_${two} ecclium_port_${two}`,
      aclCompleteLine,
    ]);
    // The names come from name and port, not from the place in the list.
    expect(one).toBe('5f0b4e0595983329');
  });

  it('ends an empty list with the mark of a complete list', () => {
    expect(renderEgressAcl([])).toEqual([aclHeader, aclCompleteLine]);
  });

  // A list cut short or a pair split across two lists must not fit.
  it.each([
    'acl ecclium_lan all-of ecclium_host_0123456789abcdef ecclium_port_fedcba9876543210',
    'acl ecclium_lan all-of ecclium_host_0123456789abcdef',
    'acl ecclium_host_1 dstdomain -n example.org',
    'acl ecclium_host_0123456789abcdef dstdomain -n example.org .example.org',
    'acl ecclium_host_0123456789abcdef dstdomain example.org',
    'acl ecclium_port_0123456789abcdef port 1-65535',
    'acl ecclium_never all-of ecclium_host_0123456789abcdef ecclium_port_0123456789abcdef',
    'acl ecclium_complete all-of ecclium_none_one',
    'http_access allow all',
    'include /etc/squid/other.conf',
    '#no space',
    '',
  ])('refuses the line %j', (line) => {
    expect(aclLinePatterns.some((pattern) => pattern.test(line))).toBe(false);
  });

  it.each<[string, EgressTarget]>([
    [
      'a public target on another port',
      { host: 'example.org', port: '8443', lan: false, roles: ['x'] },
    ],
    [
      'a name without a dot',
      { host: 'egress', port: '443', lan: false, roles: ['x'] },
    ],
    [
      'an IPv4 address',
      { host: '192.0.2.5', port: '443', lan: true, roles: ['x'] },
    ],
    [
      'a name with a space',
      { host: 'a.org all', port: '443', lan: false, roles: ['x'] },
    ],
    [
      'a port of 0',
      { host: 'example.org', port: '0', lan: true, roles: ['x'] },
    ],
    [
      'a port above 65535',
      { host: 'example.org', port: '65536', lan: true, roles: ['x'] },
    ],
    [
      'a role with a line break',
      {
        host: 'example.org',
        port: '443',
        lan: false,
        roles: ['x\nhttp_access allow all'],
      },
    ],
  ])('throws and gives no line for %s', (_, target) => {
    expect(() => renderEgressAcl([target])).toThrow(TypeError);
  });

  // Whatever the targets, the list either throws or holds only lines of
  // the allowed forms, ends with the mark, and pairs a name and a port of
  // the same target that stand above the pair (ADR 0035).
  it('throws or gives only lines of the allowed forms for any targets', () => {
    const label = fc.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,8}[a-z0-9])?$/);
    const last = fc.stringMatching(/^[a-z](?:[a-z0-9-]{0,8}[a-z0-9])?$/);
    const goodHost = fc
      .tuple(fc.array(label, { minLength: 1, maxLength: 3 }), last)
      .map(([labels, end]) => [...labels, end].join('.'));
    const target = fc.record({
      host: fc.oneof(goodHost, fc.string({ maxLength: 20 })),
      port: fc.oneof(
        fc.constant('443'),
        fc.integer({ min: 0, max: 70000 }).map(String),
        fc.string({ maxLength: 6 }),
      ),
      lan: fc.boolean(),
      roles: fc.array(fc.oneof(fc.constant('ChurchTools'), fc.string()), {
        minLength: 1,
        maxLength: 3,
      }),
    });
    let rendered = 0;
    fc.assert(
      fc.property(fc.array(target, { maxLength: 8 }), (targets) => {
        let lines: readonly string[];
        try {
          lines = renderEgressAcl(targets);
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          return;
        }
        if (targets.length > 0) rendered += 1;
        expect(lines[0]).toBe(aclHeader);
        expect(lines.at(-1)).toBe(aclCompleteLine);
        expect(lines).toHaveLength(2 + 4 * targets.length);
        const defined = new Map<string, string>();
        for (const line of lines) {
          expect(aclLinePatterns.some((pattern) => pattern.test(line))).toBe(
            true,
          );
          expect(line).not.toMatch(/http_access|[\n\r\u2028\u2029]/);
          const named =
            /^acl (ecclium_(?:host|port)_[0-9a-f]{16}) \S+ (?:-n )?(\S+)$/.exec(
              line,
            );
          if (named !== null) defined.set(named[1] ?? '', named[2] ?? '');
          const pair = /all-of (ecclium_host_\S+) (ecclium_port_\S+)$/.exec(
            line,
          );
          if (pair !== null) {
            const host = defined.get(pair[1] ?? '');
            const port = defined.get(pair[2] ?? '');
            expect(host).toBeDefined();
            expect(port).toBeDefined();
            expect(pair[1]?.slice('ecclium_host_'.length)).toBe(
              suffix(host ?? '', port ?? ''),
            );
          }
        }
      }),
      { numRuns: 500 },
    );
    // Not only lists that throw or hold no target.
    expect(rendered).toBeGreaterThan(10);
  });
});
