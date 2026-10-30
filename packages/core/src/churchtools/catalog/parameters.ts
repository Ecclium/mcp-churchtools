/**
 * Builds the URL of a read of the escape hatch from checked values only
 * (ADR 0067). The path comes from the template of the catalog, each path
 * value in a closed form, and the query holds only parameters the
 * operation declares. A value that does not fit gives a fixed message,
 * which names a parameter only from the catalog and never a value.
 *
 * @packageDocumentation
 */
import { isWikiPageGuid } from '@ecclium/mcp-churchtools-plugin-api';

import { removeHiddenCharacters } from '../../redaction/index.js';
import { urlOfPath } from '../query.js';
import type {
  PathParameter,
  QueryParameter,
  ReadableOperation,
} from './catalog.js';

/** The longest text in the query, in UTF-16 code units. */
export const maxQueryTextLength = 200;

/** The most values of a list in the query. */
export const maxQueryListLength = 100;

/** What building the URL gives. */
export type OperationUrl =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): OperationUrl =>
  Object.freeze({ ok: false, message });

const unknownName = (where: 'path' | 'query'): string =>
  `The request names a parameter in the ${where} that the operation does not declare.`;

const missing = (name: string): string => `The parameter ${name} is missing.`;

const invalid = (name: string): string =>
  `The parameter ${name} has a value of the wrong form.`;

const notSent = (name: string): string =>
  `The parameter ${name} has a form that Ecclium does not send.`;

const pathRefused = 'The values do not give a path of this operation.';

/**
 * Whether a URL stays where the template of an operation points: the
 * origin of the client, and a path that starts with the fixed part of the
 * template before its first parameter, such as `/api/groups/` for
 * `/api/groups/{groupId}`.
 *
 * @param url - The URL that would be sent.
 * @param origin - The canonical origin of the client.
 * @param template - The path of the operation with its parameters.
 * @returns `true` if the URL keeps both.
 * @example
 * ```ts
 * keepsTemplate(new URL('https://example.church.tools/api/groups/1'),
 *   'https://example.church.tools', '/api/groups/{groupId}'); // true
 * ```
 */
export function keepsTemplate(
  url: URL,
  origin: string,
  template: string,
): boolean {
  const brace = template.indexOf('{');
  const fixed = brace === -1 ? template : template.slice(0, brace);
  return (
    url.origin === origin &&
    fixed.startsWith('/api/') &&
    url.pathname.startsWith(fixed) &&
    url.hash === ''
  );
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const allDigits = (text: string, from: number, to: number): boolean => {
  for (let index = from; index < to; index += 1) {
    if (!isDigit(text.charCodeAt(index))) return false;
  }
  return true;
};

/**
 * Whether a text may stand in a path at all, whatever its kind: no dot
 * segment, no character that ends or changes a path (`/`, `\`, `%`, `?`,
 * `#`), no control character and nothing that NFKC changes, such as a
 * full-width dot or slash. The kinds of path values exclude all of this
 * already; this check stands behind them.
 *
 * @param text - The value as text.
 * @returns `true` if the text is safe in a path segment.
 * @example
 * ```ts
 * isSafePathText('12'); // true
 * isSafePathText('..%2f'); // false
 * ```
 */
export function isSafePathText(text: string): boolean {
  if (text.length === 0 || text.includes('..')) return false;
  if (!text.isWellFormed() || text.normalize('NFKC') !== text) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2f ||
      code === 0x5c ||
      code === 0x25 ||
      code === 0x3f ||
      code === 0x23
    ) {
      return false;
    }
  }
  return true;
}

// A whole number from 1 as a number or as decimal digits without a sign
// and without a leading zero, the form a path takes (ADR 0057).
const pathInteger = (value: unknown): string | undefined => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1
      ? String(value)
      : undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 16 ||
    value.charCodeAt(0) === 0x30 ||
    !allDigits(value, 0, value.length)
  ) {
    return undefined;
  }
  return Number.isSafeInteger(Number(value)) ? value : undefined;
};

/**
 * Whether a text is a day of the calendar that exists, as `JJJJ-MM-TT`.
 *
 * @param value - Any value.
 * @returns `true` for a day such as `2026-10-30`.
 * @example
 * ```ts
 * isCalendarDay('2026-02-30'); // false
 * ```
 */
export function isCalendarDay(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== 10 ||
    !allDigits(value, 0, 4) ||
    value.charCodeAt(4) !== 0x2d ||
    !allDigits(value, 5, 7) ||
    value.charCodeAt(7) !== 0x2d ||
    !allDigits(value, 8, 10)
  ) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls an impossible day such as 2026-02-30 over.
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

/**
 * Whether a text is a moment in UTC as `JJJJ-MM-TTTHH:MM:SSZ`, the form
 * the OpenAPI document gives for a timestamp.
 *
 * @param value - Any value.
 * @returns `true` for a moment such as `2026-10-30T12:00:00Z`.
 * @example
 * ```ts
 * isUtcMoment('2026-10-30T24:00:00Z'); // false
 * ```
 */
export function isUtcMoment(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== 20 ||
    !isCalendarDay(value.slice(0, 10)) ||
    value.charCodeAt(10) !== 0x54 ||
    !allDigits(value, 11, 13) ||
    value.charCodeAt(13) !== 0x3a ||
    !allDigits(value, 14, 16) ||
    value.charCodeAt(16) !== 0x3a ||
    !allDigits(value, 17, 19) ||
    value.charCodeAt(19) !== 0x5a
  ) {
    return false;
  }
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString() === `${value.slice(0, 19)}.000Z`
  );
}

// The text of a path value of its kind, or undefined.
const pathText = (
  parameter: PathParameter,
  value: unknown,
): string | undefined => {
  switch (parameter.kind) {
    case 'integer':
      return pathInteger(value);
    case 'guid':
      return isWikiPageGuid(value) ? value : undefined;
    case 'date':
      return isCalendarDay(value) ? value : undefined;
    case 'enum':
      return typeof value === 'string' &&
        (parameter.values ?? []).includes(value)
        ? value
        : undefined;
  }
};

/**
 * Whether a text may stand in the query: 1 to {@link maxQueryTextLength}
 * code units, well formed, without control characters or characters a
 * reader cannot see, and unchanged by NFKC.
 *
 * @param value - Any value.
 * @returns `true` if the text may be sent.
 * @example
 * ```ts
 * isQueryText('Müller'); // true
 * ```
 */
export function isQueryText(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxQueryTextLength ||
    !value.isWellFormed() ||
    value.normalize('NFKC') !== value ||
    removeHiddenCharacters(value).removed > 0
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return false;
  }
  return true;
}

// One value of the query in its kind, as text, or undefined.
const queryText = (
  parameter: QueryParameter,
  value: unknown,
): string | undefined => {
  switch (parameter.kind) {
    case 'integer':
      if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? String(value) : undefined;
      }
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 17
      ) {
        return undefined;
      }
      return (value.startsWith('-')
        ? value.length > 1 && allDigits(value, 1, value.length)
        : allDigits(value, 0, value.length)) &&
        Number.isSafeInteger(Number(value))
        ? value
        : undefined;
    case 'number':
      return typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= 1e15
        ? String(value)
        : undefined;
    case 'boolean':
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      return value === 'true' || value === 'false' ? value : undefined;
    case 'string':
      return isQueryText(value) ? value : undefined;
    case 'date':
      return isCalendarDay(value) ? value : undefined;
    case 'date-time':
      return isUtcMoment(value) ? value : undefined;
    case 'date-or-date-time':
      return isCalendarDay(value) || isUtcMoment(value) ? value : undefined;
    case 'enum':
      return typeof value === 'string' &&
        (parameter.values ?? []).includes(value)
        ? value
        : undefined;
    case 'unsupported':
      return undefined;
  }
};

// The own data properties of a plain object, or undefined for anything
// else: an array, an instance of a class, a getter or a symbol key. A
// missing part is an empty object.
const entriesOf = (
  value: unknown,
): readonly (readonly [string, unknown])[] | undefined => {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return undefined;
  const entries: (readonly [string, unknown])[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return entries;
};

/**
 * Builds the URL of a read from the template of a readable operation and
 * the values of the request.
 *
 * @param origin - The canonical origin of the client.
 * @param operation - The operation from the catalog.
 * @param input - The values of the request.
 * @param input.path - The path parameters, a plain object of names and
 *   values, or left out.
 * @param input.query - The parameters of the query, the same way.
 * @returns The URL with the origin of the client, or a fixed message.
 * @example
 * ```ts
 * const built = buildOperationUrl(origin, operation, { path: { groupId: 12 } });
 * if (built.ok) console.log(built.url.pathname); // /api/groups/12
 * ```
 */
export function buildOperationUrl(
  origin: string,
  operation: ReadableOperation,
  input: { readonly path?: unknown; readonly query?: unknown },
): OperationUrl {
  const pathEntries = entriesOf(input.path);
  const queryEntries = entriesOf(input.query);
  if (pathEntries === undefined) return refuse(unknownName('path'));
  if (queryEntries === undefined) return refuse(unknownName('query'));

  const pathValues = new Map<string, string>();
  for (const [name, value] of pathEntries) {
    const parameter = operation.pathParameters.find(
      (entry) => entry.name === name,
    );
    if (parameter === undefined) return refuse(unknownName('path'));
    const text = pathText(parameter, value);
    // Every path value passes the general check as well, after its kind.
    if (text === undefined || !isSafePathText(text)) {
      return refuse(invalid(parameter.name));
    }
    pathValues.set(parameter.name, encodeURIComponent(text));
  }
  let pathname = operation.path;
  for (const parameter of operation.pathParameters) {
    const text = pathValues.get(parameter.name);
    if (text === undefined) return refuse(missing(parameter.name));
    // A function as the replacement, so that no $ pattern applies.
    pathname = pathname.replaceAll(`{${parameter.name}}`, () => text);
  }

  const query = new URLSearchParams();
  const given = new Set<string>();
  for (const [name, value] of queryEntries) {
    const parameter = operation.queryParameters.find(
      (entry) => entry.name === name,
    );
    if (parameter === undefined) return refuse(unknownName('query'));
    // A declared parameter of a form the core does not send fails at its
    // first value, with a message of its own.
    const wrong =
      parameter.kind === 'unsupported'
        ? notSent(parameter.name)
        : invalid(parameter.name);
    const values: readonly unknown[] | undefined =
      parameter.list === true
        ? Array.isArray(value)
          ? Array.from(value as unknown[])
          : undefined
        : Array.isArray(value)
          ? undefined
          : [value];
    if (
      values === undefined ||
      values.length < 1 ||
      values.length > maxQueryListLength
    ) {
      return refuse(wrong);
    }
    for (const item of values) {
      const text = queryText(parameter, item);
      if (text === undefined) return refuse(wrong);
      query.append(parameter.name, text);
    }
    given.add(parameter.name);
  }
  for (const parameter of operation.queryParameters) {
    if (parameter.required && !given.has(parameter.name)) {
      return refuse(missing(parameter.name));
    }
  }

  // urlOfPath keeps the path exactly as it was built; keepsTemplate checks
  // origin and fixed part of the template behind it. Neither fails with
  // the checked values.
  let url: URL;
  try {
    url = urlOfPath(origin, pathname);
  } catch {
    return refuse(pathRefused);
  }
  if (!keepsTemplate(url, origin, operation.path)) return refuse(pathRefused);
  const search = query.toString();
  if (search !== '') url.search = search;
  return Object.freeze({ ok: true, url });
}
