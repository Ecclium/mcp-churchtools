/**
 * Writes the output of the command line for operators, line by line with
 * `writeSync` on fd 1 and fd 2. It never touches `process.stdout` or
 * `process.stderr`, whose streams can buffer, reorder or turn a descriptor
 * non-blocking (ADR 0053, ADR 0054).
 *
 * @packageDocumentation
 */
import { writeSync as fsWriteSync } from 'node:fs';

import { isTextLine, sendAll, type WriteSyncFn } from '../send.js';

/** Where a line of the command line goes. */
export interface Output {
  /**
   * Writes one line to stdout, followed by a line break.
   *
   * @param text - One line for a terminal.
   * @returns Whether the whole line was written.
   */
  readonly stdout: (text: string) => boolean;
  /**
   * Writes one line to stderr, followed by a line break.
   *
   * @param text - One line for a terminal.
   * @returns Whether the whole line was written.
   */
  readonly stderr: (text: string) => boolean;
}

/** Options of {@link createOutput}. */
export interface OutputOptions {
  /** Replaces `writeSync` from `node:fs`, for tests. */
  readonly writeSync?: WriteSyncFn;
}

/** The longest line, in characters. */
export const maxOutputLength = 4000;

const encoder = new TextEncoder();

const lineBreak = encoder.encode('\n');

/**
 * Makes the output of one run of the command line. A line that is no
 * single line for a terminal is not written, as a tripwire. A partial
 * write is continued, and after EPIPE or EBADF that stream gets nothing
 * more. A line that stays cut off gets one attempt at a line break, and
 * that stream gets nothing more either, so no later line continues it.
 * It never throws for a failed write.
 *
 * @param options - A replacement for `writeSync`, for tests.
 * @returns The output, frozen.
 * @throws {TypeError} When writeSync is no function.
 * @example
 * ```ts
 * const output = createOutput();
 * output.stdout('Die Konfiguration ist gültig.');
 * ```
 */
export function createOutput(options: OutputOptions = {}): Output {
  const writeSync = options.writeSync ?? fsWriteSync;
  if (typeof writeSync !== 'function') {
    throw new TypeError('The output needs a writeSync function.');
  }
  // Per output, so that one closed stream does not end the other.
  const closed = { stdout: false, stderr: false };

  const line = (text: string): Uint8Array | undefined =>
    isTextLine(text, maxOutputLength) ? encoder.encode(`${text}\n`) : undefined;

  const send = (
    stream: 'stdout' | 'stderr',
    write: (buffer: Uint8Array, offset: number, length: number) => number,
    text: string,
  ): boolean => {
    const bytes = line(text);
    if (bytes === undefined || closed[stream]) return false;
    const result = sendAll(bytes, write);
    if (result.sent > 0 && result.sent < bytes.length && !result.closed) {
      sendAll(lineBreak, write);
      closed[stream] = true;
      return false;
    }
    closed[stream] = result.closed;
    return result.sent === bytes.length;
  };

  // Exactly four arguments: a position, even 0, fails with ESPIPE on a
  // pipe and writes over the start of a file.
  const stdout = (text: string): boolean =>
    send(
      'stdout',
      (buffer, offset, length) => writeSync(1, buffer, offset, length),
      text,
    );

  const stderr = (text: string): boolean =>
    send(
      'stderr',
      (buffer, offset, length) => writeSync(2, buffer, offset, length),
      text,
    );

  return Object.freeze({ stdout, stderr });
}
