import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  checkLinks,
  extractLinks,
  isRelative,
} from '../../scripts/check-md-links.mts';

describe('extractLinks', () => {
  it('finds links, images, references and HTML attributes with their lines', () => {
    const markdown = [
      '[text](docs/a.md "Title") and ![logo](<brand/logo one.svg>)',
      '[ref]: ../b.md',
      '<img src="c.png"> <source srcset="d.svg 1x, e.svg 2x">',
      '<a href="f.md">f</a>',
    ].join('\n');
    expect(extractLinks(markdown)).toEqual([
      { line: 1, target: 'docs/a.md' },
      { line: 1, target: 'brand/logo one.svg' },
      { line: 2, target: '../b.md' },
      { line: 3, target: 'c.png' },
      { line: 3, target: 'd.svg' },
      { line: 3, target: 'e.svg' },
      { line: 4, target: 'f.md' },
    ]);
  });

  it('skips code blocks, also indented ones, and inline code', () => {
    const markdown = [
      '1. Step:',
      '',
      '   ```sh',
      '   [not](a-link.md)',
      '   ```',
      '',
      'Use `[x](y.md)` as syntax, see [real](z.md).',
    ].join('\n');
    expect(extractLinks(markdown)).toEqual([{ line: 7, target: 'z.md' }]);
  });
});

describe('isRelative', () => {
  it.each([
    ['docs/a.md', true],
    ['/docs/a.md', true],
    ['https://example.org', false],
    ['mailto:max.mustermann@example.org', false],
    ['#section', false],
    ['//example.org/x', false],
  ])('%s is relative: %s', (target, expected) => {
    expect(isRelative(target)).toBe(expected);
  });
});

describe('checkLinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'md-links-'));
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports only relative links whose target is missing', async () => {
    write('docs/b.md', '# B\n');
    write('docs/sub/c.txt', 'c\n');
    write(
      'README.md',
      [
        '[ok](docs/b.md#part) [dir](docs/sub/) [root](/docs/b.md)',
        '[missing](docs/missing.md) [web](https://example.org) [anchor](#top)',
        '[pending](TRADEMARKS.md) [space](docs/sub/c%2Etxt)',
      ].join('\n'),
    );
    write('.github/template.md', '[broken](../nowhere.md)\n');
    write('node_modules/pkg/readme.md', '[ignored](gone.md)\n');
    write('brand/README.md', '[ignored](gone.md)\n');
    write('.hidden/notes.md', '[ignored](gone.md)\n');

    const report = await checkLinks(root);
    expect(report.files).toBe(3);
    expect(report.broken).toEqual([
      { file: '.github/template.md', line: 1, target: '../nowhere.md' },
      { file: 'README.md', line: 2, target: 'docs/missing.md' },
    ]);
  });
});
