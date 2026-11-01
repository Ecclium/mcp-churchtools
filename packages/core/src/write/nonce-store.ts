/**
 * The store of nonces of the free core (ADR 0029): the nonces that were
 * used, in memory, so that a token of a confirmation counts only once.
 *
 * Where it stands in the way of a write: a confirmation carries a nonce,
 * in the requestState of a question to the client or in the token of the
 * echo. When the core accepts the confirmation, it uses the nonce up here;
 * the same token a second time is a replay and commits nothing. The store
 * holds random values only, no content, bound to the tenant and the actor
 * of the call.
 *
 * A restart forgets every nonce, which does no harm: over stdio the key
 * that signs requestState and token is new in every process, so no token
 * from before the restart is valid (ADR 0053). Approvals of the queue are
 * not kept here, because they must outlive a restart.
 *
 * Only the composition root builds it, through the subpath `./composition`
 * of core; it keeps no state at module level. A plugin may bring another
 * store that passes the same checks of testkit.
 *
 * @packageDocumentation
 */
import type {
  Clock,
  NonceStore,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

/**
 * How long a used nonce is remembered: 660 seconds, the 600 a token lives
 * and one minute for clocks that differ (ADR 0029).
 */
export const nonceTtlMs = 660_000;

/**
 * How many nonces one process remembers at most. Beyond that, every new
 * nonce counts as used: the store forgets nothing early, so no nonce can
 * become fresh again while its token lives.
 */
export const maxNonces = 10_000;

// The longest nonce the store takes. A nonce of the core is a short random
// value; a longer one would only cost memory.
const maxNonceLength = 128;

/**
 * Makes the store of nonces in memory.
 *
 * @param clock - The clock that decides when a nonce may be forgotten.
 * @param capacity - How many nonces it remembers at most; {@link maxNonces}
 *   unless a test sets fewer.
 * @returns The store, frozen.
 * @throws {TypeError} When the capacity is no whole number from 1.
 * @example
 * ```ts
 * const nonces = createMemoryNonceStore(systemClock);
 * await nonces.consume(ctx, nonce, nonceTtlMs); // 'fresh'
 * await nonces.consume(ctx, nonce, nonceTtlMs); // 'replayed'
 * ```
 */
export function createMemoryNonceStore(
  clock: Clock,
  capacity: number = maxNonces,
): NonceStore {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError('The capacity is a whole number from 1.');
  }
  // Each key with the time until which it is remembered.
  const used = new Map<string, number>();

  const keyOf = (ctx: TenantContext, nonce: string): string =>
    JSON.stringify([ctx.tenantId, ctx.actor.kind, ctx.actor.id, nonce]);

  const now = (): number => {
    const value = clock.now();
    if (!Number.isFinite(value)) throw new TypeError('The clock failed.');
    return value;
  };

  return Object.freeze({
    // Runs whole in one turn of the event loop, so of two uses of the same
    // nonce at the same time exactly one is fresh.
    consume: (
      ctx: TenantContext,
      nonce: string,
      ttlMs: number,
    ): Promise<'fresh' | 'replayed'> =>
      Promise.resolve().then(() => {
        if (
          typeof nonce !== 'string' ||
          nonce.length === 0 ||
          nonce.length > maxNonceLength
        ) {
          throw new TypeError('A nonce has 1 to 128 characters.');
        }
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > nonceTtlMs) {
          throw new TypeError('A nonce is kept from 1 ms up to its time.');
        }
        const at = now();
        const key = keyOf(ctx, nonce);
        const until = used.get(key);
        if (until !== undefined && at < until) return 'replayed';
        // Only a full store sweeps, so that a use costs little.
        if (used.size >= capacity) {
          for (const [entry, time] of used) {
            if (!(at < time)) used.delete(entry);
          }
          if (used.size >= capacity) return 'replayed';
        }
        used.set(key, at + ttlMs);
        return 'fresh';
      }),
  });
}
