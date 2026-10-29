import { describe, expect, it } from 'vitest';

import {
  academyOrigin,
  allowedHosts,
  findForeignHosts,
  findHostsIn,
  type HostKind,
  walkStrings,
} from './hosts.js';

// The check of hosts (ADR 0027, ADR 0066). A host under church.tools other
// than the placeholder is built at run time, because gitleaks refuses one
// written out in a file of the repository.
const hosted = (label: string): string => [label, 'church', 'tools'].join('.');

describe('findForeignHosts', () => {
  it.each([
    ['plain text', 'Gruppen und ihre Mitglieder sehen'],
    ['a link to the Academy', `${academyOrigin}/de/help/gruppen/`],
    ['the placeholder', 'https://example.church.tools/api/groups'],
    ['the placeholder of an e-mail address', 'max.mustermann@example.org'],
    ['a path on the Academy', '[Rechte](/de/help/rechte/)'],
    ['paths of fields', 'group.name, person.id and meta.pagination.total'],
    ['file names', 'operations.json, index.ts and Node.js'],
    ['versions', 'ChurchTools 3.138.0 and 0.1.0'],
    ['a version with five parts', '1.2.3.4.5'],
    ['a scheme without a host', 'Requests use https: always'],
    ['the npm scope', '@ecclium/mcp-churchtools'],
    ['a comment in code', '// see above'],
  ])('allows %s', (_name, text) => {
    expect(findForeignHosts(text)).toEqual([]);
  });

  it.each<[string, string, readonly HostKind[]]>([
    ['a URL to another host', 'https://example.com/x', ['name', 'url']],
    [
      'a URL with user and port',
      'http://user@host.example:8080/',
      ['mail', 'url'],
    ],
    ['a URL in a Markdown link', '[x](ftp://files.example/)', ['url']],
    [
      'a target without scheme',
      '[x](//cdn.example/a.js)',
      ['protocol-relative'],
    ],
    ['an e-mail address', 'info@vendor.example', ['mail']],
    [
      'an e-mail address with an ending',
      'someone@example.com',
      ['mail', 'name'],
    ],
    ['a name with www', 'www.vendor.example', ['www']],
    ['a name with a checked ending', 'Siehe churchtools.de', ['name']],
    ['a Swiss name', 'gemeinde.ch', ['name']],
    ['a host under church.tools', hosted('demo-tenant'), ['church-tools']],
    ['the apex of church.tools', 'church.tools', ['church-tools']],
    [
      'a host under the placeholder',
      `${hosted('sub.example')}/api`,
      ['church-tools'],
    ],
    [
      'a host under church.tools in a URL',
      `https://${hosted('gemeinde')}/`,
      ['church-tools', 'url'],
    ],
    [
      'a sub-domain of the Academy',
      'https://de.churchtools.academy/',
      ['name', 'url'],
    ],
    ['capital letters', 'WWW.VENDOR.EXAMPLE', ['www']],
    ['a web link with one slash', 'https:/files.example/x', ['url']],
    ['a web link without slashes', 'https:files.example', ['url']],
    ['a web link with backslashes', 'https:\\\\files.example', ['url']],
    ['an IPv6 address in a URL', 'http://[2001:db8::1]/', ['url']],
    ['an IPv4 address', 'Server 192.0.2.10 antwortet', ['ip']],
    [
      'full-width dots',
      ['gemeinde', 'church', 'tools'].join('\uFF0E'),
      ['church-tools'],
    ],
    [
      'ideographic full stops',
      ['gemeinde', 'church', 'tools'].join('\u3002'),
      ['church-tools'],
    ],
    [
      'dots escaped for Markdown',
      ['gemeinde', 'church', 'tools'].join('\\.'),
      ['church-tools'],
    ],
  ])('finds %s', (_name, text, kinds) => {
    expect(findForeignHosts(text)).toEqual(kinds);
  });

  it('allows exactly the two hosts of ADR 0027', () => {
    expect(allowedHosts).toEqual([
      'churchtools.academy',
      'example.church.tools',
    ]);
  });

  it('stays fast on a long word', () => {
    const start = performance.now();
    expect(findForeignHosts(`${'a.'.repeat(100_000)}x`)).toEqual([]);
    expect(findForeignHosts('a'.repeat(200_000))).toEqual([]);
    expect(findForeignHosts('a@'.repeat(50_000))).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('findHostsIn', () => {
  it('names the path of each string with a host, never the host', () => {
    const findings = findHostsIn({
      entries: [{ text: 'fine' }, { text: `see ${hosted('gemeinde')}` }],
    });
    expect(findings).toEqual([
      { path: 'entries[1].text', kinds: ['church-tools'] },
    ]);
    expect(JSON.stringify(findings)).not.toContain('gemeinde');
  });

  it('checks keys at the path of their object', () => {
    expect(findHostsIn({ a: { 'www.vendor.example': 1 } })).toEqual([
      { path: 'a', kinds: ['www'] },
    ]);
  });
});

describe('walkStrings', () => {
  it('visits strings and keys, and names only plain keys in a path', () => {
    const seen: string[] = [];
    walkStrings({ a: ['x', 2], 'b c': 'y', d: null }, (path, text) => {
      seen.push(`${path}=${text}`);
    });
    expect(seen).toEqual(['=a', 'a[0]=x', '=b c', '*=y', '=d']);
  });
});
