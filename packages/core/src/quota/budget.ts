/**
 * The daily read budget of the tools with sensitivity special (ADR 0063):
 * one budget for all of them, per actor and UTC day, fixed in this
 * version. The pipeline counts against it in the store of quotas.
 *
 * @packageDocumentation
 */
import { type IsoDate, isIsoDate } from '@ecclium/mcp-churchtools-plugin-api';

/**
 * How many calls of tools with sensitivity special one actor may make per
 * UTC day. A call above it ends with `policy_denied` until the day ends.
 */
export const specialReadBudget = 200;

/**
 * How long the pipeline waits for the store of quotas before the call
 * ends as if the store had failed: longer than the wait for a lock.
 */
export const quotaTimeoutMs = 5000;

/**
 * The UTC day of a time, as the store of quotas takes it.
 *
 * @param ms - Milliseconds since the Unix epoch.
 * @returns The day, or `undefined` for a time that is no date from 1970 on.
 * @example
 * ```ts
 * isoDateOf(Date.UTC(2026, 9, 24, 23, 59)); // '2026-10-24'
 * ```
 */
export function isoDateOf(ms: number): IsoDate | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  const day = date.toISOString().slice(0, 10);
  return isIsoDate(day) ? day : undefined;
}
