/**
 * The data envelope for free text from ChurchTools (ADR 0024). Each field of
 * the class `untrusted` stands between two markers with a boundary drawn at
 * random for each call. Text of the tenant cannot close the envelope early,
 * because it cannot know the boundary, and the description of every tool
 * tells the model that what stands in an envelope is data, never an
 * instruction.
 *
 * The envelope stands in the value itself, so it reaches the model in the
 * structured result as well as in the text of a call.
 *
 * @packageDocumentation
 */

/** The random bytes of a boundary, written as twice as many hex digits. */
export const boundaryBytes = 8;

/** How often a boundary is drawn before a call gives up. */
export const maxBoundaryDraws = 4;

/** A source of random bytes, such as `randomBytes` of `node:crypto`. */
export type RandomBytes = (size: number) => Uint8Array;

const hexDigits = '0123456789abcdef';

/**
 * Draws a boundary of {@link boundaryBytes} random bytes as lowercase hex.
 *
 * @param random - The source of random bytes.
 * @returns A boundary such as `a1b2c3d4e5f6a7b8`.
 * @throws {TypeError} When the source returns anything but a Uint8Array of
 *   the asked length.
 * @example
 * ```ts
 * drawBoundary(randomBytes); // 'a1b2c3d4e5f6a7b8'
 * ```
 */
export function drawBoundary(random: RandomBytes): string {
  const bytes: unknown = random(boundaryBytes);
  if (!(bytes instanceof Uint8Array) || bytes.length !== boundaryBytes) {
    throw new TypeError('The source of random bytes returned no bytes.');
  }
  let boundary = '';
  for (const byte of bytes) {
    boundary += hexDigits.charAt(byte >> 4) + hexDigits.charAt(byte & 0x0f);
  }
  return boundary;
}

/**
 * Draws a boundary that the result does not hold yet, so no text of the
 * result can close an envelope. A clash is next to impossible with random
 * bytes; after {@link maxBoundaryDraws} clashes the source of random bytes
 * is broken, and the call fails rather than wrap text in a boundary the
 * text already knows.
 *
 * @param result - Every text of the result after cleaning, such as its
 *   JSON.
 * @param random - The source of random bytes.
 * @returns A boundary that does not occur in the result.
 * @throws {TypeError} When the source returns no bytes or only boundaries
 *   the result holds.
 * @example
 * ```ts
 * const boundary = chooseBoundary(JSON.stringify(result), randomBytes);
 * ```
 */
export function chooseBoundary(result: string, random: RandomBytes): string {
  for (let draw = 0; draw < maxBoundaryDraws; draw += 1) {
    const boundary = drawBoundary(random);
    if (!result.includes(boundary)) return boundary;
  }
  throw new TypeError('Every boundary drawn occurs in the result.');
}

/**
 * Puts a text into the data envelope.
 *
 * @param text - The cleaned text.
 * @param boundary - The boundary of the call.
 * @returns The text between the opening and the closing marker.
 * @example
 * ```ts
 * wrapInEnvelope('Text', 'a1b2c3d4e5f6a7b8');
 * // '<<data-a1b2c3d4e5f6a7b8>>Text<</data-a1b2c3d4e5f6a7b8>>'
 * ```
 */
export function wrapInEnvelope(text: string, boundary: string): string {
  return `<<data-${boundary}>>${text}<</data-${boundary}>>`;
}
