/**
 * The check code of the marking (ADR 0032): `k1:` and 13 signs of Base32
 * from the first 64 bits of an HMAC under the key of the check codes.
 *
 * Where it stands in the way of a write: when the core adds a page or a
 * section to the wiki, the line at its end carries this code, and when it
 * reads a page, a section counts as its own only when the code of its line
 * fits its content. Without the key nobody can make a code that fits, so a
 * person with the right to edit the wiki cannot pass a section of their
 * own for one of Ecclium and so hide or replace a real report (T10).
 *
 * The input names the tenant, where the marking comes from (an
 * interactive write and its UTC day, or a routine and its run) and the
 * SHA-256 of the canonical form of the section. The instance is not part of
 * it: a new host name of the instance would make every code invalid.
 *
 * @packageDocumentation
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { IsoDate } from '@ecclium/mcp-churchtools-plugin-api';

import { checkCodeMac, type KeyMaterial } from '../keys/index.js';

/** The prefix of a check code of this version. */
export const checkCodePrefix = 'k1:';

/** The signs of a check code after the prefix. */
export const checkCodeSigns = 13;

/** Where a marking comes from: an interactive write or a run of a routine. */
export type MarkingOrigin =
  | {
      readonly kind: 'interactive';
      /** The UTC day of the plan of the write. */
      readonly day: IsoDate;
    }
  | {
      readonly kind: 'routine';
      /** The ID of the routine, such as `dienstplan-report`. */
      readonly routine: string;
      /** The period of the run, such as `2026-W40`. */
      readonly run: string;
    };

// RFC 4648, section 6.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Writes bytes in Base32 after RFC 4648, in capitals and without padding.
 *
 * @param bytes - The bytes.
 * @returns One sign for every five bits; the last one is filled up with
 *   zero bits.
 * @example
 * ```ts
 * base32(new TextEncoder().encode('foobar')); // 'MZXW6YTBOI'
 * ```
 */
export function base32(bytes: Uint8Array): string {
  let text = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += alphabet.charAt((buffer >> bits) & 0x1f);
    }
  }
  if (bits > 0) text += alphabet.charAt((buffer << (5 - bits)) & 0x1f);
  return text;
}

// The parts of the input, each a text, with a word for the origin first,
// so that no input of one kind reads as one of the other.
const partsOf = (
  tenantId: string,
  origin: MarkingOrigin,
  hash: string,
): readonly string[] =>
  origin.kind === 'interactive'
    ? ['interactive', tenantId, origin.day, hash]
    : ['routine', tenantId, origin.routine, origin.run, hash];

/**
 * Computes the check code of a section.
 *
 * @param key - The key of the check codes.
 * @param tenantId - The tenant the section belongs to.
 * @param origin - Where its marking comes from.
 * @param canonical - The canonical form of the section without its line
 *   (`canonicalMarkdown`).
 * @returns The code, such as `k1:ABCDEFGHIJKLM`.
 * @example
 * ```ts
 * checkCodeOf(key, 'default', { kind: 'interactive', day }, '## Nachtrag\n');
 * ```
 */
export function checkCodeOf(
  key: KeyMaterial,
  tenantId: string,
  origin: MarkingOrigin,
  canonical: string,
): string {
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${checkCodePrefix}${base32(checkCodeMac(key, partsOf(tenantId, origin, hash)))}`;
}

const encoder = new TextEncoder();

/**
 * Compares two check codes in constant time for codes of the same length.
 *
 * @param left - A code.
 * @param right - Another code.
 * @returns Whether both are the same.
 * @example
 * ```ts
 * sameCheckCode('k1:ABCDEFGHIJKLM', 'k1:ABCDEFGHIJKLM'); // true
 * ```
 */
export function sameCheckCode(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
