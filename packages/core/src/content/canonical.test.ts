import { describe, expect, it } from 'vitest';

import {
  canonicalFormOf,
  canonicalMarkdown,
  canonicalOfWritten,
  canonicalPartsOf,
} from './canonical.js';
import { maxContentBytes, maxDelimiterSigns } from './normalize.js';

const u = (codePoint: number): string => String.fromCodePoint(codePoint);

describe('canonicalPartsOf', () => {
  it('reads a page into its blocks of the top level with their line breaks', () => {
    const parts = canonicalPartsOf('# Plan\n\nEine\nZeile\n\nAutomatisch.\n');
    expect(parts?.map((part) => [part.type, part.breaks, part.line])).toEqual([
      ['other', 0, undefined],
      ['space', 2, undefined],
      ['paragraph', 1, undefined],
      ['space', 2, undefined],
      ['paragraph', 1, 'Automatisch.'],
    ]);
    expect(Object.isFrozen(parts)).toBe(true);
  });

  it('reads a page with CR LF like one with LF', () => {
    expect(canonicalPartsOf('a\r\n\r\nb\r\n')).toEqual(
      canonicalPartsOf('a\n\nb\n'),
    );
  });

  it.each([
    ['a lone carriage return', 'a\rb'],
    ['a lone surrogate', `a${String.fromCharCode(0xdc00)}`],
    ['a text over the limit', 'a'.repeat(maxContentBytes + 1)],
    ['too many signs of emphasis', '*'.repeat(maxDelimiterSigns + 1)],
  ])('reads no page with %s', (_name, text) => {
    expect(canonicalPartsOf(text)).toBeUndefined();
  });

  it('gives a block of the allowed part, and none otherwise', () => {
    const node = (text: string) => canonicalPartsOf(text)?.[0]?.node;
    expect(node('Text.')).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'Text.' }],
    });
    expect(node('[Text](https://example.org/)')).toBeUndefined();
  });

  it('names HTML that could hide what follows, but not a closed comment', () => {
    const hides = (text: string) =>
      canonicalPartsOf(text)?.map((part) => part.hides);
    expect(hides('<!-- Kommentar -->')).toEqual([false]);
    expect(hides('<!--\n\nmehrere Zeilen\n\n-->')).toEqual([false]);
    expect(hides('<details>')).toEqual([true]);
    expect(hides('<!-- a --> <div hidden>')).toEqual([true]);
    expect(hides('<!-- a --> -->')).toEqual([true]);
    // An opening that closes itself, and a close before the opening ends.
    expect(hides('<!-->')).toEqual([true]);
    expect(hides('<!--->')).toEqual([true]);
    expect(hides('Text <span hidden>x</span>.')).toEqual([true]);
    expect(hides('Kirche &amp; Gemeinde.')).toEqual([false]);
  });
});

describe('canonicalFormOf', () => {
  it('writes every run of spaces and line breaks in a text as one space', () => {
    expect(
      canonicalFormOf([
        {
          kind: 'heading',
          level: 2,
          children: [{ kind: 'text', text: 'a  b' }],
        },
        {
          kind: 'paragraph',
          children: [
            { kind: 'text', text: 'c\nd ' },
            { kind: 'strong', children: [{ kind: 'text', text: 'e\n f' }] },
          ],
        },
        {
          kind: 'list',
          ordered: false,
          start: 1,
          loose: false,
          items: [
            [
              { kind: 'paragraph', children: [{ kind: 'text', text: 'g\nh' }] },
              {
                kind: 'list',
                ordered: true,
                start: 1,
                loose: false,
                items: [
                  [
                    {
                      kind: 'paragraph',
                      children: [{ kind: 'text', text: 'i  j' }],
                    },
                  ],
                ],
              },
            ],
          ],
        },
        {
          kind: 'table',
          align: [null],
          header: [[{ kind: 'text', text: 'k  l' }]],
          rows: [[[{ kind: 'text', text: 'm  n' }]]],
        },
      ]),
    ).toBe(
      '## a b\n\nc d **e f**\n\n- g h\n  1. i j\n\n| k l |\n| --- |\n| m n |\n',
    );
  });
});

describe('canonicalMarkdown', () => {
  // The canonical form keeps the text as it stands, so that a sign a
  // person puts in and a reader sees, or that turns the order of what a
  // reader sees, changes it (ADR 0032).
  it('keeps hidden signs and signs NFKC changes, and takes a protected space for a space', () => {
    const form = canonicalMarkdown('Saal 12 um 18 Uhr.');
    for (const text of [
      `Saal ${u(0x202e)}12${u(0x202c)} um 18 Uhr.`,
      `Saal 1${u(0x200b)}2 um 18 Uhr.`,
      `Saal 1${u(0xb2)} um 18 Uhr.`,
      `Saal ${u(0xff11)}${u(0xff12)} um 18 Uhr.`,
    ]) {
      expect(canonicalMarkdown(text), text).not.toBe(form);
    }
    expect(canonicalMarkdown(`Saal${u(0xa0)}12 um${u(0x202f)}18 Uhr.`)).toBe(
      form,
    );
  });

  it('gives no form for a text with a block that has none, and the empty form for an empty text', () => {
    expect(canonicalMarkdown('Text.\n\n> Zitat')).toBeUndefined();
    expect(canonicalMarkdown('a\rb')).toBeUndefined();
    expect(canonicalMarkdown('')).toBe('');
  });
});

describe('canonicalOfWritten', () => {
  it('gives the form of a text the content policy wrote, and refuses one it never writes', () => {
    expect(canonicalOfWritten('## Nachtrag\n\nEine\nZeile\n')).toBe(
      '## Nachtrag\n\nEine Zeile\n',
    );
    expect(() => canonicalOfWritten('[mehr](https://example.org/)')).toThrow(
      TypeError,
    );
  });
});
