import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  aclLinePatterns,
  renderEgressAcl,
} from '../packages/cli/src/egress/acl.ts';

// The template of Squid for the boundary in the network of the runner
// (ADR 0035). These checks hold the order of its rules and what it must
// never contain; how Squid behaves with it shows only a run of the pinned
// image, which the operations guide describes.

const text = readFileSync(
  new URL('../deploy/selfhost/egress/squid.conf', import.meta.url),
  'utf8',
);
const lines = text.split('\n');
const directives = lines.filter(
  (line) => line.trim() !== '' && !line.startsWith('#'),
);

describe('the template of Squid', () => {
  it('names the image it was checked with by tag and digest of the index', () => {
    const image = lines.filter((line) => line.startsWith('# Image: '));
    expect(image).toHaveLength(1);
    expect(image[0]).toMatch(
      /^# Image: ubuntu\/squid:[0-9][0-9.]*-[0-9]{2}\.[0-9]{2}_[a-z]+@sha256:[0-9a-f]{64}$/,
    );
  });

  it('holds every rule http_access in this order, the last one refusing all', () => {
    expect(directives.filter((line) => line.startsWith('http_access'))).toEqual(
      [
        'http_access deny !ecclium_connect',
        'http_access deny !ecclium_complete',
        'http_access allow ecclium_lan !ecclium_never',
        'http_access deny !ecclium_public',
        'http_access deny !ecclium_tls_port',
        'http_access deny ecclium_never',
        'http_access deny ecclium_special',
        'http_access allow ecclium_public',
        'http_access deny all',
      ],
    );
  });

  it('includes the list of targets only after the last rule, as its last directive', () => {
    expect(directives.at(-1)).toBe('include /etc/squid/ecclium-targets.conf');
    expect(
      directives.filter((line) => line.startsWith('include')),
    ).toHaveLength(1);
    expect(directives.indexOf('http_access deny all')).toBe(
      directives.length - 2,
    );
  });

  it('defines each list it uses before its first rule, the two lists of targets as pairs that never match', () => {
    const defined = new Map<string, string>();
    for (const line of directives) {
      const acl = /^acl (\S+) (\S+)/.exec(line);
      if (acl !== null) {
        const [, name = '', type = ''] = acl;
        expect(defined.get(name) ?? type, name).toBe(type);
        defined.set(name, type);
      }
      if (line.startsWith('http_access')) {
        for (const word of line.split(' ').slice(2)) {
          const name = word.replace(/^!/, '');
          if (name !== 'all') expect(defined.has(name), name).toBe(true);
        }
      }
    }
    expect(directives).toContain('acl ecclium_none_one port 1');
    expect(directives).toContain('acl ecclium_none_two port 2');
    expect(directives).toContain(
      'acl ecclium_public all-of ecclium_none_one ecclium_none_two',
    );
    expect(directives).toContain(
      'acl ecclium_lan all-of ecclium_none_one ecclium_none_two',
    );
    expect(directives).toContain(
      'acl ecclium_complete all-of ecclium_none_one ecclium_none_two',
    );
    expect(directives).toContain('acl ecclium_connect method CONNECT');
    expect(directives).toContain('acl ecclium_tls_port port 443');
  });

  // The whole lists, so that dropping a range turns the test red. Squid
  // reads ::ffff:0:0/96 as 0.0.0.0/0 and would refuse every target.
  it('blocks exactly these ranges, but never IPv4 in IPv6 as a whole', () => {
    const ranges = (name: string): string[] =>
      directives
        .filter((line) => line.startsWith(`acl ${name} dst `))
        .flatMap((line) => line.split(' ').slice(3));
    expect(ranges('ecclium_never')).toEqual([
      '0.0.0.0/8',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '224.0.0.0/4',
      '240.0.0.0/4',
      '::/128',
      '::1/128',
      'fe80::/10',
      'ff00::/8',
    ]);
    expect(ranges('ecclium_special')).toEqual([
      '10.0.0.0/8',
      '100.64.0.0/10',
      '172.16.0.0/12',
      '192.0.0.0/24',
      '192.0.2.0/24',
      '192.88.99.0/24',
      '192.168.0.0/16',
      '198.18.0.0/15',
      '198.51.100.0/24',
      '203.0.113.0/24',
      '64:ff9b::/96',
      '64:ff9b:1::/48',
      '::/96',
      '100::/64',
      '2001::/23',
      '2001:db8::/32',
      '3fff::/20',
      '2002::/16',
      '5f00::/16',
      'fc00::/7',
      'fec0::/10',
    ]);
    expect(text).not.toMatch(/^acl [^\n]*::ffff:/m);
  });

  it('keeps no cache, breaks no TLS and logs no path or query', () => {
    expect(directives).toContain('cache deny all');
    expect(directives).toContain('strip_query_terms on');
    for (const forbidden of [
      /^ssl_bump/,
      /^https_port/,
      /^sslcrtd/,
      /^cache_dir/,
      /^cache allow/,
      /^cache_peer/,
      /^never_direct/,
      /^always_direct/,
      /^url_rewrite/,
      /^icap_/,
      /^ecap_/,
      /^acl \S+ src /,
      /allow all/,
    ]) {
      expect(
        directives.filter((line) => forbidden.test(line)),
        String(forbidden),
      ).toEqual([]);
    }
    const formats = directives.filter((line) => line.startsWith('logformat'));
    expect(formats).toHaveLength(1);
    expect(formats[0]).toMatch(/^logformat ecclium /);
    expect(formats[0]).not.toMatch(/%[<>]?ru|%[<>]?rp|%[<>]?h|%un|%ul/);
    expect(directives.filter((line) => line.startsWith('access_log'))).toEqual([
      'access_log stdio:/dev/stdout ecclium',
    ]);
  });

  it('lets the list of targets add only pairs and its mark, never extend another list of its own', () => {
    // Every name the generator writes is its own, one of the two lists of
    // targets or the mark of a complete list, so a fault in it cannot add
    // a rule or widen a list of the template.
    const own = new Set(
      directives.flatMap((line) => /^acl (\S+) /.exec(line)?.[1] ?? []),
    );
    const generated = renderEgressAcl([
      { host: 'example.church.tools', port: '443', lan: false, roles: ['a'] },
      { host: 'llm.example.org', port: '8443', lan: true, roles: ['b'] },
    ]);
    for (const line of generated) {
      expect(aclLinePatterns.some((pattern) => pattern.test(line))).toBe(true);
      const name = /^acl (\S+) /.exec(line)?.[1];
      if (name === undefined) continue;
      if (own.has(name)) {
        expect(['ecclium_public', 'ecclium_lan', 'ecclium_complete']).toContain(
          name,
        );
        expect(line).toMatch(/ all-of /);
      } else {
        expect(name).toMatch(/^ecclium_(host|port)_[0-9a-f]{16}$/);
      }
    }
  });
});
