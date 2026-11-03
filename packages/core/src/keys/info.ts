/**
 * The info of a key derivation and the additional data of an encryption
 * (ADR 0069, ADR 0031): a list of parts, each after its length in two
 * bytes, big-endian, so that no two different lists of parts give the
 * same bytes.
 *
 * @packageDocumentation
 */

const encoder = new TextEncoder();

/**
 * Encodes a list of parts without ambiguity.
 *
 * @param parts - The parts, each at most 65'535 bytes in UTF-8.
 * @returns The bytes.
 * @throws {TypeError} For a part longer than 65'535 bytes.
 * @example
 * ```ts
 * infoOf(['ecclium/key/v1', 'pseudonym']).length; // 2 + 14 + 2 + 9
 * ```
 */
export function infoOf(parts: readonly string[]): Uint8Array {
  const encoded = parts.map((part) => encoder.encode(part));
  if (encoded.some((part) => part.length > 0xffff)) {
    throw new TypeError('A part of the info is too long.');
  }
  const info = new Uint8Array(
    encoded.reduce((sum, part) => sum + 2 + part.length, 0),
  );
  let offset = 0;
  for (const part of encoded) {
    info[offset] = part.length >> 8;
    info[offset + 1] = part.length & 0xff;
    info.set(part, offset + 2);
    offset += 2 + part.length;
  }
  return info;
}
