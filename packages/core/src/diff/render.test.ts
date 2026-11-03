import { describe, expect, it } from 'vitest';

import { diffLines } from './diff.js';
import { crLfMarker, noLineEndMarker, renderDiff } from './render.js';

describe('renderDiff', () => {
  it('gives no line for a diff without hunks', () => {
    expect(renderDiff(diffLines('a\n', 'a\n'))).toEqual([]);
  });

  it('gives a header per hunk and every line with its prefix, without its ending', () => {
    const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n';
    const after = before.replace('2\n', 'two\n').replace('11\n', '');
    expect(renderDiff(diffLines(before, after))).toEqual([
      '@@ -1,5 +1,5 @@',
      ' 1',
      '-2',
      '+two',
      ' 3',
      ' 4',
      ' 5',
      '@@ -8,5 +8,4 @@',
      ' 8',
      ' 9',
      ' 10',
      '-11',
      ' 12',
    ]);
  });

  it('names the line before for a side without lines, as a unified diff does', () => {
    expect(renderDiff(diffLines('', 'a\n'))).toEqual(['@@ -0,0 +1,1 @@', '+a']);
    expect(renderDiff(diffLines('a\nb\n', ''))).toEqual([
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    ]);
  });

  it('marks a line without a line ending and a line that ends with CR LF', () => {
    expect(noLineEndMarker).toBe('\\ No newline at end of file');
    expect(crLfMarker).toBe('\\ Line ends with CR LF');
    expect(renderDiff(diffLines('a\nb', 'a\r\nb\n'))).toEqual([
      '@@ -1,2 +1,2 @@',
      '-a',
      '-b',
      noLineEndMarker,
      '+a',
      crLfMarker,
      '+b',
    ]);
  });

  it('shows a line of the text that looks like a marker with its prefix', () => {
    expect(renderDiff(diffLines('', `${noLineEndMarker}\n`))).toEqual([
      '@@ -0,0 +1,1 @@',
      `+${noLineEndMarker}`,
    ]);
  });

  it('leaves the signs of the text as they are', () => {
    expect(renderDiff(diffLines('', 'a\u001b[31m\rb\n'))).toEqual([
      '@@ -0,0 +1,1 @@',
      '+a\u001b[31m\rb',
    ]);
  });

  it('gives the lines frozen', () => {
    expect(Object.isFrozen(renderDiff(diffLines('a', 'b')))).toBe(true);
  });
});
