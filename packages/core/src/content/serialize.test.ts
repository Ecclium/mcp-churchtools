import { describe, expect, it } from 'vitest';

import { readMarkdown } from './lexer.js';
import { serializeBlocks } from './serialize.js';
import type { Block, Inline, List } from './tree.js';

const text = (value: string): Inline => ({ kind: 'text', text: value });

const paragraph = (...children: Inline[]): Block => ({
  kind: 'paragraph',
  children,
});

const list = (ordered: boolean, items: Block[][], start = 1): List => ({
  kind: 'list',
  ordered,
  start,
  loose: false,
  items: items as List['items'],
});

// The serializer is right when the lexer reads its output back as the same
// tree.
const roundTrip = (blocks: readonly Block[]): readonly Block[] => {
  const read = readMarkdown(serializeBlocks(blocks));
  if (!read.ok) throw new Error([...read.violations].join(', '));
  return read.blocks;
};

describe('serializeBlocks', () => {
  it('writes nothing for no blocks and one blank line between blocks', () => {
    expect(serializeBlocks([])).toBe('');
    expect(
      serializeBlocks([
        { kind: 'heading', level: 2, children: [text('Plan')] },
        paragraph(text('Text')),
      ]),
    ).toBe('## Plan\n\nText\n');
    expect(serializeBlocks([{ kind: 'heading', level: 1, children: [] }])).toBe(
      '#\n',
    );
  });

  it('escapes every sign that could start Markdown in text', () => {
    const signs = 'a \\ ` * _ [ ] < > | ~ & # b';
    expect(serializeBlocks([paragraph(text(signs))])).toBe(
      'a \\\\ \\` \\* \\_ \\[ \\] \\< \\> \\| \\~ \\& \\# b\n',
    );
    expect(roundTrip([paragraph(text(signs))])).toEqual([
      paragraph(text(signs)),
    ]);
  });

  it('escapes a line that starts like a list item, an underline, a row of a table or a number', () => {
    const lines = '- a\n+ b\n= c\n:-- g\n2026. d\n3) e\n12 f\nx';
    const written = serializeBlocks([paragraph(text(lines))]);
    expect(written).toBe(
      '\\- a\n\\+ b\n\\= c\n\\:-- g\n2026\\. d\n3\\) e\n12 f\nx\n',
    );
    expect(roundTrip([paragraph(text(lines))])).toEqual([
      paragraph(text(lines)),
    ]);
  });

  it('writes bold with two asterisks and italic with one', () => {
    const nodes = paragraph(
      text('ein '),
      { kind: 'strong', children: [text('fettes')] },
      text(' und '),
      { kind: 'emphasis', children: [text('schräges')] },
      text(' Wort'),
    );
    expect(serializeBlocks([nodes])).toBe(
      'ein **fettes** und *schräges* Wort\n',
    );
    expect(roundTrip([nodes])).toEqual([nodes]);
  });

  it('writes lists with -, numbers and the width of the marker as indent', () => {
    const nested = list(
      true,
      [
        [paragraph(text('a'))],
        [paragraph(text('b\nweiter')), list(false, [[paragraph(text('x'))]])],
      ],
      9,
    );
    expect(serializeBlocks([nested])).toBe(
      '9. a\n10. b\n    weiter\n    - x\n',
    );
    expect(roundTrip([nested])).toEqual([nested]);
  });

  it('writes a loose list with blank lines and an empty item as its marker', () => {
    const loose: List = {
      ...list(false, [[paragraph(text('a')), paragraph(text('b'))], []]),
      loose: true,
    };
    expect(serializeBlocks([loose])).toBe('- a\n\n  b\n\n-\n');
  });

  it('gives every second of two lists in a row the other marker', () => {
    const lists: Block[] = [
      list(false, [[paragraph(text('a'))]]),
      list(false, [[paragraph(text('b'))]]),
      list(false, [[paragraph(text('c'))]]),
      list(true, [[paragraph(text('d'))]]),
      list(true, [[paragraph(text('e'))]]),
      paragraph(text('f')),
      list(true, [[paragraph(text('g'))]]),
    ];
    expect(serializeBlocks(lists)).toBe(
      '- a\n\n* b\n\n- c\n\n1. d\n\n1) e\n\nf\n\n1. g\n',
    );
    expect(roundTrip(lists)).toEqual(lists);
  });

  it('writes tables with a row of alignment and escaped bars', () => {
    const table: Block = {
      kind: 'table',
      align: [null, 'left', 'center', 'right'],
      header: [[text('a')], [text('b')], [text('c')], []],
      rows: [[[text('1 | 2')], [], [text('-x')], [text('3')]]],
    };
    expect(serializeBlocks([table])).toBe(
      '| a | b | c |  |\n| --- | :-- | :-: | --: |\n| 1 \\| 2 |  | -x | 3 |\n',
    );
    expect(roundTrip([table])).toEqual([table]);
  });
});
