import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
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
      'acl ecclium_host_1 dstdomain -n example.church.tools',
      'acl ecclium_port_1 port 443',
      'acl ecclium_public all-of ecclium_host_1 ecclium_port_1',
      '# Anbieter ‹lokal›, lokales Netz',
      'acl ecclium_host_2 dstdomain -n llm.example.org',
      'acl ecclium_port_2 port 8443',
      'acl ecclium_lan all-of ecclium_host_2 ecclium_port_2',
    ]);
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

  // Whatever the targets, the list holds only lines of the allowed forms,
  // never a rule http_access, and each pair names a host and a port that
  // stand above it (ADR 0035).
  it('gives only lines of the allowed forms for any targets', () => {
    const label = fc.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,8}[a-z0-9])?$/);
    // The last label is no number, as in every name the configuration takes.
    const last = fc.stringMatching(/^[a-z](?:[a-z0-9-]{0,8}[a-z0-9])?$/);
    const host = fc
      .tuple(fc.array(label, { minLength: 1, maxLength: 3 }), last)
      .map(([labels, end]) => [...labels, end].join('.'));
    const target = fc.oneof(
      fc.record({
        host,
        port: fc.constant('443'),
        lan: fc.constant(false),
        roles: fc.array(fc.constantFrom('ChurchTools', 'Anbieter ‹a-1›'), {
          minLength: 1,
          maxLength: 3,
        }),
      }),
      fc.record({
        host,
        port: fc.integer({ min: 1, max: 65535 }).map(String),
        lan: fc.constant(true),
        roles: fc.constant(['Ping des Runners']),
      }),
    );
    fc.assert(
      fc.property(fc.array(target, { maxLength: 12 }), (targets) => {
        const lines = renderEgressAcl(targets);
        expect(lines[0]).toBe(aclHeader);
        expect(lines).toHaveLength(1 + 4 * targets.length);
        const defined = new Set<string>();
        for (const line of lines) {
          expect(aclLinePatterns.some((pattern) => pattern.test(line))).toBe(
            true,
          );
          expect(line).not.toMatch(/http_access|\n|\r/);
          const [, name] = /^acl (ecclium_(?:host|port)_\d+) /.exec(line) ?? [];
          if (name !== undefined) defined.add(name);
          const pair = /all-of (ecclium_host_\d+) (ecclium_port_\d+)$/.exec(
            line,
          );
          if (pair !== null) {
            expect(defined.has(pair[1] ?? '')).toBe(true);
            expect(defined.has(pair[2] ?? '')).toBe(true);
          }
        }
      }),
    );
  });
});
