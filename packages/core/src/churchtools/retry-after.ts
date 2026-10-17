/**
 * Reads the header `Retry-After` of a 429 (ADR 0057). Only whole seconds
 * count; an HTTP date and every other form give no time, so that a value
 * from the server never reaches a message.
 *
 * @packageDocumentation
 */

const maxSeconds = 3600;

/**
 * Reads whole seconds from 1 to 3600, as digits without a sign.
 *
 * @param value - The header as the transport passed it on, if at all.
 * @returns The seconds, or `undefined` for any other value.
 * @example
 * ```ts
 * retryAfterSeconds('120'); // 120
 * retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT'); // undefined
 * ```
 */
export function retryAfterSeconds(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.length < 1 || value.length > 4) {
    return undefined;
  }
  let seconds = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return undefined;
    seconds = seconds * 10 + (code - 0x30);
  }
  return seconds >= 1 && seconds <= maxSeconds ? seconds : undefined;
}
