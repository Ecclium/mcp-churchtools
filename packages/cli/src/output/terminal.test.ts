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

  // The core doubled the backslash of a page whose line goes on with
  // `u{202e}`: a cut between the two halves would leave a line that reads
  // as that code point.
  it('keeps each form of text the core made visible whole at a cut', () => {
    const before = 'a'.repeat(maxOutputLength - 2);
    const lines = terminalLines('+', `${before}\\\\u{202e}`, true);
    expect(lines).toEqual([`+${before}`, '\\ ... \\\\u{202e}']);
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

// What a person reads from one line on its own: `\\` as one backslash,
// `\u{…}` as the character of its code point and any other backslash as
// itself. A form split by a cut reads otherwise than the text, so the
// lines are read one by one, not joined first.
const readLine = (line: string): string => {
  let text = '';
  let index = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    const next = line.charAt(index + 1);
    const close = char === '\\' && next === 'u' ? line.indexOf('}', index) : -1;
    if (char === '\\' && next === '\\') {
      text += '\\';
      index += 2;
    } else if (char === '\\' && next === 'u' && close !== -1) {
      const point = Number.parseInt(line.slice(index + 3, close), 16);
      text += Number.isInteger(point) ? String.fromCodePoint(point) : '?';
      index = close + 1;
    } else {
      text += char;
      index += 1;
    }
  }
  return text;
};

// The lines without the prefix of the first and the mark of the others,
// each read on its own.
const readBack = (prefix: string, lines: readonly string[]): string =>
  lines
    .map((line, index) =>
      readLine(index === 0 ? line.slice(prefix.length) : line.slice(6)),
    )
    .join('');

// The form the core gives foreign text (ADR 0029): a backslash doubled,
// a hidden character as `\u{…}`, anything else as it is.
const hidden = [0x1b, 0x200b, 0x202e];
const coreVisible = (text: string): string =>
  Array.from(text, (character) => {
    const point = character.codePointAt(0) ?? 0;
    if (character === '\\') return '\\\\';
    return hidden.includes(point) ? `\\u{${point.toString(16)}}` : character;
  }).join('');

// Whatever the text holds, its lines read back as exactly the text, one
// line at a time, and the mark of a continuation starts exactly the lines
// after the first. A fixed seed keeps the runs the same in CI.
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
    'é',
    String.fromCodePoint(0x1b),
    '\n',
    String.fromCodePoint(0x200b),
    String.fromCodePoint(0x202e),
    String.fromCodePoint(0x1f389),
    String.fromCharCode(0xd800),
  );
  const short = fc.string({ unit: tricky, minLength: 1, maxLength: 40 });
  // Text that reaches the limit of a line within its last characters, so
  // that the cut falls among backslashes and forms.
  const nearCut = fc
    .tuple(fc.nat({ max: 24 }), short)
    .map(
      ([shorter, tail]) => `${'a'.repeat(maxOutputLength - shorter)}${tail}`,
    );
  const texts = fc.oneof(
    short,
    nearCut,
    fc.string({ unit: 'binary', minLength: 1, maxLength: 64 }),
  );
  const prefixes = fc.constantFrom('', '- ', '+ ', '  ');

  const holds = (prefix: string, lines: readonly string[]): void => {
    for (const line of lines) {
      expect(isTextLine(line, maxOutputLength)).toBe(true);
    }
    expect(lines[0]?.startsWith(prefix)).toBe(true);
    expect(lines[0]?.slice(prefix.length).startsWith('\\ ... ')).toBe(false);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('\\ ... ')).toBe(true);
    }
  };

  it('reads back as the foreign text, line by line, also where a line is cut', () => {
    fc.assert(
      fc.property(prefixes, texts, (prefix, text) => {
        const lines = terminalLines(prefix, text);
        holds(prefix, lines);
        expect(readBack(prefix, lines)).toBe(text);
      }),
      run,
    );
  });

  it('reads back as the text behind what the core made visible, line by line, also where a line is cut', () => {
    fc.assert(
      fc.property(prefixes, texts, (prefix, text) => {
        const lines = terminalLines(prefix, coreVisible(text), true);
        holds(prefix, lines);
        expect(readBack(prefix, lines)).toBe(text);
      }),
      run,
    );
  });

  it('cuts at least some of the texts it tries', () => {
    const cut = fc
      .sample(texts, { seed: run.seed, numRuns: run.numRuns })
      .filter((text) => terminalLines('', text).length > 1);
    expect(cut.length).toBeGreaterThan(50);
  });
});
