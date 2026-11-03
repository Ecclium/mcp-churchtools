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

  it.each([
    ['an escape sequence', 'Rot: \u001b[31mAchtung', 'Rot: \\u{1b}[31mAchtung'],
    ['a control character', 'A\u0007B', 'A\\u{7}B'],
    ['a mark that turns the direction', 'abc\u202Edef', 'abc\\u{202e}def'],
    ['an invisible character', 'a\u200Bb', 'a\\u{200b}b'],
    ['a line break', 'a\nb', 'a\\u{a}b'],
    ['a letter outside the list', 'Café ß', 'Caf\\u{e9} \\u{df}'],
    ['a pair of surrogates', 'Lob 🎉', 'Lob \\u{1f389}'],
    ['a lone surrogate', 'x\uD800y', 'x\\u{d800}y'],
    ['a backslash', 'C:\\u{41}', 'C:\\\\u{41}'],
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
    expect(lines[1]).toBe(`  ... \\u{1b}${'b'.repeat(20)}`);
    for (const line of lines) {
      expect(isTextLine(line, maxOutputLength)).toBe(true);
    }
  });

  it('gives a line with one character for an empty text', () => {
    expect(terminalLines('', '')).toEqual([' ']);
  });
});
