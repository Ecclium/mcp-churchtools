/**
 * Keeps only the headers of an answer that the client needs (ADR 0056).
 * ChurchTools sets cookies on every answer to a request with a login token,
 * though the client never sends one back (ADR 0023). They and every other
 * header stay in the transport.
 *
 * @packageDocumentation
 */

/** The headers of an answer that leave the transport. */
export interface ResponseHeaders {
  /** The media type of the body, such as `application/json`. */
  readonly 'content-type'?: string;
  /** How long to wait after a 429, as the server sent it. */
  readonly 'retry-after'?: string;
  /** The time of the server, as it sent it. */
  readonly date?: string;
}

/** The kept headers, or the refusal of an encoded body. */
export type HeadersResult =
  | { readonly ok: true; readonly headers: ResponseHeaders }
  | { readonly ok: false; readonly category: 'encoding' };

/** The names of the headers that leave the transport, frozen. */
export const keptHeaders = Object.freeze([
  'content-type',
  'retry-after',
  'date',
] as const);

const maxValueLength = 256;

// An own data property only, never inherited and never through a getter.
const ownValue = (headers: object, name: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(headers, name);
  return property !== undefined && 'value' in property
    ? property.value
    : undefined;
};

// A value the client may read: one header, not a list of repeated ones,
// printable ASCII with spaces and tabs, and not longer than any of the
// three ever needs. Anything else is left out rather than shortened.
const isPlainValue = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > maxValueLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code > 0x7e) return false;
  }
  return true;
};

const isIdentity = (encoding: unknown): boolean =>
  typeof encoding === 'string' && encoding.trim().toLowerCase() === 'identity';

/**
 * Keeps `content-type`, `retry-after` and `date` of the headers of an
 * answer and drops all others, `set-cookie` among them. A header that came
 * more than once, holds other characters than printable ASCII or is longer
 * than 256 characters is dropped as well. An answer with a `content-encoding`
 * other than `identity` is refused: the transport asks for no encoding and
 * decodes none, so it cannot read such a body.
 *
 * @param headers - The headers as undici gives them, names in lower case.
 * @returns The kept headers in a frozen object without prototype, or the
 *   category `encoding`.
 * @example
 * ```ts
 * keepKnownHeaders({ 'content-type': 'application/json', 'set-cookie': ['a=b'] });
 * // { ok: true, headers: { 'content-type': 'application/json' } }
 * ```
 */
export function keepKnownHeaders(headers: unknown): HeadersResult {
  const kept = Object.create(null) as Record<string, string>;
  if (typeof headers === 'object' && headers !== null) {
    // Any content-encoding counts, also one the check cannot read as data.
    const encoding = Object.getOwnPropertyDescriptor(
      headers,
      'content-encoding',
    );
    if (
      encoding !== undefined &&
      !('value' in encoding && isIdentity(encoding.value))
    ) {
      return Object.freeze({
        __proto__: null,
        ok: false,
        category: 'encoding',
      });
    }
    for (const name of keptHeaders) {
      const value = ownValue(headers, name);
      if (isPlainValue(value)) kept[name] = value;
    }
  }
  return Object.freeze({
    __proto__: null,
    ok: true,
    headers: Object.freeze(kept),
  });
}
