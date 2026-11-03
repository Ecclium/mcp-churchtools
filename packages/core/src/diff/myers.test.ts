import { describe, expect, it } from 'vitest';

import { editScript, type EditStep } from './myers.js';

const bounds = { depth: 1_000, lines: 10_000 };

const of = (...values: number[]): Int32Array => Int32Array.from(values);

// Lines that occur once, numbered from a start, so that two such lists
// share no line.
const distinct = (from: number, count: number): Int32Array =>
  Int32Array.from({ length: count }, (_, index) => from + index);

const editsOf = (script: readonly EditStep[] | undefined): number =>
  (script ?? []).reduce((sum, step) => sum + step.removed + step.added, 0);

describe('editScript', () => {
  it('finds the script of the example', () => {
    expect(editScript(of(1, 2, 3), of(1, 3), bounds)).toEqual([
      { equal: 1, removed: 1, added: 0 },
      { equal: 1, removed: 0, added: 0 },
    ]);
  });

  it('gives one step without changes for equal or empty lists', () => {
    expect(editScript(of(), of(), bounds)).toEqual([
      { equal: 0, removed: 0, added: 0 },
    ]);
    expect(editScript(of(1, 2), of(1, 2), bounds)).toEqual([
      { equal: 2, removed: 0, added: 0 },
    ]);
  });

  it('gathers all removals and additions of one change in one step', () => {
    expect(editScript(of(1, 2, 3), of(4, 5, 6), bounds)).toEqual([
      { equal: 0, removed: 3, added: 3 },
    ]);
    expect(editScript(of(7, 1, 2, 7), of(7, 3, 7), bounds)).toEqual([
      { equal: 1, removed: 2, added: 1 },
      { equal: 1, removed: 0, added: 0 },
    ]);
  });

  it('finds a shortest script where lines repeat', () => {
    // The longest common part is 2 1 2 1, so two edits suffice.
    expect(
      editsOf(editScript(of(1, 2, 1, 2, 1), of(2, 1, 2, 1, 2), bounds)),
    ).toBe(2);
    expect(
      editsOf(editScript(of(1, 1, 2, 1, 1), of(1, 2, 1, 1, 1, 2), bounds)),
    ).toBe(3);
  });

  it('searches no script of more than twice the depth in edits', () => {
    const shallow = { depth: 2, lines: 100 };
    // Four edits, an even and an odd difference of lengths.
    expect(editsOf(editScript(of(1, 2), of(3, 4), shallow))).toBe(4);
    expect(editsOf(editScript(of(1, 2, 3), of(4), shallow))).toBe(4);
    // Five and six: the search runs to its depth and gives up.
    expect(editScript(of(1, 2, 3), of(4, 5), shallow)).toBeUndefined();
    expect(editScript(of(1, 2, 3), of(4, 5, 6), shallow)).toBeUndefined();
  });

  it('gives up at once when the lengths alone need more edits', () => {
    const shallow = { depth: 2, lines: 100 };
    expect(editScript(of(), of(1, 2, 3, 4), shallow)).toEqual([
      { equal: 0, removed: 0, added: 4 },
    ]);
    expect(editScript(of(), of(1, 2, 3, 4, 5), shallow)).toBeUndefined();
    expect(editScript(of(1, 2, 3, 4, 5), of(), shallow)).toBeUndefined();
  });

  it('finds 2000 edits at the depth of 1000 and no more', () => {
    expect(
      editsOf(editScript(distinct(0, 1000), distinct(5000, 1000), bounds)),
    ).toBe(2000);
    expect(
      editsOf(editScript(distinct(0, 999), distinct(5000, 1001), bounds)),
    ).toBe(2000);
    expect(
      editScript(distinct(0, 1001), distinct(5000, 1000), bounds),
    ).toBeUndefined();
    expect(
      editScript(distinct(0, 1001), distinct(5000, 1001), bounds),
    ).toBeUndefined();
  });

  it('compares no more lines of either list than the bound, between their common start and end', () => {
    const narrow = { depth: 10, lines: 3 };
    expect(
      editsOf(editScript(of(9, 1, 2, 3, 9), of(9, 4, 5, 6, 9), narrow)),
    ).toBe(6);
    expect(
      editScript(of(9, 1, 2, 3, 4, 9), of(9, 5, 6, 7, 9), narrow),
    ).toBeUndefined();
    expect(
      editScript(of(9, 1, 2, 3, 9), of(9, 5, 6, 7, 8, 9), narrow),
    ).toBeUndefined();
    // The common start and end do not count.
    const long = of(8, 8, 8, 8, 1, 2, 3, 8, 8, 8, 8);
    expect(editsOf(editScript(long, of(8, 8, 8, 8, 8, 8, 8, 8), narrow))).toBe(
      3,
    );
  });

  it('gives the steps frozen', () => {
    const script = editScript(of(1, 2), of(2, 3), bounds);
    expect(Object.isFrozen(script)).toBe(true);
    expect(script?.every((step) => Object.isFrozen(step))).toBe(true);
  });
});
