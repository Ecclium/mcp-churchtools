/**
 * The throttle of requests to one ChurchTools instance (ADR 0057): a bucket
 * that refills at a rate per minute and holds a sixth of it. It is the
 * named exception of ADR 0051 for state beyond a request: it holds no
 * content and no credentials, lives in the closure of one client, and a
 * restart resets it.
 *
 * @packageDocumentation
 */
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

/** What a throttle is built from. */
export interface ThrottleOptions {
  /** Requests per minute, a whole number from 1. */
  readonly requestsPerMinute: number;
  /** The clock, in milliseconds. */
  readonly clock: Clock;
}

/** What taking a place gives. */
export type TakeResult =
  { readonly ok: true } | { readonly ok: false; readonly waitSeconds: number };

/** A throttle: one place per request. */
export interface RequestThrottle {
  /** Takes a place, or tells how many whole seconds until the next one. */
  take(): TakeResult;
}

// One request costs a minute in milliseconds; every millisecond adds the
// rate. So the bucket gains exactly `rate` requests per minute.
const costOfRequest = 60_000;

const allowed: TakeResult = Object.freeze({ __proto__: null, ok: true });

/**
 * Builds a throttle. The bucket starts full. A clock that gives no finite
 * number or throws refills nothing and leaves the state as it was; a clock
 * that runs back refills nothing until it reaches the last time again.
 *
 * @param options - Rate and clock.
 * @returns The throttle, frozen, with `take` as its only key.
 * @throws {TypeError} When the rate is not a whole number from 1.
 * @example
 * ```ts
 * const throttle = createRequestThrottle({ requestsPerMinute: 300, clock });
 * if (!throttle.take().ok) throw new EccliumError('rate_limited');
 * ```
 */
export function createRequestThrottle(
  options: ThrottleOptions,
): RequestThrottle {
  const { requestsPerMinute: rate, clock } = options;
  if (!Number.isSafeInteger(rate) || rate < 1) {
    throw new TypeError('A throttle needs a whole rate from 1.');
  }
  const capacity = Math.ceil(rate / 6) * costOfRequest;
  let credit = capacity;
  let last: number | undefined;

  const refill = (): void => {
    let now: number;
    try {
      now = clock.now();
    } catch {
      return;
    }
    if (!Number.isFinite(now)) return;
    if (last === undefined) {
      last = now;
      return;
    }
    if (now < last) return;
    credit = Math.min(capacity, credit + (now - last) * rate);
    last = now;
  };

  return Object.freeze({
    take: (): TakeResult => {
      refill();
      if (credit >= costOfRequest) {
        credit -= costOfRequest;
        return allowed;
      }
      const waitMs = (costOfRequest - credit) / rate;
      return Object.freeze({
        __proto__: null,
        ok: false,
        waitSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      });
    },
  });
}
