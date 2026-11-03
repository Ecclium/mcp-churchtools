/**
 * The line diff of core (ADR 0031): Myers' algorithm over lines that keep
 * their line endings, bounded in edits and lines, with hunks of three
 * lines of context as data, a function that applies a diff to the old
 * text and a renderer to plain lines. `ecclium undo` shows with it what
 * taking a write back changes.
 *
 * @packageDocumentation
 */
export { applyDiff } from './apply.js';
export {
  type DiffHunk,
  type DiffLine,
  type DiffLineKind,
  diffContextLines,
  diffLines,
  type LineDiff,
  maxDiffEdits,
  maxDiffLines,
} from './diff.js';
export { splitLines } from './lines.js';
export { crLfMarker, noLineEndMarker, renderDiff } from './render.js';
