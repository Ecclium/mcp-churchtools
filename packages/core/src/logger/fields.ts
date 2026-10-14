/**
 * Patterns and ranges of the values that log and audit lines may carry
 * (ADR 0054). Every accepted value is printable ASCII, so no line break,
 * terminal escape or invisible character reaches a line.
 *
 * @packageDocumentation
 */
import {
  type ErrorCode,
  errorCodes,
  type Mode,
  type RedactionLevel,
  type ToolName,
} from '@ecclium/mcp-churchtools-plugin-api';

/** Every {@link Mode}, frozen. */
export const modes: readonly Mode[] = Object.freeze([
  'interactive',
  'unattended',
  'operator',
]);

/** Every {@link RedactionLevel}, frozen. */
export const redactionLevels: readonly RedactionLevel[] = Object.freeze([
  'off',
  'standard',
  'strict',
]);

// Regular expressions without flags: g or y would keep a lastIndex shared by
// every caller, i would let capitals through, and i together with u would
// let lookalikes such as U+017F through. The length is checked before a
// pattern runs, so a huge string costs nothing.
const eventPattern = /^[a-z][a-z0-9_]{0,63}$/;

/** A tenant ID, also for the schema of the audit. Never give it a flag. */
export const tenantIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A tool name, also for the schema of the audit. Never give it a flag. */
export const toolNamePattern = /^ct_[a-z0-9_]{1,60}$/;

/** A UUID in lower case, also for the schema of the audit. */
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A time in ISO 8601, in UTC, with milliseconds and a year of four digits. */
export const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const matches = (
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): value is string =>
  typeof value === 'string' && value.length <= maxLength && pattern.test(value);

/**
 * Tells whether a value is the name of a log event, such as `cache_skipped`.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 */
export const isEventName = (value: unknown): value is string =>
  matches(value, eventPattern, 64);

/**
 * Tells whether a value is the ID of a tenant, such as `demo-tenant`.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 */
export const isTenantId = (value: unknown): value is string =>
  matches(value, tenantIdPattern, 63);

/**
 * Tells whether a value is a tool name in lower case, such as `ct_group_search`.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 */
export const isToolName = (value: unknown): value is ToolName =>
  matches(value, toolNamePattern, 63);

/**
 * Tells whether a value is a UUID in lower case, as `randomUUID` makes it.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 */
export const isUuid = (value: unknown): value is string =>
  matches(value, uuidPattern, 36);

/**
 * Tells whether a value is one of the stable error codes, compared exactly.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 */
export const isErrorCode = (value: unknown): value is ErrorCode =>
  (errorCodes as readonly unknown[]).includes(value);

/**
 * Tells whether a value is one of the modes, compared exactly.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 */
export const isMode = (value: unknown): value is Mode =>
  (modes as readonly unknown[]).includes(value);

/**
 * Tells whether a value is one of the levels of redaction, compared exactly.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 */
export const isRedactionLevel = (value: unknown): value is RedactionLevel =>
  (redactionLevels as readonly unknown[]).includes(value);

/**
 * Tells whether a value is a real boolean, never a string such as `'false'`.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 */
export const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

/**
 * Makes a check for whole numbers in a range. It refuses NaN, the
 * infinities, fractions and numbers as strings; it never coerces.
 *
 * @param min - The smallest allowed number.
 * @param max - The largest allowed number.
 * @returns The check.
 */
export const isIntegerIn =
  (min: number, max: number) =>
  (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max;

/**
 * Turns the value of a clock into a time in ISO 8601, or gives undefined.
 * It refuses what is no finite number and a year outside 0 to 9999, which
 * Date writes with a sign and six digits. A fraction of a millisecond is cut
 * off, never rounded.
 *
 * @param now - Milliseconds since the Unix epoch.
 * @returns The time, or undefined.
 */
export const toTimestamp = (now: unknown): string | undefined => {
  if (typeof now !== 'number' || !Number.isFinite(now)) return undefined;
  try {
    const text = new Date(now).toISOString();
    return timestampPattern.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
};
