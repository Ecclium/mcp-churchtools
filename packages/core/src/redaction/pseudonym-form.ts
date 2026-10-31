/**
 * Which levels of redaction put pseudonyms in place of the IDs of persons,
 * and the form of a pseudonym as the list of tools shows it (ADR 0069).
 * This module holds no key and no cipher, so that the registry and the
 * mount can read it; the module of the pseudonyms checks every pseudonym
 * itself, and a test holds both to the same form.
 *
 * @packageDocumentation
 */
import type { RedactionLevel } from '@ecclium/mcp-churchtools-plugin-api';

/**
 * Whether a level does what `strict` does beyond `standard`: pseudonyms,
 * short last names and the check of free text. A level the core does not
 * know yet counts, so that it fails closed.
 *
 * @param level - The level of redaction of a call or a server.
 * @returns Whether it is neither `off` nor `standard`.
 * @example
 * ```ts
 * isStrictLevel('strict'); // true
 * isStrictLevel('standard'); // false
 * ```
 */
export const isStrictLevel = (level: RedactionLevel): boolean =>
  level !== 'off' && level !== 'standard';

/** The length of a pseudonym: `p1_` and 39 signs of Base32. */
export const pseudonymTextLength = 42;

/**
 * The form of a pseudonym for JSON Schema: `p1_` and 39 signs of Base32 in
 * lower case, without padding.
 */
export const pseudonymPattern = '^p1_[a-z2-7]{39}$';
