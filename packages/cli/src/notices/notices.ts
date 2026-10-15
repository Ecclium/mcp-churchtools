/**
 * The start notices of the command line on stderr (ADR 0053, ADR 0055).
 * Before a start over stdio, the problems and warnings of the
 * configuration go here in German. The place writes only texts of the
 * catalog, one line per text, so it is no channel for free text, and it
 * never touches `process.stderr`, which would make fd 2 non-blocking.
 *
 * @packageDocumentation
 */
import { writeSync as fsWriteSync } from 'node:fs';

import type { MessageText } from '../messages/index.js';
import { isTextLine, sendAll, type WriteSyncFn } from '../send.js';

/** Options of {@link writeNotices}. */
export interface NoticeOptions {
  /** Replaces `writeSync` from `node:fs`, for tests. */
  readonly writeSync?: WriteSyncFn;
}

/** What {@link writeNotices} managed, frozen. */
export interface NoticeResult {
  /** Whether every text was written whole. */
  readonly complete: boolean;
  /**
   * Whether a line stays cut off without its line break, so that the next
   * output on fd 2, such as the first line of the log, would continue it.
   */
  readonly torn: boolean;
}

/** The longest notice, in characters. */
export const maxNoticeLength = 1000;

const encoder = new TextEncoder();

const lineBreak = encoder.encode('\n');

/**
 * Writes texts of the catalog to stderr, one line each, with `writeSync`
 * on fd 2. A partial write is continued, and after EPIPE or EBADF nothing
 * more is tried. A line that stays cut off ends the notices, so that the
 * next notice does not continue it, and gets one attempt at a line break.
 * When that fails too, the result says so. A text that breaks the tripwire
 * is left out. It never throws for a failed write.
 *
 * @param texts - Texts of the catalog, without line breaks.
 * @param options - A replacement for `writeSync`, for tests.
 * @returns Whether every text was written whole, and whether a line stays
 *   cut off.
 * @throws {TypeError} When the texts are no array or writeSync no function.
 * @example
 * ```ts
 * writeNotices([warningText('redaction_off')]);
 * ```
 */
export function writeNotices(
  texts: readonly MessageText[],
  options: NoticeOptions = {},
): NoticeResult {
  const writeSync = options.writeSync ?? fsWriteSync;
  if (!Array.isArray(texts) || typeof writeSync !== 'function') {
    throw new TypeError('Notices need a list of texts and a writeSync.');
  }
  const result = (complete: boolean, torn = false): NoticeResult =>
    Object.freeze({ complete, torn });
  let complete = true;
  for (let index = 0; index < texts.length; index += 1) {
    // A tripwire: the texts come from the catalog, so a text that breaks
    // the check can only mean a mistake.
    const text: unknown = texts[index];
    if (!isTextLine(text, maxNoticeLength)) {
      complete = false;
      continue;
    }
    const bytes = encoder.encode(`${text}\n`);
    // Exactly four arguments: a position, even 0, fails with ESPIPE on a
    // pipe and writes over the start of a file.
    const write = (buffer: Uint8Array, offset: number, length: number) =>
      writeSync(2, buffer, offset, length);
    const { sent, closed } = sendAll(bytes, write);
    // After EPIPE or EBADF nothing reaches fd 2 any more, a cut line
    // included.
    if (closed) return result(false);
    if (sent === bytes.length) continue;
    complete = false;
    if (sent > 0) {
      return result(false, sendAll(lineBreak, write).sent !== 1);
    }
  }
  return result(complete);
}
