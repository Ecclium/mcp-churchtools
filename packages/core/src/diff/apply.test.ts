import { describe, expect, it } from 'vitest';

import { applyDiff } from './apply.js';
import { type DiffHunk, diffLines, type LineDiff } from './diff.js';

const misfit = 'The diff does not fit the text.';

// The diff with its first hunk changed, for the refusals.
const withHunk = (diff: LineDiff, change: Partial<DiffHunk>): LineDiff => ({
  ...diff,
  hunks: diff.hunks.map((hunk, index) =>
    index === 0 ? { ...hunk, ...change } : hunk,
  ),
});

describe('applyDiff', () => {
  it('builds the new text from the old one', () => {
    const pairs: [string, string][] = [
      ['a\nb\n', 'a\nc\n'],
      ['', 'a\r\nb'],
      ['a\nb', ''],
      ['a\nb', 'a\nb\n'],
      ['1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', '1\n2\nX\n4\n5\n6\n7\n8\nY\n10\n'],
    ];
    for (const [before, after] of pairs) {
      expect(applyDiff(before, diffLines(before, after))).toBe(after);
    }
  });

  it('keeps the text as it is for a diff without hunks', () => {
    expect(applyDiff('a\r\nb', { hunks: [], replaced: false })).toBe('a\r\nb');
  });

  it('refuses a diff whose lines are not those of the text', () => {
    // A removed line and a line of context that differ, and a text that
    // ends before the hunk does.
    expect(() =>
      applyDiff('a\nb\nc\n', diffLines('a\nX\nc\n', 'a\nY\nc\n')),
    ).toThrow(misfit);
    expect(() => applyDiff('z\nb\n', diffLines('a\nb\n', 'a\nc\n'))).toThrow(
      misfit,
    );
    expect(() => applyDiff('', diffLines('a\n', 'b\n'))).toThrow(misfit);
  });

  it('refuses a hunk at a place that is no line', () => {
    const diff = diffLines('a\nb\n', 'a\nb\nc\n');
    for (const oldStart of [Number.NaN, 1.5, 0, 4]) {
      expect(() => applyDiff('a\nb\n', withHunk(diff, { oldStart }))).toThrow(
        misfit,
      );
    }
    // Only added lines, past the end of the text.
    const insert = diffLines('', 'c\n');
    expect(() =>
      applyDiff('a\nb\n', withHunk(insert, { oldStart: 4 })),
    ).toThrow(misfit);
  });

  it('refuses a hunk that starts inside the one before it', () => {
    const diff = diffLines('a\nb\n', 'a\nc\n');
    const hunk = diff.hunks[0] as DiffHunk;
    expect(() =>
      applyDiff('a\nb\n', { hunks: [hunk, hunk], replaced: false }),
    ).toThrow(misfit);
  });

  it('refuses a hunk whose start in the new text or whose counts do not match', () => {
    const diff = diffLines('a\nb\n', 'a\nc\n');
    const hunk = diff.hunks[0] as DiffHunk;
    for (const change of [
      { newStart: hunk.newStart + 1 },
      { oldCount: hunk.oldCount + 1 },
      { newCount: hunk.newCount - 1 },
    ]) {
      expect(() => applyDiff('a\nb\n', withHunk(diff, change))).toThrow(misfit);
    }
  });

  it('names no text in its refusal', () => {
    let message = '';
    try {
      applyDiff('secret\n', diffLines('other\n', 'x\n'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(misfit);
  });
});
