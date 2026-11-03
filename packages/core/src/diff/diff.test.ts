import { describe, expect, it } from 'vitest';

import { applyDiff } from './apply.js';
import {
  diffContextLines,
  type DiffLine,
  diffLines,
  maxDiffEdits,
  maxDiffLines,
} from './diff.js';
import { splitLines } from './lines.js';

const context = (text: string): DiffLine => ({ kind: 'context', text });
const removed = (text: string): DiffLine => ({ kind: 'removed', text });
const added = (text: string): DiffLine => ({ kind: 'added', text });

// A text of numbered lines, each with `\n`, from `from` up to `to`.
const numberedText = (from: number, to: number, prefix = 'l'): string =>
  Array.from(
    { length: to - from + 1 },
    (_, index) => `${prefix}${String(from + index)}\n`,
  ).join('');

describe('diffLines', () => {
  it('gives no hunk for equal texts', () => {
    for (const text of ['', 'a', 'a\nb\n', 'a\r\n\r\n']) {
      expect(diffLines(text, text)).toEqual({ hunks: [], replaced: false });
    }
  });

  it('gives a change with its context', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual({
      hunks: [
        {
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 3,
          lines: [context('a\n'), removed('b\n'), added('B\n'), context('c\n')],
        },
      ],
      replaced: false,
    });
  });

  it('shows three lines of context on either side and no more', () => {
    expect(diffContextLines).toBe(3);
    const before = numberedText(1, 10);
    const after = before.replace('l5\n', 'X\n');
    expect(diffLines(before, after).hunks).toEqual([
      {
        oldStart: 2,
        oldCount: 7,
        newStart: 2,
        newCount: 7,
        lines: [
          context('l2\n'),
          context('l3\n'),
          context('l4\n'),
          removed('l5\n'),
          added('X\n'),
          context('l6\n'),
          context('l7\n'),
          context('l8\n'),
        ],
      },
    ]);
  });

  it('joins two changes with six lines between them and parts them with seven', () => {
    const before = numberedText(1, 20);
    const joined = diffLines(
      before,
      before.replace('l5\n', '').replace('l12\n', ''),
    );
    expect(joined.hunks).toHaveLength(1);
    expect(joined.hunks[0]).toMatchObject({
      oldStart: 2,
      oldCount: 14,
      newStart: 2,
      newCount: 12,
    });
    const parted = diffLines(
      before,
      before.replace('l5\n', '').replace('l13\n', ''),
    );
    expect(
      parted.hunks.map(({ oldStart, oldCount, newStart, newCount }) => [
        oldStart,
        oldCount,
        newStart,
        newCount,
      ]),
    ).toEqual([
      [2, 7, 2, 6],
      [10, 7, 9, 6],
    ]);
  });

  it('places a change at the start and at the end of a text', () => {
    expect(diffLines('a\nb\n', 'x\na\nb\n').hunks).toEqual([
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 3,
        lines: [added('x\n'), context('a\n'), context('b\n')],
      },
    ]);
    expect(diffLines('a\nb\n', 'a\nb\nx\n').hunks).toEqual([
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 3,
        lines: [context('a\n'), context('b\n'), added('x\n')],
      },
    ]);
  });

  it('gives a hunk without old or without new lines for an empty text', () => {
    expect(diffLines('', 'a\nb').hunks).toEqual([
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: 2,
        lines: [added('a\n'), added('b')],
      },
    ]);
    expect(diffLines('a\n', '').hunks).toEqual([
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 0,
        lines: [removed('a\n')],
      },
    ]);
  });

  it('counts a line with another ending as another line', () => {
    expect(diffLines('a\nb\n', 'a\r\nb\n').hunks[0]?.lines).toEqual([
      removed('a\n'),
      added('a\r\n'),
      context('b\n'),
    ]);
    expect(diffLines('a\nb', 'a\nb\n').hunks[0]?.lines).toEqual([
      context('a\n'),
      removed('b'),
      added('b\n'),
    ]);
  });

  it('puts the removed lines of a change before its added lines', () => {
    expect(diffLines('a\nb\n', 'c\nd\n').hunks[0]?.lines).toEqual([
      removed('a\n'),
      removed('b\n'),
      added('c\n'),
      added('d\n'),
    ]);
  });

  it('gives the diff frozen down to its lines', () => {
    const diff = diffLines('a\nb\n', 'a\nc\n');
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.hunks)).toBe(true);
    for (const hunk of diff.hunks) {
      expect(Object.isFrozen(hunk)).toBe(true);
      expect(Object.isFrozen(hunk.lines)).toBe(true);
      expect(hunk.lines.every((line) => Object.isFrozen(line))).toBe(true);
    }
    const whole = diffLines('', numberedText(1, maxDiffEdits + 1));
    expect(Object.isFrozen(whole.hunks)).toBe(true);
    expect(Object.isFrozen(whole.hunks[0]?.lines)).toBe(true);
  });
});

describe('the bounds of diffLines', () => {
  const whole = (before: string, after: string) => {
    const oldLines = before === '' ? [] : before.split(/(?<=\n)/u);
    const newLines = after === '' ? [] : after.split(/(?<=\n)/u);
    return {
      hunks: [
        {
          oldStart: 1,
          oldCount: oldLines.length,
          newStart: 1,
          newCount: newLines.length,
          lines: [...oldLines.map(removed), ...newLines.map(added)],
        },
      ],
      replaced: true,
    };
  };

  it('shows 2000 edits line by line and 2001 as the whole text replaced', () => {
    expect(maxDiffEdits).toBe(2_000);
    const before = numberedText(1, 1000, 'o');
    const exact = diffLines(before, numberedText(1, 1000, 'n'));
    expect(exact.replaced).toBe(false);
    expect(exact.hunks).toHaveLength(1);
    expect(exact.hunks[0]).toMatchObject({ oldCount: 1000, newCount: 1000 });

    const after = numberedText(1, 1001, 'n');
    expect(diffLines(before, after)).toEqual(whole(before, after));
  });

  it('replaces the whole text, also the lines both share, once past the bound', () => {
    const before = `same\n${numberedText(1, 1001, 'o')}`;
    const after = `same\n${numberedText(1, 1000, 'n')}`;
    const diff = diffLines(before, after);
    expect(diff).toEqual(whole(before, after));
    expect(diff.hunks[0]?.lines[0]).toEqual(removed('same\n'));
    expect(applyDiff(before, diff)).toBe(after);
  });

  it('adds 2000 lines to an empty text line by line and 2001 as replaced', () => {
    expect(diffLines('', numberedText(1, 2000)).replaced).toBe(false);
    const after = numberedText(1, 2001);
    expect(diffLines('', after)).toEqual(whole('', after));
    expect(diffLines(after, '')).toEqual(whole(after, ''));
  });

  it('compares 10000 lines between the common start and end and replaces 10001', () => {
    expect(maxDiffLines).toBe(10_000);
    // The first and the last line differ, so no line is common.
    const change = (text: string): string =>
      text.replace(/^l1\n/u, 'first\n').replace(/\nl(\d+)\n$/u, '\nlast\n');
    const exact = numberedText(1, 10_000);
    const diff = diffLines(exact, change(exact));
    expect(diff.replaced).toBe(false);
    expect(diff.hunks).toHaveLength(2);

    const over = numberedText(1, 10_001);
    expect(diffLines(over, change(over)).replaced).toBe(true);
    expect(diffLines(change(over), over).replaced).toBe(true);
  });

  it('counts no line of the common start and end against the bound', () => {
    const middle = numberedText(1, 10_000);
    const before = `${numberedText(1, 5000, 's')}${middle}${numberedText(1, 5000, 'e')}`;
    const after = before
      .replace('l1\n', 'first\n')
      .replace('l10000\n', 'last\n');
    const diff = diffLines(before, after);
    expect(diff.replaced).toBe(false);
    expect(applyDiff(before, diff)).toBe(after);
  });

  it('diffs pairs of 64 KiB built to keep the search busy in far less than a second', () => {
    // Texts of the most a page holds (ADR 0072). Lines of six letters keep
    // just under 10'000 lines in a text, so that the search runs, over
    // lines that repeat, with and without shifts, or at random, so that
    // many diagonals of the search run long. Measured in November 2026 on
    // a laptop: at most about 30 milliseconds each.
    const size = 65_536;
    const fill = (line: (index: number) => string): string => {
      const parts: string[] = [];
      let length = 0;
      for (let index = 0; length < size; index += 1) {
        const next = `${line(index)}\n`;
        parts.push(next);
        length += next.length;
      }
      return parts.join('').slice(0, size);
    };
    let state = 7;
    const coin = (): boolean => {
      state = (state * 48_271) % 2_147_483_647;
      return state < 1_073_741_824;
    };
    const every = (period: number, other: string) => (index: number) =>
      index % period === period - 1 ? other : 'cccccc';
    const random = fill(() => (coin() ? 'aaaaaa' : 'bbbbbb'));
    const pairs: [string, string, boolean][] = [
      ['\n'.repeat(size), `x${'\n'.repeat(size - 2)}y`, true],
      [fill(every(10, 'xxxxxx')), fill(every(10, 'yyyyyy')), false],
      [fill(every(9, 'xxxxxx')), fill(every(9, 'yyyyyy')), true],
      [
        fill(every(65, 'xxxxxx')),
        `cccccc\n${fill(every(65, 'yyyyyy'))}`,
        false,
      ],
      [random, fill(() => (coin() ? 'aaaaaa' : 'bbbbbb')), true],
      [
        random,
        splitLines(random)
          .map((line, index) => (index % 13 === 0 ? 'cccccc\n' : line))
          .join(''),
        false,
      ],
    ];
    for (const [before, after, replaced] of pairs) {
      const started = performance.now();
      const diff = diffLines(before, after);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(diff.replaced).toBe(replaced);
      expect(applyDiff(before, diff)).toBe(after);
    }
  });
});
