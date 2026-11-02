/**
 * The port for keys (ADR 0069, ADR 0031). Two kinds of keys stand behind
 * it, and the free core keeps them in two places that are backed up
 * differently:
 *
 * - **Derived keys**, for the pseudonyms of the level `strict`. The free
 *   core derives them from a key file of the operator, which is backed up,
 *   so that a pseudonym of a day can always be turned back.
 * - **Day keys**, for the snapshots of writes and the queue of approvals.
 *   They are random, one per tenant, purpose and UTC day, never backed up,
 *   and destroyed once their retention is over. Whatever a day key
 *   encrypted can then no longer be read, in any copy of the files that
 *   hold it (crypto-shredding).
 *
 * A provider never hands a day key out. It only encrypts a small key with
 * it (`wrap`) and opens that again (`unwrap`), so that a provider of a
 * plugin may keep its day keys in a service of its own.
 *
 * @packageDocumentation
 */
import type { TenantContext } from './context.js';
import type { IsoDate } from './quota.js';

/**
 * What a derived key is for. Today there is one: the pseudonyms that
 * replace the IDs of persons in the level `strict`.
 */
export type KeyPurpose = 'pseudonym';

/** Every {@link KeyPurpose}, frozen, for checks at run time. */
export const keyPurposes: readonly KeyPurpose[] = Object.freeze(['pseudonym']);

/**
 * What a day key is for: the snapshots of the state before a write, and
 * the entries of the queue of approvals (ADR 0031).
 */
export type DayKeyPurpose = 'snapshot' | 'queue';

/** Every {@link DayKeyPurpose}, frozen, for checks at run time. */
export const dayKeyPurposes: readonly DayKeyPurpose[] = Object.freeze([
  'snapshot',
  'queue',
]);

/** The bytes of every key a provider gives or wraps: 256 bits. */
export const dataKeyLength = 32;

/**
 * A key encrypted with the day key of a purpose and a day. Only the
 * provider that made it can open it, and only while that day key exists.
 */
export interface WrappedKey {
  /** What the day key is for. */
  readonly purpose: DayKeyPurpose;
  /** The UTC day of the day key. */
  readonly day: IsoDate;
  /** The encrypted key, opaque to everyone but its provider. */
  readonly sealed: string;
}

/**
 * Gives derived keys and encrypts keys with day keys. A provider holds the
 * secrets the keys come from and never hands them out, only keys made for
 * one use. It takes tenant and actor from the context and from nothing a
 * tool hands over.
 */
export interface KeyProvider {
  /**
   * Gives the derived keys of a purpose for one UTC day. For `pseudonym`,
   * every key belongs to the tenant and the actor of the context and to
   * the day, so that two actors never share a key and a key of one day
   * says nothing about another. The first key is the current one; while
   * the operator changes the secret, the key from the previous secret
   * follows, and never more than these two.
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

  /**
   * Encrypts a key with the day key of the tenant of the context, the
   * purpose and the day. The day key comes into being with its first use
   * and is the same for every caller of that tenant, purpose and day, also
   * in another process.
   *
   * @param ctx - The context of the call, for the tenant.
   * @param purpose - What the day key is for.
   * @param day - The day in UTC, as a rule the day of the call.
   * @param key - A key of {@link dataKeyLength} bytes, such as the key of
   *   one snapshot. The provider keeps no copy.
   * @returns The encrypted key, which names purpose and day.
   */
  wrap(
    ctx: TenantContext,
    purpose: DayKeyPurpose,
    day: IsoDate,
    key: Uint8Array,
  ): Promise<WrappedKey>;

  /**
   * Opens a key that {@link KeyProvider.wrap} encrypted for the tenant of
   * the context.
   *
   * @param ctx - The context of the call, for the tenant.
   * @param purpose - What the day key is for; it must be the purpose the
   *   key was wrapped for.
   * @param wrapped - The encrypted key.
   * @returns The key, a fresh copy that the caller erases after use, or
   *   undefined when the day key no longer exists: its retention is over,
   *   and what it encrypted can no longer be read. A key that does not
   *   open, because it was changed or wrapped for another tenant, rejects.
   */
  unwrap(
    ctx: TenantContext,
    purpose: DayKeyPurpose,
    wrapped: WrappedKey,
  ): Promise<Uint8Array | undefined>;

  /**
   * Destroys the day keys of a purpose for every day before the one given,
   * for every tenant of the provider. Whatever they encrypted can no longer
   * be read afterwards.
   *
   * @param purpose - What the day keys are for.
   * @param day - The first UTC day whose keys stay.
   * @returns How many day keys were destroyed.
   */
  destroyBefore(purpose: DayKeyPurpose, day: IsoDate): Promise<number>;
}
