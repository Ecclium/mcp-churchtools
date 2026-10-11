/**
 * Helpers for the probes that read lists.
 *
 * They read the number of entries and the pagination of a list response,
 * and they hold the values of `limit` and `page` the probes send. A probe
 * prints the number of entries exactly only where its question needs it.
 *
 * @packageDocumentation
 */
import type { Guard, Json } from './guard.mts';
import { isObject, type JsonObject } from './spec.mts';

/** The values of `limit` a probe sends with the first page. */
export const limits = [1, 2, 100, 1000] as const;

/** Invalid values for `page` and `limit`, each sent once. */
export const invalidValues = [
  ['page', '0'],
  ['page', '-1'],
  ['page', 'x'],
  ['limit', '0'],
  ['limit', '-1'],
  ['limit', 'x'],
] as const;

/**
 * Counts the entries of a list response.
 *
 * @param body - Parsed body of a response.
 * @returns The number of entries in `data`, or `undefined` if `data` is no list.
 */
export function entries(body: unknown): number | undefined {
  const data = isObject(body) ? body['data'] : undefined;
  return Array.isArray(data) ? data.length : undefined;
}

/**
 * Reads `meta.pagination` of a list response.
 *
 * @param body - Parsed body of a response.
 * @returns The pagination object, or `undefined` if there is none.
 */
export function pagination(body: unknown): JsonObject | undefined {
  const meta = isObject(body) ? body['meta'] : undefined;
  const value = isObject(meta) ? meta['pagination'] : undefined;
  return isObject(value) ? value : undefined;
}

/**
 * Lets one exact number into the output.
 *
 * Exact numbers are allowed only on purpose, where the question is how
 * many entries come back or what the instance reports as its limit.
 *
 * @param guard - The guard of the run, which learns the number as a fixed word.
 * @param value - The number, or `undefined` if the response has none.
 * @param missing - The fixed word to print instead of a missing number.
 * @returns The number, or the fixed word.
 */
export function exact(
  guard: Guard,
  value: number | undefined,
  missing: string,
): Json {
  if (value === undefined) {
    return missing;
  }
  guard.allowFixed(value);
  return value;
}
