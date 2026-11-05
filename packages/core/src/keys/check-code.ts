/**
 * The secret part of a check code of the marking (ADR 0032): the first
 * 64 bits of an HMAC-SHA256 under the key of the check codes.
 *
 * Where it stands in the way of a write: when the core adds a page or a
 * section to the wiki, it ends the text with a line that carries a check
 * code, and when it reads a page, it tells its own sections by that code.
 * Both ask this module for the bytes; the module of the marking writes them
 * as `k1:` and Base32. It lives here because only the modules of the keys
 * may turn a key back into its bytes.
 *
 * The HMAC runs over a label of the version and the parts of the marking,
 * each after its length (`infoOf`), so that no two lists of parts give the
 * same input. A new form of the input needs a new label and a new prefix
 * of the code, such as `k2:`.
 *
 * @packageDocumentation
 */
import { createHmac } from 'node:crypto';

import { infoOf } from './info.js';
import { type KeyMaterial, revealKeyMaterial } from './key-material.js';

/** The label of the version of the input, the first part of every HMAC. */
export const checkCodeLabel = 'ecclium/marker/k1';

/** The bytes of a check code: 64 bits. */
export const checkCodeBytes = 8;

/**
 * Computes the bytes of a check code.
 *
 * @param key - The key of the check codes.
 * @param parts - The parts of the marking, such as the tenant, the origin
 *   and the hash of the canonical form, each at most 65'535 bytes in UTF-8.
 * @returns The first 8 bytes of the HMAC, a fresh copy.
 * @throws {TypeError} When the key is not a key of this module or a part
 *   is too long.
 * @example
 * ```ts
 * checkCodeMac(key, ['interactive', 'default', '2026-11-05', hash]).length; // 8
 * ```
 */
export function checkCodeMac(
  key: KeyMaterial,
  parts: readonly string[],
): Uint8Array {
  const input = infoOf([checkCodeLabel, ...parts]);
  const secret = revealKeyMaterial(key);
  try {
    return Uint8Array.from(
      createHmac('sha256', secret)
        .update(input)
        .digest()
        .subarray(0, checkCodeBytes),
    );
  } finally {
    secret.fill(0);
  }
}
