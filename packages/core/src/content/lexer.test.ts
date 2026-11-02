import { describe, expect, it } from 'vitest';

import { readMarkdown } from './lexer.js';
import type { Block, Inline } from './tree.js';
import { maxInlineDepth, maxListDepth } from './tree.js';

const text = (value: string): Inline => ({ kind: 'text', text: value });

const paragraph = (...children: Inline[]): Block => ({
  kind: 'paragraph',
  children,
});

const blocksOf = (markdown: string): readonly Block[] => {
  const read = readMarkdown(markdown);
  if (!read.ok) throw new Error([...read.violations].join(', '));
  return read.blocks;
};

const reasonsOf = (markdown: string): string[] => {
  const read = readMarkdown(markdown);
  return read.ok ? [] : [...read.violations].sort();
};

// A list nested to the given depth, one item per level.
const nestedList = (levels: number): string =>
  Array.from(
    { length: levels },
    (_, level) => `${' '.repeat(level * 2)}- Ebene ${String(level + 1)}`,
  ).join('\n');

describe('readMarkdown', () => {
  it('reads nothing from an empty text', () => {
    expect(blocksOf('')).toEqual([]);
    expect(blocksOf('\n\n')).toEqual([]);
  });

  it('reads headings of every level, also underlined ones', () => {
    expect(blocksOf('# Eins\n\n###### Sechs\n\nZwei\n---')).toEqual([
      { kind: 'heading', level: 1, children: [text('Eins')] },
      { kind: 'heading', level: 6, children: [text('Sechs')] },
      { kind: 'heading', level: 2, children: [text('Zwei')] },
    ]);
    expect(blocksOf('#')).toEqual([
      { kind: 'heading', level: 1, children: [] },
    ]);
  });

  it('gives a heading over two lines as one line', () => {
    expect(blocksOf('Erste\nZweite\n===')).toEqual([
      { kind: 'heading', level: 1, children: [text('Erste Zweite')] },
    ]);
  });

  it('reads paragraphs with bold and italic, escapes as text', () => {
    expect(
      blocksOf('Ein **fetter** und *kursiver* Satz \\* mit Stern'),
    ).toEqual([
      paragraph(
        text('Ein '),
        { kind: 'strong', children: [text('fetter')] },
        text(' und '),
        { kind: 'emphasis', children: [text('kursiver')] },
        text(' Satz * mit Stern'),
      ),
    ]);
  });

  it('joins bold after bold and bold inside bold into one part', () => {
    expect(blocksOf('**a**__b__ und *c*_d_')).toEqual([
      paragraph({ kind: 'strong', children: [text('ab')] }, text(' und '), {
        kind: 'emphasis',
        children: [text('cd')],
      }),
    ]);
    expect(blocksOf('**__a__ b**')).toEqual([
      paragraph({ kind: 'strong', children: [text('a b')] }),
    ]);
    expect(blocksOf('**__a__ *b***')).toEqual([
      paragraph({
        kind: 'strong',
        children: [text('a '), { kind: 'emphasis', children: [text('b')] }],
      }),
    ]);
  });

  it('drops spaces around line breaks and at the edges of a paragraph', () => {
    expect(blocksOf('  Eins \n   zwei\t\n\tdrei  ')).toEqual([
      paragraph(text('Eins\nzwei\ndrei')),
    ]);
    expect(blocksOf('**fett** \nweiter')).toEqual([
      paragraph({ kind: 'strong', children: [text('fett')] }, text('\nweiter')),
    ]);
  });

  it('reads a bare web address or e-mail address as text, for the checks after it', () => {
    expect(
      blocksOf('Siehe www.example.org und max.mustermann@example.org'),
    ).toEqual([
      paragraph(text('Siehe www.example.org und max.mustermann@example.org')),
    ]);
  });

  it('reads lists with bullets and numbers, tight and loose', () => {
    expect(blocksOf('- a\n- b')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        loose: false,
        items: [[paragraph(text('a'))], [paragraph(text('b'))]],
      },
    ]);
    expect(blocksOf('3. a\n\n4. b\n\n   weiter')).toEqual([
      {
        kind: 'list',
        ordered: true,
        start: 3,
        loose: true,
        items: [
          [paragraph(text('a'))],
          [paragraph(text('b')), paragraph(text('weiter'))],
        ],
      },
    ]);
    expect(blocksOf('- **fett** und mehr')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        loose: false,
        items: [
          [
            paragraph(
              { kind: 'strong', children: [text('fett')] },
              text(' und mehr'),
            ),
          ],
        ],
      },
    ]);
    expect(blocksOf('-\n- a')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        loose: false,
        items: [[], [paragraph(text('a'))]],
      },
    ]);
  });

  it(`reads lists up to ${String(maxListDepth)} levels and refuses a deeper one`, () => {
    expect(readMarkdown(nestedList(maxListDepth)).ok).toBe(true);
    expect(reasonsOf(nestedList(maxListDepth + 1))).toEqual(['tooDeep']);
  });

  it(`reads bold and italic up to ${String(maxInlineDepth)} levels and refuses a deeper one`, () => {
    const nested = (levels: number): string => {
      let value = 'x';
      for (let level = 0; level < levels; level += 1) {
        value = level % 2 === 0 ? `*${value}*` : `**${value}**`;
        value = `a ${value} b`;
      }
      return value;
    };
    expect(readMarkdown(nested(maxInlineDepth)).ok).toBe(true);
    expect(reasonsOf(nested(maxInlineDepth + 1))).toEqual(['tooDeep']);
  });

  it('refuses a list whose numbers would pass nine digits', () => {
    expect(reasonsOf('999999999. a\n999999999. b')).toEqual(['unsupported']);
    expect(readMarkdown('999999998. a\n999999998. b').ok).toBe(true);
  });

  it('reads tables with their alignment, an escaped bar as text', () => {
    expect(
      blocksOf(
        '| a | **b** | c | d |\n| :- | :-: | -: | --- |\n| 1 \\| 2 | | x |',
      ),
    ).toEqual([
      {
        kind: 'table',
        align: ['left', 'center', 'right', null],
        header: [
          [text('a')],
          [{ kind: 'strong', children: [text('b')] }],
          [text('c')],
          [text('d')],
        ],
        rows: [[[text('1 | 2')], [], [text('x')], []]],
      },
    ]);
  });

  it('refuses a table with a row wider than its header, whose cells the lexer would drop', () => {
    expect(
      reasonsOf('| a |\n|---|\n| b | ![x](https://example.org/p.png?d=1) |'),
    ).toEqual(['unsupported']);
    expect(reasonsOf('a | b\n--|--\nc | d | e')).toEqual(['unsupported']);
    expect(readMarkdown('| a | b |\n|---|---|\n| c \\| d | e |').ok).toBe(true);
    expect(readMarkdown('| a | b |\n|---|---|\n| c |').ok).toBe(true);
    expect(readMarkdown('| a |\n|---|\n| b \\\\|').ok).toBe(true);
  });

  it('refuses HTML, also a comment, in a block, inline and in a list', () => {
    expect(reasonsOf('<div>x</div>')).toEqual(['html']);
    expect(reasonsOf('<!-- Hinweis -->')).toEqual(['html']);
    expect(reasonsOf('Ein <b>Wort</b>')).toEqual(['html']);
    expect(reasonsOf('- a\n\n  <div>b</div>')).toEqual(['html']);
  });

  it('refuses character references, which say nothing a reader sees in the text', () => {
    expect(reasonsOf('a &amp; b')).toEqual(['html']);
    expect(reasonsOf('a &#60; b')).toEqual(['html']);
    expect(reasonsOf('a &#x3C; b')).toEqual(['html']);
    expect(reasonsOf('a &#X3c; b')).toEqual(['html']);
    expect(reasonsOf('a &Auml2; b')).toEqual(['html']);
    expect(blocksOf('Fr. 20.– & mehr, &#; &#x; &#12 &a b & c &3; Q&A')).toEqual(
      [paragraph(text('Fr. 20.– & mehr, &#; &#x; &#12 &a b & c &3; Q&A'))],
    );
  });

  it('refuses images, links, mentions and references', () => {
    expect(reasonsOf('![Bild](https://example.org/b.png)')).toEqual(['image']);
    expect(reasonsOf('[Seite](https://example.org)')).toEqual(['link']);
    expect(reasonsOf('[x](javascript:alert(1))')).toEqual(['link']);
    expect(reasonsOf('<https://example.org>')).toEqual([]);
    expect(
      reasonsOf(
        '[Max Mustermann](https://example.church.tools/?q=churchdb\\&ctmd_layout=mention#PersonView/searchEntry:%23person-id-1/)',
      ),
    ).toEqual(['mention']);
    expect(
      reasonsOf(
        '[Max](https://example.church.tools/#PersonView/searchEntry:1/)',
      ),
    ).toEqual(['mention']);
    expect(reasonsOf('[a]: https://example.org\n\n[a]')).toEqual([
      'link',
      'reference',
    ]);
    expect(reasonsOf('Text[^1]\n\n[^1]: Fussnote')).toEqual([
      'link',
      'reference',
    ]);
  });

  it('refuses Markdown outside the allowed part', () => {
    expect(reasonsOf('`code`')).toEqual(['unsupported']);
    expect(reasonsOf('```\ncode\n```')).toEqual(['unsupported']);
    expect(reasonsOf('    eingerückt')).toEqual(['unsupported']);
    expect(reasonsOf('> Zitat')).toEqual(['unsupported']);
    expect(reasonsOf('Text\n\n---')).toEqual(['unsupported']);
    expect(reasonsOf('Zeile  \nZeile')).toEqual(['unsupported']);
    expect(reasonsOf('Zeile\\\nZeile')).toEqual(['unsupported']);
    expect(reasonsOf('~~weg~~')).toEqual(['unsupported']);
    expect(reasonsOf('- [ ] offen\n- [x] erledigt')).toEqual(['unsupported']);
    expect(reasonsOf('- # Titel')).toEqual(['unsupported']);
    expect(reasonsOf('- | a |\n  | - |\n  | b |')).toEqual(['unsupported']);
  });

  it('names every reason it finds, not only the first', () => {
    expect(reasonsOf('<b>x</b> ![b](x.png) `c`\n\n> z')).toEqual([
      'html',
      'image',
      'unsupported',
    ]);
  });

  it('refuses a text the lexer cannot read, without throwing', () => {
    // Bold so deep that the lexer runs out of stack. The content policy
    // never gets here with it: the limit on asterisks comes first.
    const deep = `${'**'.repeat(20_000)}x${'**'.repeat(20_000)}`;
    expect(reasonsOf(deep)).toEqual(['unparsable']);
  });
});
