/**
 * The loop that writes a run of bytes with `writeSync`, shared by the
 * output module and the start notices of the command line. It knows no
 * file descriptor: the caller passes a function that writes to its own.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

/** The shape of `writeSync` from `node:fs`, as the writers call it. */
export type WriteSyncFn = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

/** Writes a part of the bytes and returns how many it wrote. */
export type WritePart = (
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

/** What {@link sendAll} managed. */
export interface Sent {
  /** Bytes written, from the start. */
  readonly sent: number;
  /** Whether the other end is gone for good, after EPIPE or EBADF. */
  readonly closed: boolean;
}

/** System calls per run of bytes at most. */
export const maxAttempts = 4;

// Characters beyond printable ASCII that the texts of the command line
// use: the umlauts and the quotes «» and ‹›. A list of what is allowed,
// not of what is refused: a control character, a line separator, a mark
// for the direction of text, an invisible or a lookalike character never
// reaches a terminal, also one that a list of refused characters would
// miss.
const letters: readonly number[] = Object.freeze([
  0xab, 0xbb, 0xc4, 0xd6, 0xdc, 0xe4, 0xf6, 0xfc, 0x2039, 0x203a,
]);

const isShown = (code: number): boolean =>
  (code >= 0x20 && code <= 0x7e) || letters.includes(code);

/**
 * Tells whether a value is one line of text for a terminal: 1 to
 * `maxLength` characters, each of them printable ASCII, a German umlaut
 * or one of the quotes «» and ‹›. The writers of the command line check
 * every line with it as a tripwire.
 *
 * @param value - Any value.
 * @param maxLength - The most characters.
 * @returns Whether it fits.
 * @example
 * ```ts
 * isTextLine('Die Konfiguration ist gültig.', 1000); // true
 * ```
 */
export function isTextLine(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!isShown(value.charCodeAt(index))) return false;
  }
  return true;
}

// The code of a failed system call, read without running code of the
// thrown value.
const codeOf = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown;
};

/**
 * Writes the bytes, continuing a partial write at its offset. EAGAIN is
 * tried again at once, without waiting, up to {@link maxAttempts} calls in
 * all: a reader that does not drain the stream costs output, not time.
 * EPIPE and EBADF end the run and report the stream as closed. It never
 * throws.
 *
 * @param bytes - What to write.
 * @param write - Writes one part to the stream of the caller.
 * @returns The bytes written and whether the stream is closed.
 * @example
 * ```ts
 * sendAll(bytes, (buffer, offset, length) => writeSync(2, buffer, offset, length));
 * ```
 */
export function sendAll(bytes: Uint8Array, write: WritePart): Sent {
  let offset = 0;
  for (
    let attempt = 0;
    attempt < maxAttempts && offset < bytes.length;
    attempt += 1
  ) {
    const rest = bytes.length - offset;
    try {
      const count = write(bytes, offset, rest);
      // A count outside its contract counts as no progress.
      if (Number.isInteger(count) && count > 0 && count <= rest) {
        offset += count;
      }
    } catch (error) {
      const code = codeOf(error);
      if (code === 'EPIPE' || code === 'EBADF') {
        return Object.freeze({ sent: offset, closed: true });
      }
      if (code !== 'EAGAIN') break;
    }
  }
  return Object.freeze({ sent: offset, closed: false });
}
