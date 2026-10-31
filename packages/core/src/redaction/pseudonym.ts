/**
 * Pseudonyms for persons in the level `strict` (ADR 0026, ADR 0069). They
 * come from AES-256-GCM-SIV after RFC 8452, which Node.js does not offer,
 * so this module is the one place that imports `@noble/ciphers` (place
 * `aesGcmSiv`). Only the pipeline uses it; the entry point of core does not
 * export it.
 *
 * A pseudonym is the ID of a person, encrypted with the key of the tenant,
 * the principal and the UTC day of the call. The same person gives the
 * same pseudonym to the same principal on the same day, another principal
 * or another day sees another one, and no table is needed to turn it
 * back. It is taken back on the day it was made and the next one, so that
 * a conversation over midnight UTC goes on.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import type {
  IsoDate,
  KeyProvider,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { gcmsiv } from '@noble/ciphers/aes.js';

/** The bytes of a key of AES-256-GCM-SIV. */
export const gcmSivKeyLength = 32;

/** The bytes of its nonce. */
export const gcmSivNonceLength = 12;

/** The bytes of its tag, which follows the ciphertext. */
export const gcmSivTagLength = 16;

// The lengths are checked here, not left to the library, so that a wrong
// key is a TypeError of this module and never reads as a forged pseudonym.
const checkKeyAndNonce = (key: unknown, nonce: unknown): void => {
  if (!(key instanceof Uint8Array) || key.length !== gcmSivKeyLength) {
    throw new TypeError('A key of AES-256-GCM-SIV has 32 bytes.');
  }
  if (!(nonce instanceof Uint8Array) || nonce.length !== gcmSivNonceLength) {
    throw new TypeError('A nonce of AES-256-GCM-SIV has 12 bytes.');
  }
};

/**
 * Encrypts and authenticates with AES-256-GCM-SIV. Each call builds its own
 * instance of the cipher, because an instance encrypts only once.
 *
 * @param key - The key, 32 bytes.
 * @param nonce - The nonce, 12 bytes.
 * @param aad - Data that is authenticated but not encrypted.
 * @param plaintext - What is encrypted.
 * @returns The ciphertext followed by the tag of 16 bytes.
 * @throws {TypeError} When the key, the nonce, the data or the plaintext is
 *   no Uint8Array, or key or nonce has the wrong length.
 * @example
 * ```ts
 * const sealed = sealGcmSiv(key, new Uint8Array(12), aad, plaintext);
 * ```
 */
export function sealGcmSiv(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  checkKeyAndNonce(key, nonce);
  if (!(aad instanceof Uint8Array) || !(plaintext instanceof Uint8Array)) {
    throw new TypeError('Data and plaintext must be bytes.');
  }
  return gcmsiv(key, nonce, aad).encrypt(plaintext);
}

/**
 * Checks and decrypts what {@link sealGcmSiv} made. The library compares
 * the tag before it returns a byte, so no plaintext leaves before it is
 * authenticated, as RFC 8452 asks.
 *
 * @param key - The key, 32 bytes.
 * @param nonce - The nonce, 12 bytes.
 * @param aad - The same data as at encryption.
 * @param sealed - The ciphertext followed by its tag.
 * @returns The plaintext, or undefined when the tag does not fit, the
 *   sealed bytes are shorter than a tag or are no Uint8Array.
 * @throws {TypeError} When the key, the nonce or the data is no Uint8Array,
 *   or key or nonce has the wrong length.
 * @example
 * ```ts
 * const plaintext = openGcmSiv(key, new Uint8Array(12), aad, sealed);
 * if (plaintext === undefined) refuse();
 * ```
 */
export function openGcmSiv(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
): Uint8Array | undefined {
  checkKeyAndNonce(key, nonce);
  if (!(aad instanceof Uint8Array)) {
    throw new TypeError('The data must be bytes.');
  }
  if (!(sealed instanceof Uint8Array) || sealed.length < gcmSivTagLength) {
    return undefined;
  }
  try {
    return gcmsiv(key, nonce, aad).decrypt(sealed);
  } catch {
    // The library throws when the tag does not fit. Its message says only
    // that, and the caller needs no more than the refusal.
    return undefined;
  }
}

/** What every pseudonym starts with: the version of its form. */
export const pseudonymPrefix = 'p1_';

/** The bytes of the ID of a person inside a pseudonym. */
const idLength = 8;

/** The bytes a pseudonym encodes: the encrypted ID and the tag. */
const sealedLength = idLength + gcmSivTagLength;

// RFC 4648 Base32 in lower case, without padding. Lower case and no other
// signs, so that a model copies a pseudonym as it is.
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';

/** The length of a pseudonym: the prefix and 39 signs of Base32. */
export const pseudonymLength =
  pseudonymPrefix.length + Math.ceil((sealedLength * 8) / 5);

// The additional data name the use, so that a ciphertext made for
// anything else never opens as a pseudonym.
const use = 'ecclium/pseudonym/v1/personId';

const encoder = new TextEncoder();

const dayMs = 24 * 60 * 60 * 1000;

// The most keys a provider gives for one day: the current one and, during
// a change of the secret, the previous one.
const maxKeysPerDay = 2;

// Erases every list of bytes in a list the provider gave, whatever else it
// holds.
const erasing = (keys: unknown): void => {
  if (!Array.isArray(keys)) return;
  for (const key of keys as unknown[]) {
    if (key instanceof Uint8Array) key.fill(0);
  }
};

// Whether a key is 32 bytes and not all zeros.
const isKey = (key: unknown): key is Uint8Array =>
  key instanceof Uint8Array &&
  key.length === gcmSivKeyLength &&
  key.some((byte) => byte !== 0);

// Copies the keys of both days, today's first, and erases what the
// provider gave. Each day must give one or two keys; with any other number
// or any key that is not one, nothing is kept.
const taken = (days: readonly unknown[]): Uint8Array[] => {
  const valid = days.every(
    (keys) =>
      Array.isArray(keys) &&
      keys.length >= 1 &&
      keys.length <= maxKeysPerDay &&
      (keys as unknown[]).every(isKey),
  );
  const copies = valid
    ? days.flatMap((keys) =>
        (keys as Uint8Array[]).map((key) => Uint8Array.from(key)),
      )
    : [];
  for (const keys of days) erasing(keys);
  return copies;
};

const encode = (bytes: Uint8Array): string => {
  let text = pseudonymPrefix;
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
  // 24 bytes leave two bits, which the last sign carries with three zeros.
  return text + alphabet.charAt((buffer << (5 - bits)) & 0x1f);
};

// The bytes of a pseudonym, or undefined for anything that is not one in
// its only form: the prefix, the length, signs of the alphabet in lower
// case, and zeros in the three bits the last sign carries past the bytes.
// Without the last check, eight strings would give the same bytes.
const decode = (text: unknown): Uint8Array | undefined => {
  if (
    typeof text !== 'string' ||
    text.length !== pseudonymLength ||
    !text.startsWith(pseudonymPrefix)
  ) {
    return undefined;
  }
  const bytes = new Uint8Array(sealedLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (
    let position = pseudonymPrefix.length;
    position < text.length;
    position += 1
  ) {
    const value = alphabet.indexOf(text.charAt(position));
    if (value < 0) return undefined;
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return (buffer & ((1 << bits) - 1)) === 0 ? bytes : undefined;
};

const idBytes = (id: number): Uint8Array => {
  const bytes = new Uint8Array(idLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(id / 2 ** 32));
  view.setUint32(4, id % 2 ** 32);
  return bytes;
};

// The ID in the eight bytes a pseudonym opens to. Only a holder of the key
// could seal a number past 2^53 - 1, which no ID of a person is, so it
// counts as no pseudonym.
const idOf = (bytes: Uint8Array): number | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
  return Number.isSafeInteger(id) ? id : undefined;
};

// The UTC day of a time as YYYY-MM-DD.
const dayOf = (time: number): IsoDate =>
  new Date(time).toISOString().slice(0, 10) as IsoDate;

// The time of the call from the clock of the context, read as own data.
const timeOf = (ctx: TenantContext): number => {
  const context: unknown = ctx;
  const clock: unknown =
    typeof context === 'object' && context !== null && !isProxy(context)
      ? Object.getOwnPropertyDescriptor(context, 'clock')?.value
      : undefined;
  const now: unknown =
    typeof clock === 'object' && clock !== null && !isProxy(clock)
      ? Object.getOwnPropertyDescriptor(clock, 'now')?.value
      : undefined;
  const time: unknown = typeof now === 'function' ? now.call(clock) : undefined;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new TypeError('The clock of the context gives no time.');
  }
  return time;
};

/** Pseudonyms for the principal of one call. */
export interface Pseudonyms {
  /**
   * Gives the pseudonym of a person for the principal of the call, made
   * with the key of the day of the call.
   *
   * @param id - The ID of the person, a whole number from 0 to 2^53 - 1.
   * @returns The pseudonym, {@link pseudonymLength} signs.
   * @throws {TypeError} When the ID is no such number, or the keys are
   *   erased.
   */
  hide(id: number): string;
  /**
   * Gives the ID of a person back. Only a pseudonym made for the same
   * tenant and principal on the day of the call or the day before opens.
   *
   * @param pseudonym - What the model hands over.
   * @returns The ID, or undefined for anything else, without a reason.
   * @throws {TypeError} When the keys are erased.
   */
  reveal(pseudonym: unknown): number | undefined;
  /** Erases the keys of the call. Afterwards both methods throw. */
  erase(): void;
}

/**
 * Prepares the pseudonyms of one call: it asks the provider for the keys
 * of the tenant and the principal of the context, for the UTC day of the
 * call and the day before, during a change of the secret also those of
 * the previous one. New pseudonyms come from the current key of the day;
 * a pseudonym is taken back with any of the at most four keys. The caller
 * erases the keys when the call ends, in a `finally`.
 *
 * @param keys - The provider of keys.
 * @param ctx - The context of the call, for tenant, principal and time.
 * @returns The pseudonyms of the call, frozen.
 * @throws {TypeError} When the clock of the context gives no time, or the
 *   provider gives for a day no key, more than two, or one that is not 32
 *   bytes or only zeros. A refusal of the provider rejects the promise.
 * @example
 * ```ts
 * const pseudonyms = await openPseudonyms(keyProvider, ctx);
 * try {
 *   const hidden = pseudonyms.hide(person.id);
 * } finally {
 *   pseudonyms.erase();
 * }
 * ```
 */
export async function openPseudonyms(
  keys: KeyProvider,
  ctx: TenantContext,
): Promise<Pseudonyms> {
  const time = timeOf(ctx);
  const today = await keys.dataKeys(ctx, 'pseudonym', dayOf(time));
  let yesterday: readonly Uint8Array[];
  try {
    yesterday = await keys.dataKeys(ctx, 'pseudonym', dayOf(time - dayMs));
  } catch (error) {
    erasing(today);
    throw error;
  }
  // The keys are copied at once and the given ones erased, as the port
  // asks of the caller. A provider that hands out its own arrays then
  // gives zeros the next time, which the check refuses, instead of a key
  // that every principal shares.
  const all = taken([today, yesterday]);
  const [current] = all;
  if (current === undefined) {
    throw new TypeError('The provider gave no key of 32 bytes.');
  }
  // A fixed nonce: the key already belongs to one tenant, one principal
  // and one day, and the same person must give the same pseudonym under
  // it. AES-GCM-SIV keeps its other promises with a repeated nonce and
  // shows only that two plaintexts are equal, which is what a pseudonym is
  // for (RFC 8452, section 9). Made for each call, so no module holds
  // bytes that a caller could change.
  const nonce = new Uint8Array(gcmSivNonceLength);
  const aad = encoder.encode(use);
  let erased = false;
  const usable = (): void => {
    if (erased) throw new TypeError('The keys of the call are erased.');
  };
  return Object.freeze({
    __proto__: null,
    hide: (id: number): string => {
      usable();
      if (!Number.isSafeInteger(id) || id < 0) {
        throw new TypeError('The ID of a person is a whole number from 0.');
      }
      return encode(sealGcmSiv(current, nonce, aad, idBytes(id)));
    },
    reveal: (pseudonym: unknown): number | undefined => {
      usable();
      const sealed = decode(pseudonym);
      if (sealed === undefined) return undefined;
      for (const key of all) {
        const opened = openGcmSiv(key, nonce, aad, sealed);
        if (opened !== undefined) return idOf(opened);
      }
      return undefined;
    },
    erase: (): void => {
      erased = true;
      for (const key of all) key.fill(0);
    },
  });
}
