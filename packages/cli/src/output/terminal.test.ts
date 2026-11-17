import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isTextLine } from '../send.js';
import { terminalLines } from './terminal.js';
import { maxOutputLength } from './write.js';

// Foreign text, such as the lines of a page of the wiki in the diff of
// `ecclium undo`, goes out only in a form a terminal shows as text
// (ADR 0031).
describe('terminalLines', () => {
  it('keeps what the writers let through', () => {
    expect(
      terminalLines('+ ', 'Gottesdienst am Sonntag, «Gäste» willkommen.'),
    ).toEqual(['+ Gottesdienst am Sonntag, «Gäste» willkommen.']);
  });

  // Markdown escapes the dot of a date at the start of a line, so that it
  // starts no list; the preview shows it as it goes into the page.
  it('keeps «ß» and a backslash that starts no form', () => {
    expect(terminalLines('', '18\\.11.2026, Grußwort')).toEqual([
      '18\\.11.2026, Grußwort',
    ]);
  });

  it.each([
    ['an escape sequence', 'Rot: \u001b[31mAchtung', 'Rot: \\u{1b}[31mAchtung'],
    ['a control character', 'A\u0007B', 'A\\u{7}B'],
    ['a mark that turns the direction', 'abc\u202Edef', 'abc\\u{202e}def'],
    ['an invisible character', 'a\u200Bb', 'a\\u{200b}b'],
    ['a line break', 'a\nb', 'a\\u{a}b'],
    ['a letter outside the list', 'Café', 'Caf\\u{e9}'],
    ['a pair of surrogates', 'Lob 🎉', 'Lob \\u{1f389}'],
    ['a lone surrogate', 'x\uD800y', 'x\\u{d800}y'],
    ['a backslash before u', 'C:\\u{41}', 'C:\\\\u{41}'],
    ['a backslash before a backslash', 'a\\\\b', 'a\\\\\\b'],
    ['a backslash before a hidden character', 'a\\\u001b', 'a\\\\\\u{1b}'],
    ['a backslash at the end', 'C:\\', 'C:\\\\'],
  ])('shows %s in a visible form', (_, text, shown) => {
    const lines = terminalLines('- ', text);
    expect(lines).toEqual([`- ${shown}`]);
    for (const line of lines) {
      expect(isTextLine(line, maxOutputLength)).toBe(true);
    }
  });

  it('cuts a long line into marked parts without cutting a visible form', () => {
    const text = `${'a'.repeat(maxOutputLength - 3)}\u001b${'b'.repeat(20)}`;
    const lines = terminalLines('+ ', text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`+ ${'a'.repeat(maxOutputLength - 3)}`);
    expect(lines[1]).toBe(`\\ ... \\u{1b}${'b'.repeat(20)}`);
    for (const line of lines) {
      expect(isTextLine(line, maxOutputLength)).toBe(true);
    }
  });

  // A line of the text can start with what looks like the mark; shown,
  // its backslash is doubled, so it never reads as a continuation.
  it('keeps the mark of a continuation out of reach of the text', () => {
    expect(terminalLines(' ', '\\ ... und alle Kontakte')).toEqual([
      ' \\\\ ... und alle Kontakte',
    ]);
  });

  it('gives a line with one character for an empty text', () => {
    expect(terminalLines('', '')).toEqual([' ']);
  });
});

// What a person reads from the lines: each line after the first without
// the mark of a continuation, `\\` as one backslash, `\u{…}` as the
// character of its code point and any other backslash as itself.
const readBack = (lines: readonly string[]): string => {
  const mark = '\\ ... ';
  const joined = lines
    .map((line, index) => (index === 0 ? line : line.slice(mark.length)))
    .join('');
  let text = '';
  let index = 0;
  while (index < joined.length) {
    const char = joined.charAt(index);
    const next = joined.charAt(index + 1);
    if (char === '\\' && next === '\\') {
      text += '\\';
      index += 2;
    } else if (char === '\\' && next === 'u') {
      const end = joined.indexOf('}', index);
      const point = Number.parseInt(joined.slice(index + 3, end), 16);
      text += String.fromCodePoint(point);
      index = end + 1;
    } else {
      text += char;
      index += 1;
    }
  }
  return text;
};

// Whatever the text holds, its lines read back as exactly the text: no
// backslash of the text makes a form, and no form gets lost. A fixed seed
// keeps the runs the same in CI.
describe('the visible form of any text', () => {
  const run = { seed: 31_017, numRuns: 300 };
  const tricky = fc.constantFrom(
    '\\',
    'u',
    ' ',
    '.',
    '{',
    '}',
    '1',
    'a',
    'ß',
    String.fromCodePoint(0x1b),
    '\n',
    String.fromCodePoint(0x200b),
    String.fromCodePoint(0x1f389),
  );
  const texts = fc.oneof(
    fc.string({ unit: tricky, minLength: 1, maxLength: 2 * maxOutputLength }),
    fc.string({ unit: 'binary', minLength: 1, maxLength: 64 }),
  );

  it('reads back as the text, in lines the writers take, with the mark only where a line goes on', () => {
    fc.assert(
      fc.property(texts, (text) => {
        const lines = terminalLines('', text);
        for (const line of lines) {
          expect(isTextLine(line, maxOutputLength)).toBe(true);
        }
        expect(lines[0]?.startsWith('\\ ... ')).toBe(false);
        for (const line of lines.slice(1)) {
          expect(line.startsWith('\\ ... ')).toBe(true);
        }
        expect(readBack(lines)).toBe(text);
      }),
      run,
    );
  });
});
