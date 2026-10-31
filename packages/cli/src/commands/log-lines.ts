/**
 * Reads the lines of a log for `ecclium audit verify --log` (ADR 0028): a
 * file the operator names, such as the log a client keeps of stderr, or
 * stdin for `-`, so that `docker logs` or several rotated files can be
 * piped in. It reads in pieces of a fixed size and never holds more than
 * one line; a line longer than an anchor can be is skipped whole. It never
 * names the path in what it returns.
 *
 * @packageDocumentation
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isProxy } from 'node:util/types';

/** What the reader of a log learns about an open descriptor. */
export interface LogStats {
  isDirectory(): boolean;
}

/** The file functions the reader of a log uses, replaced in tests. */
export interface LogFileSystem {
  readonly openSync: (path: string, flags: number) => number;
  readonly fstatSync: (fd: number) => LogStats;
  readonly readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => number;
  readonly closeSync: (fd: number) => void;
  /** Waits a moment before stdin is read again after EAGAIN. */
  readonly pause: () => void;
}

/** The name that stands for stdin. */
export const stdinName = '-';

/** The bytes the reader asks for in one call. */
export const logChunkSize = 65_536;

/** How often stdin is read again after EAGAIN before the reader gives up. */
export const maxWaits = 6_000;

const nodeFileSystem: LogFileSystem = Object.freeze({
  openSync: (path: string, flags: number) => openSync(path, flags),
  fstatSync,
  readSync,
  closeSync,
  // Atomics.wait sleeps 10 ms without a busy loop, on a buffer of its own
  // for each wait, so that no state stays at module level.
  pause: () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  },
});

const lineBreak = 0x0a;
const carriageReturn = 0x0d;

// The code of a failed system call, without running code of the thrown
// value.
const errorCode = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(error, 'code')?.value;
};

/**
 * Reads a log line by line. The last line counts also without a line
 * break, and a carriage return before a break is dropped. Bytes that are
 * no UTF-8 become replacement characters: the line still counts, an
 * anchor in it does not.
 *
 * @param source - The path of the log, or `-` for stdin.
 * @param maxLineLength - The longest line passed on; longer ones are
 *   skipped whole.
 * @param onLine - Gets each line, without its line break.
 * @param fs - The file functions, only for tests.
 * @returns Whether the whole log was read: false when it could not be
 *   opened or read, or names a folder.
 * @example
 * ```ts
 * readLogLines('-', maxLogLineLength, (line) => collector.add(line));
 * ```
 */
export function readLogLines(
  source: string,
  maxLineLength: number,
  onLine: (line: string) => void,
  fs: LogFileSystem = nodeFileSystem,
): boolean {
  const fromStdin = source === stdinName;
  let fd: number;
  try {
    // Without O_NONBLOCK: a pipe such as <(…) is read as it fills.
    fd = fromStdin ? 0 : fs.openSync(source, constants.O_RDONLY);
  } catch {
    return false;
  }
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(logChunkSize);
  // The current line in one buffer that grows by doubling up to the limit
  // and one byte more, for a carriage return, so that a pipe that hands
  // over a byte at a time costs no more memory than a file. A line beyond
  // the limit is dropped while it is read.
  const current = { bytes: new Uint8Array(1_024), length: 0, skipping: false };

  const finish = (): void => {
    if (!current.skipping) {
      const bytes = current.bytes.subarray(0, current.length);
      const end =
        bytes.length > 0 && bytes[bytes.length - 1] === carriageReturn
          ? bytes.length - 1
          : bytes.length;
      onLine(decoder.decode(bytes.subarray(0, end)));
    }
    current.length = 0;
    current.skipping = false;
  };

  const take = (part: Uint8Array): void => {
    if (current.skipping) return;
    const length = current.length + part.length;
    if (length > maxLineLength + 1) {
      current.skipping = true;
      return;
    }
    if (length > current.bytes.length) {
      let size = current.bytes.length * 2;
      while (size < length) size *= 2;
      const grown = new Uint8Array(Math.min(size, maxLineLength + 1));
      grown.set(current.bytes.subarray(0, current.length));
      current.bytes = grown;
    }
    current.bytes.set(part, current.length);
    current.length = length;
  };

  try {
    if (!fromStdin && fs.fstatSync(fd).isDirectory()) return false;
    let waits = 0;
    for (;;) {
      let count: number;
      try {
        count = fs.readSync(fd, buffer, 0, buffer.length, null);
      } catch (error) {
        // stdin can be a descriptor without blocking, as a parent left it.
        if (errorCode(error) === 'EAGAIN' && waits < maxWaits) {
          waits += 1;
          fs.pause();
          continue;
        }
        return false;
      }
      if (!Number.isInteger(count) || count < 0 || count > buffer.length) {
        return false;
      }
      if (count === 0) break;
      waits = 0;
      const chunk = buffer.subarray(0, count);
      let start = 0;
      for (
        let index = chunk.indexOf(lineBreak);
        index >= 0;
        index = chunk.indexOf(lineBreak, start)
      ) {
        take(chunk.subarray(start, index));
        finish();
        start = index + 1;
      }
      take(chunk.subarray(start));
    }
    if (current.length > 0) finish();
    return true;
  } catch {
    return false;
  } finally {
    if (!fromStdin) {
      try {
        fs.closeSync(fd);
      } catch {
        // The log was only read.
      }
    }
  }
}
