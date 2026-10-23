/**
 * Writes JSON Lines to stderr, synchronously and one line per system call
 * (ADR 0053, ADR 0054).
 *
 * @packageDocumentation
 */
import { writeSync as fsWriteSync } from 'node:fs';
import { isProxy } from 'node:util/types';

/** Writes one line. Implemented by the stderr writer and by fakes in tests. */
export interface LineWriter {
  /**
   * Writes the line followed by a line break. It never throws.
   *
   * @param line - One line of printable ASCII, without a line break.
   * @returns Whether the whole line was written.
   */
  write(line: string): boolean;
}

/** Counts of a stderr writer, as a frozen snapshot. */
export interface LineWriterStats {
  /** Lines written whole. */
  readonly written: number;
  /** Lines lost, in whole or in part. */
  readonly failed: number;
  /** Lost lines of which a part was written. */
  readonly partial: number;
  /** Lines refused because they were no line of printable ASCII. */
  readonly rejected: number;
  /** Lines refused because they came while a line was being written. */
  readonly reentrant: number;
  /** Whether stderr is gone for good, after EPIPE or EBADF. */
  readonly closed: boolean;
}

/** A {@link LineWriter} for stderr that counts what it could not write. */
export interface StderrLineWriter extends LineWriter {
  /**
   * Returns the counts.
   *
   * @returns A frozen snapshot.
   */
  stats(): LineWriterStats;
}

/** The shape of `writeSync` from `node:fs`, as the writer calls it. */
export type WriteSyncFn = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

/** Options of {@link createStderrWriter}. */
export interface StderrWriterOptions {
  /** Replaces `writeSync` from `node:fs`, for tests. */
  readonly writeSync?: WriteSyncFn;
  /** System calls per line at most, 1 to 16. */
  readonly maxAttempts?: number;
  /**
   * Whether stderr ends in a line without its line break, such as a start
   * notice that was cut off. The first line then starts with a line break,
   * so that it stands on a line of its own. Only `true` turns it on.
   */
  readonly afterTornLine?: boolean;
}

/** System calls per line, unless the options say otherwise. */
export const defaultMaxAttempts = 4;

/** The longest line the writer takes, in characters. */
export const maxLineLength = 65_536;

const encoder = new TextEncoder();

/**
 * Tells whether a value is one line the writers take: 1 to
 * {@link maxLineLength} characters of printable ASCII. A line break inside
 * would split a JSON line in two, and anything outside ASCII has no place
 * in a line of known fields. The writer of the audit file uses the same
 * rule (ADR 0028).
 *
 * @param value - Any value.
 * @returns Whether it is such a line.
 * @example
 * ```ts
 * isWritableLine('{"v":1}'); // true
 * isWritableLine('a\nb'); // false
 * ```
 */
export const isWritableLine = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > maxLineLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
};

// The code of a failed system call, read without running code of the
// thrown value.
const codeOf = (error: unknown): unknown => {
  try {
    if (typeof error !== 'object' || error === null || isProxy(error)) {
      return undefined;
    }
    const property = Object.getOwnPropertyDescriptor(error, 'code');
    return property !== undefined && Object.hasOwn(property, 'value')
      ? property.value
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Creates the writer for stderr. Each line takes one `writeSync` on fd 2
 * with the line break in the same call, so that no other write can come
 * between line and break. A partial write is continued at its offset. After
 * `maxAttempts` calls without the whole line, the line counts as failed and
 * the next one starts with a line break, so that it stands on a line of its
 * own. EAGAIN is tried again at once, without waiting: a reader that does
 * not drain stderr costs lines, not time. EPIPE and EBADF close the writer
 * for good. Nothing is ever thrown and nothing is written about a failure.
 * With `afterTornLine`, the first line starts with a line break in the same
 * way, after a line of another writer that lost its break, such as a start
 * notice.
 *
 * The writer never touches `process.stderr`, and its module loads neither
 * node:util nor node:process: each makes fd 2 non-blocking (ADR 0054).
 *
 * @param options - Replacement for `writeSync`, the number of attempts and
 *   whether stderr ends in a torn line.
 * @returns The writer.
 * @throws {TypeError} If `maxAttempts` is not a whole number from 1 to 16.
 * @example
 * ```ts
 * const writer = createStderrWriter();
 * writer.write('{"level":"info","event":"started"}');
 * ```
 */
export function createStderrWriter(
  options: StderrWriterOptions = {},
): StderrLineWriter {
  const writeSync = options.writeSync ?? fsWriteSync;
  const maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
  if (
    typeof writeSync !== 'function' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 16
  ) {
    throw new TypeError(
      'The writer needs a writeSync function and 1 to 16 attempts.',
    );
  }
  let written = 0;
  let failed = 0;
  let partial = 0;
  let rejected = 0;
  let reentrant = 0;
  let closed = false;
  let writing = false;
  // A torn line before the first one is repaired like a part of an own
  // line that was lost.
  let broken = options.afterTornLine === true;

  // Bytes sent before the attempts ran out.
  const send = (bytes: Uint8Array): number => {
    let offset = 0;
    for (
      let attempt = 0;
      attempt < maxAttempts && offset < bytes.length && !closed;
      attempt += 1
    ) {
      const rest = bytes.length - offset;
      try {
        // Exactly four arguments: a position, even 0, fails with ESPIPE on a
        // pipe and writes over the start of a file.
        const count = writeSync(2, bytes, offset, rest);
        // A count outside its contract counts as no progress.
        if (Number.isInteger(count) && count > 0 && count <= rest) {
          offset += count;
        }
      } catch (error) {
        const code = codeOf(error);
        if (code === 'EPIPE' || code === 'EBADF') closed = true;
        else if (code !== 'EAGAIN') break;
      }
    }
    return offset;
  };

  const write = (line: string): boolean => {
    if (writing) {
      reentrant += 1;
      return false;
    }
    writing = true;
    try {
      if (!isWritableLine(line)) {
        rejected += 1;
        return false;
      }
      if (closed) {
        failed += 1;
        return false;
      }
      const repair = broken ? 1 : 0;
      const bytes = encoder.encode(`${broken ? '\n' : ''}${line}\n`);
      const sent = send(bytes);
      if (sent === bytes.length) {
        written += 1;
        broken = false;
        return true;
      }
      failed += 1;
      if (sent > repair) {
        // Part of the line went out: the next one needs a break first.
        partial += 1;
        broken = true;
      } else if (sent === repair) {
        // At most the break that repairs the framing went out, nothing of
        // the line itself.
        broken = false;
      }
      return false;
    } catch {
      failed += 1;
      return false;
    } finally {
      writing = false;
    }
  };

  const stats = (): LineWriterStats =>
    Object.freeze({ written, failed, partial, rejected, reentrant, closed });

  return Object.freeze({ write, stats });
}
