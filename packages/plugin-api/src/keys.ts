/**
 * The port for keys (ADR 0069). The free core derives them from a file of
 * the operator; a plugin may bring another provider, which must keep the
 * same promises. Today a key serves one purpose, the pseudonyms of the
 * level `strict`; keys for snapshots and the approval queue follow with
 * the write tools.
 *
 * @packageDocumentation
 */
import type { TenantContext } from './context.js';
import type { IsoDate } from './quota.js';

/**
 * What a key is for. Today there is one: the pseudonyms that replace the
 * IDs of persons in the level `strict`.
 */
export type KeyPurpose = 'pseudonym';

/** Every {@link KeyPurpose}, frozen, for checks at run time. */
export const keyPurposes: readonly KeyPurpose[] = Object.freeze(['pseudonym']);

/** The bytes of every key a provider gives: 256 bits. */
export const dataKeyLength = 32;

/**
 * Gives the keys of a purpose for a day. A provider holds the secret they
 * come from and never hands it out, only keys made for one use.
 */
export interface KeyProvider {
  /**
   * Gives the keys of a purpose for one UTC day. For `pseudonym`, every key
   * belongs to the tenant and the actor of the context and to the day, so
   * that two actors never share a key and a key of one day says nothing
   * about another. A provider takes tenant and actor from the context and
   * from nothing a tool hands over. The first key is the current one;
   * while the operator changes the secret, the key from the previous
   * secret follows, and never more than these two.
   *
   * @param ctx - The context of the call, for tenant and actor.
   * @param purpose - What the keys are for.
   * @param day - The day in UTC.
   * @returns One or two keys of {@link dataKeyLength} bytes each, fresh
   *   copies that the caller erases after use.
   */
  dataKeys(
    ctx: TenantContext,
    purpose: KeyPurpose,
    day: IsoDate,
  ): Promise<readonly Uint8Array[]>;
}
