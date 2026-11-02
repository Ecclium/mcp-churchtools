/**
 * The hash of a policy (ADR 0032).
 *
 * Where it stands: once at the start, after the check. Every audit line
 * of a write and of a run names the policy that applied by this hash, so
 * an operator can tell later which rules decided. It is taken over the
 * canonical form of the checked policy: its defaults in place, names in
 * NFC, GUIDs in lower case and the keys of every object sorted. Comments,
 * order of keys and the way a value is written in the file do not change
 * it; the order of entries does. A server without a file names the hash
 * of the default policy.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import type { Policy } from './schema.js';

// JSON with the keys of every object sorted. A checked policy holds only
// objects, arrays, strings and whole numbers.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * The hash of a checked policy: SHA-256 over its canonical form, in
 * lower-case hexadecimal.
 *
 * @param policy - The policy as `checkPolicy` returned it.
 * @returns 64 hexadecimal characters.
 * @example
 * ```ts
 * policyHashOf(defaultPolicy); // '…' (64 characters)
 * ```
 */
export function policyHashOf(policy: Policy): string {
  return createHash('sha256').update(canonical(policy), 'utf8').digest('hex');
}
