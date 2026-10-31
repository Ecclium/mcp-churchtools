/**
 * Pseudonyms for persons in the level `strict` (ADR 0026, ADR 0069). They
 * come from AES-256-GCM-SIV after RFC 8452, which Node.js does not offer,
 * so this module is the one place that imports `@noble/ciphers` (place
 * `aesGcmSiv`). Only the pipeline uses it; the entry point of core does not
 * export it.
 *
 * @packageDocumentation
 */
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
