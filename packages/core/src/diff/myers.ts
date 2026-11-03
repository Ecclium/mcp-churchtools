/**
 * The search of the line diff (ADR 0031): Myers' algorithm for a shortest
 * edit script, in the variant of linear space from the same paper (Eugene
 * W. Myers, «An O(ND) Difference Algorithm and Its Variations», 1986). It
 * searches from both ends at once for the middle snake, the run of equal
 * lines in the middle of a shortest script, splits both texts there and
 * solves the two halves the same way.
 *
 * Where it stands in the way of a write: `ecclium undo` shows the operator
 * what taking a write back changes before it writes, and confirmations
 * and approvals will show such a diff too. The diff in `diff.ts` gives this
 * search the lines of both texts as numbers, one per distinct line, so
 * that a comparison is one of two integers and never one of two strings.
 *
 * The variant of linear space keeps two arrays of positions, sized by the
 * bound on the edits, for the whole search, where the plain variant keeps
 * the positions of every step for the way back, about two million numbers
 * at 2'000 edits. The time is that of Myers either way, about the lines
 * left between the common start and end times the edits.
 *
 * @packageDocumentation
 */

/**
 * One step of an edit script: lines that stay, then lines of the old text
 * that go and lines of the new text that come in their place. Only the
 * last step has neither, when the texts end with lines that stay or are
 * both empty.
 */
export interface EditStep {
  /** How many lines stay before the change. */
  readonly equal: number;
  /** How many lines of the old text go, right after them. */
  readonly removed: number;
  /** How many lines of the new text come in their place. */
  readonly added: number;
}

/** How far {@link editScript} may search. */
export interface EditBounds {
  /**
   * The most steps of the search from either end. A script of more than
   * twice as many edits, removed and added lines together, is not
   * searched for.
   */
  readonly depth: number;
  /**
   * The most lines of either text between the lines both texts share at
   * their start and at their end, which the search does not look at.
   */
  readonly lines: number;
}

// The run of equal lines in the middle of a shortest script, from
// (x, y) to (u, v), as positions in the old and the new lines.
interface Snake {
  readonly x: number;
  readonly y: number;
  readonly u: number;
  readonly v: number;
}

// A position the search wrote in an earlier step. The loops read only the
// diagonals of the step before and the two the start sets, all inside the
// array, so the value is always a number.
const at = (positions: Int32Array, index: number): number =>
  positions[index] as number;

/**
 * Finds a shortest edit script from one list of lines to another, with
 * every removal before the additions of the same change.
 *
 * @param before - The lines of the old text, one number per distinct line.
 * @param after - The lines of the new text, numbered the same way.
 * @param bounds - How far the search may go, see {@link EditBounds}.
 * @returns The steps, frozen, or `undefined` when the script needs more
 *   than twice `bounds.depth` edits or more than `bounds.lines` lines of
 *   either text are left between their common start and end.
 * @example
 * ```ts
 * editScript(Int32Array.of(1, 2, 3), Int32Array.of(1, 3), {
 *   depth: 1_000,
 *   lines: 10_000,
 * });
 * // [{ equal: 1, removed: 1, added: 0 }, { equal: 1, removed: 0, added: 0 }]
 * ```
 */
export function editScript(
  before: Int32Array,
  after: Int32Array,
  bounds: EditBounds,
): readonly EditStep[] | undefined {
  const { depth } = bounds;
  // Every script has at least as many edits as the texts differ in lines.
  if (Math.abs(before.length - after.length) > 2 * depth) return undefined;

  // The lines both boxes share at their start and at their end.
  const common = (
    left: number,
    right: number,
    top: number,
    bottom: number,
  ): { readonly start: number; readonly end: number } => {
    let start = 0;
    while (
      left + start < right &&
      top + start < bottom &&
      before[left + start] === after[top + start]
    ) {
      start += 1;
    }
    let end = 0;
    while (
      right - end > left + start &&
      bottom - end > top + start &&
      before[right - end - 1] === after[bottom - end - 1]
    ) {
      end += 1;
    }
    return { start, end };
  };

  const outer = common(0, before.length, 0, after.length);
  const outside = outer.start + outer.end;
  if (
    before.length - outside > bounds.lines ||
    after.length - outside > bounds.lines
  ) {
    return undefined;
  }

  // The positions of the search: forward the furthest x on each diagonal
  // k = x - y, backward the least x on each diagonal counted from the end
  // of the box. One pair for every box, as one box is searched at a time.
  const offset = depth + 1;
  const forward = new Int32Array(2 * depth + 3);
  const backward = new Int32Array(2 * depth + 3);

  // The middle snake of a box whose texts both have lines and differ in
  // their first and in their last line, or `undefined` when it lies
  // deeper than the bound.
  const middleSnake = (
    left: number,
    right: number,
    top: number,
    bottom: number,
  ): Snake | undefined => {
    const delta = right - left - (bottom - top);
    const odd = (delta & 1) === 1;
    forward[offset + 1] = left;
    backward[offset - 1] = right;
    for (let d = 0; d <= depth; d += 1) {
      for (let k = -d; k <= d; k += 2) {
        // Down from the diagonal above or right from the one below,
        // whichever reached further.
        let x =
          k === -d ||
          (k !== d && at(forward, offset + k - 1) < at(forward, offset + k + 1))
            ? at(forward, offset + k + 1)
            : at(forward, offset + k - 1) + 1;
        let y = top + (x - left) - k;
        const startX = x;
        const startY = y;
        while (x < right && y < bottom && before[x] === after[y]) {
          x += 1;
          y += 1;
        }
        forward[offset + k] = x;
        // With an odd difference the paths meet on a forward step.
        const c = k - delta;
        if (odd && c > -d && c < d && x >= at(backward, offset + c)) {
          return { x: startX, y: startY, u: x, v: y };
        }
      }
      for (let c = -d; c <= d; c += 2) {
        // Up from the diagonal below or left from the one above,
        // whichever reached further back.
        const k = c + delta;
        let x =
          c === d ||
          (c !== -d &&
            at(backward, offset + c - 1) < at(backward, offset + c + 1))
            ? at(backward, offset + c - 1)
            : at(backward, offset + c + 1) - 1;
        let y = top + (x - left) - k;
        const endX = x;
        const endY = y;
        while (x > left && y > top && before[x - 1] === after[y - 1]) {
          x -= 1;
          y -= 1;
        }
        backward[offset + c] = x;
        // With an even difference the paths meet on a backward step.
        if (!odd && k >= -d && k <= d && x <= at(forward, offset + k)) {
          return { x, y, u: endX, v: endY };
        }
      }
    }
    return undefined;
  };

  // The script as it grows: the step that is open, and the steps before.
  // A change gathers all its removals and additions, however the search
  // reaches them.
  const steps: EditStep[] = [];
  let equal = 0;
  let removed = 0;
  let added = 0;
  const keep = (count: number): void => {
    if (count === 0) return;
    if (removed + added > 0) {
      steps.push(Object.freeze({ equal, removed, added }));
      equal = 0;
      removed = 0;
      added = 0;
    }
    equal += count;
  };

  // Appends the script of a box and says whether it kept to the depth.
  // Only the box of the whole texts can go deeper: each half of a split
  // needs at most half the edits of its box, and the search finds them in
  // half the steps. Were it ever otherwise, the diff would show the whole
  // text as replaced, which is still right.
  const solve = (
    left: number,
    right: number,
    top: number,
    bottom: number,
  ): boolean => {
    const { start, end } = common(left, right, top, bottom);
    keep(start);
    const x0 = left + start;
    const x1 = right - end;
    const y0 = top + start;
    const y1 = bottom - end;
    // A box with one empty text: only removals or only additions. A box
    // with one edit is always such a box once its common lines are off.
    if (x0 === x1 || y0 === y1) {
      removed += x1 - x0;
      added += y1 - y0;
      keep(end);
      return true;
    }
    const snake = middleSnake(x0, x1, y0, y1);
    if (snake === undefined) return false;
    const head = solve(x0, snake.x, y0, snake.y);
    keep(snake.u - snake.x);
    const tail = head && solve(snake.u, x1, snake.v, y1);
    keep(end);
    return tail;
  };

  if (!solve(0, before.length, 0, after.length)) return undefined;
  steps.push(Object.freeze({ equal, removed, added }));
  return Object.freeze(steps);
}
