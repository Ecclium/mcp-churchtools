import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applyDiff,
  crLfMarker,
  diffContextLines,
  diffLines,
  type LineDiff,
  maxDiffEdits,
  noLineEndMarker,
  renderDiff,
  splitLines,
} from './index.js';

// Generated pairs of texts (ADR 0031, ADR 0070): the diff of every pair
// leads from the old text to exactly the new one, is a shortest one, and
// keeps the form of its hunks, not only for the examples of the other
// tests. A fixed seed keeps the runs the same in CI.

const seed = 31_001;
const run = { seed, numRuns: 300 };

// Few distinct bodies, so that lines repeat and the search has to choose,
// with a lone carriage return and a space among them.
const body = fc.constantFrom('a', 'b', 'c', '', 'a b', 'ä', 'x\ry', '\\');
const ending = fc.constantFrom('\n', '\r\n');
const lastEnding = fc.constantFrom('\n', '\r\n', '');

const linesOf = (maxLength: number, minLength = 0) =>
  fc.array(fc.tuple(body, ending), { minLength, maxLength });

const textOf = (
  lines: readonly (readonly [string, string])[],
  last: string,
): string =>
  lines
    .map(
      ([text, end], index) => text + (index === lines.length - 1 ? last : end),
    )
    .join('');

const text = (maxLength: number) =>
  fc
    .tuple(linesOf(maxLength), lastEnding)
    .map(([lines, last]) => textOf(lines, last));

// A new text made from the old one by a few edits at random places, as a
// change of a page makes it.
const edited = (maxLength: number, minLength = 0) =>
  fc
    .tuple(
      linesOf(maxLength, minLength),
      lastEnding,
      fc.array(
        fc.tuple(
          fc.nat(),
          fc.constantFrom('insert', 'remove', 'replace'),
          fc.tuple(body, ending),
        ),
        { maxLength: 8 },
      ),
      lastEnding,
    )
    .map(([lines, last, edits, newLast]) => {
      const after = [...lines];
      for (const [place, edit, line] of edits) {
        const at = after.length === 0 ? 0 : place % (after.length + 1);
        if (edit === 'insert') after.splice(at, 0, line);
        else if (edit === 'remove') after.splice(at, 1);
        else after.splice(at, 1, line);
      }
      return [textOf(lines, last), textOf(after, newLast)] as const;
    });

const pairs = (maxLength: number) =>
  fc.oneof(fc.tuple(text(maxLength), text(maxLength)), edited(maxLength));

const editsOf = (diff: LineDiff): number =>
  diff.hunks.reduce(
    (sum, hunk) =>
      sum + hunk.lines.filter((line) => line.kind !== 'context').length,
    0,
  );

// The length of a longest common subsequence of lines, by the table of
// dynamic programming: slow, but plainly right.
const commonLength = (
  before: readonly string[],
  after: readonly string[],
): number => {
  let row: number[] = Array.from({ length: after.length + 1 }, () => 0);
  for (const line of before) {
    const next = [0];
    for (const [index, other] of after.entries()) {
      next.push(
        line === other
          ? (row[index] ?? 0) + 1
          : Math.max(row[index + 1] ?? 0, next[index] ?? 0),
      );
    }
    row = next;
  }
  return row[after.length] ?? 0;
};

describe('the lines of a text', () => {
  it('join to the text again, each ending with its only line break', () => {
    fc.assert(
      fc.property(text(40), (value) => {
        const lines = splitLines(value);
        expect(lines.join('')).toBe(value);
        for (const [index, line] of lines.entries()) {
          expect(line).not.toBe('');
          const breaks = line.split('\n').length - 1;
          expect(breaks).toBe(
            index === lines.length - 1 && !line.endsWith('\n') ? 0 : 1,
          );
          if (breaks === 1) expect(line.endsWith('\n')).toBe(true);
        }
      }),
      run,
    );
  });
});

describe('the line diff', () => {
  it('leads from the old text to exactly the new one', () => {
    fc.assert(
      fc.property(pairs(40), ([before, after]) => {
        const diff = diffLines(before, after);
        expect(diff.replaced).toBe(false);
        expect(applyDiff(before, diff)).toBe(after);
      }),
      run,
    );
  });

  it('gives no hunk for equal texts', () => {
    fc.assert(
      fc.property(text(40), (value) => {
        expect(diffLines(value, value)).toEqual({ hunks: [], replaced: false });
      }),
      run,
    );
  });

  it('is a shortest one', () => {
    fc.assert(
      fc.property(pairs(25), ([before, after]) => {
        const oldLines = splitLines(before);
        const newLines = splitLines(after);
        expect(editsOf(diffLines(before, after))).toBe(
          oldLines.length +
            newLines.length -
            2 * commonLength(oldLines, newLines),
        );
      }),
      run,
    );
  });

  it('keeps the form of its hunks', () => {
    fc.assert(
      fc.property(pairs(40), ([before, after]) => {
        const diff = diffLines(before, after);
        let previousEnd: number | undefined;
        for (const hunk of diff.hunks) {
          const { lines } = hunk;
          // Counts as the lines say, and at least one line after the hunk
          // before.
          expect(lines.filter((line) => line.kind !== 'added')).toHaveLength(
            hunk.oldCount,
          );
          expect(lines.filter((line) => line.kind !== 'removed')).toHaveLength(
            hunk.newCount,
          );
          if (previousEnd !== undefined) {
            expect(hunk.oldStart).toBeGreaterThan(previousEnd + 1);
          }
          const oldEnd = hunk.oldStart + hunk.oldCount - 1;
          previousEnd = oldEnd;
          // At least one change, removed lines before added ones, at most
          // three lines of context at either end and at most six between
          // two changes.
          const kinds = lines.map((line) => line.kind[0]).join('');
          expect(kinds).toMatch(
            /^c{0,3}(?:r+a*|a+)(?:c{1,6}(?:r+a*|a+))*c{0,3}$/u,
          );
          // The context reaches the start or end of the text, or is full.
          const lead = /^c*/u.exec(kinds)?.[0].length ?? 0;
          const tail = /c*$/u.exec(kinds)?.[0].length ?? 0;
          if (lead < diffContextLines) expect(hunk.oldStart).toBe(1);
          if (tail < diffContextLines) {
            expect(oldEnd).toBe(splitLines(before).length);
          }
        }
      }),
      run,
    );
  });

  it('renders one header per hunk and one line per line, with its marker', () => {
    fc.assert(
      fc.property(pairs(40), ([before, after]) => {
        const diff = diffLines(before, after);
        const expected: string[] = [];
        for (const hunk of diff.hunks) {
          expected.push(
            `@@ -${String(hunk.oldCount === 0 ? hunk.oldStart - 1 : hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newCount === 0 ? hunk.newStart - 1 : hunk.newStart)},${String(hunk.newCount)} @@`,
          );
          for (const line of hunk.lines) {
            const prefix = { context: ' ', removed: '-', added: '+' }[
              line.kind
            ];
            const end = /\r?\n$/u.exec(line.text)?.[0] ?? '';
            expected.push(
              prefix + line.text.slice(0, line.text.length - end.length),
            );
            if (end === '') expected.push(noLineEndMarker);
            if (end === '\r\n') expected.push(crLfMarker);
          }
        }
        expect(renderDiff(diff)).toEqual(expected);
      }),
      run,
    );
  });
});

describe('the line diff of long texts', () => {
  const long = { seed, numRuns: 25 };

  it('leads from the old text to exactly the new one', () => {
    fc.assert(
      fc.property(edited(3000, 1000), ([before, after]) => {
        expect(applyDiff(before, diffLines(before, after))).toBe(after);
      }),
      long,
    );
  });

  it('replaces the whole text past the bound and still leads to the new one', () => {
    // Lines that occur once, so that every one of them is an edit.
    const distinct = (prefix: string, count: number, last: string): string =>
      Array.from(
        { length: count },
        (_, index) =>
          `${prefix}${String(index)}${index === count - 1 ? last : '\n'}`,
      ).join('');
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 * maxDiffEdits }),
        fc.integer({ min: 0, max: 2 * maxDiffEdits }),
        lastEnding,
        lastEnding,
        (oldCount, newCount, oldLast, newLast) => {
          fc.pre(oldCount + newCount > maxDiffEdits);
          const before = distinct('o', oldCount, oldLast);
          const after = distinct('n', newCount, newLast);
          const diff = diffLines(before, after);
          expect(diff.replaced).toBe(true);
          expect(diff.hunks).toHaveLength(1);
          expect(applyDiff(before, diff)).toBe(after);
        },
      ),
      long,
    );
  });
});
