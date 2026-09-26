/**
 * Describes one response for the output of a probe.
 *
 * A description holds the status, the kind of body, the headers, the
 * cookies and the structure of the body, and nothing else. Header names
 * appear only if they are well known, all others only as a count. Header
 * values appear only as a class. Cookies appear only as a count and with
 * their attributes, never with name or value, because a cookie name can
 * carry the name of the instance.
 *
 * @packageDocumentation
 */
import type { Guard, Json } from './guard.mts';
import type { ProbeResponse } from './http.mts';
import type { JsonObject, Schemas } from './spec.mts';
import { countClass, describe, type KeyPolicy } from './structure.mts';

const knownHeaders: ReadonlySet<string> = new Set([
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'cache-control',
  'connection',
  'content-encoding',
  'content-language',
  'content-length',
  'content-security-policy',
  'content-type',
  'date',
  'etag',
  'expires',
  'keep-alive',
  'last-modified',
  'location',
  'pragma',
  'referrer-policy',
  'retry-after',
  'server',
  'strict-transport-security',
  'transfer-encoding',
  'vary',
  'www-authenticate',
  'x-content-type-options',
  'x-frame-options',
  'x-xss-protection',
]);

/** Words a response description may contain. */
export const reportWords = [
  'status',
  'format',
  'JSON',
  'leer',
  'anderes Format',
  'kopfzeilen',
  'bekannt',
  'weitere',
  'Zahl',
  'Datum',
  'Text',
  'cookies',
  'anzahl',
  'attribute',
  'httpOnly',
  'secure',
  'sameSite',
  'ablauf',
  'ja',
  'nein',
  'Lax',
  'Strict',
  'None',
  'fehlt',
  'anderer Wert',
  'Max-Age',
  'Expires',
  'beide',
  'Sitzung',
  'struktur',
] as const;

/**
 * Puts a header value into a class.
 *
 * @param value - The value of a header.
 * @returns `Zahl`, `Datum` or `Text`.
 */
export function headerClass(value: string): 'Zahl' | 'Datum' | 'Text' {
  if (/^\d+$/.test(value.trim())) {
    return 'Zahl';
  }
  if (
    /\d{4}/.test(value) &&
    /GMT|UTC|\+\d{4}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  ) {
    return 'Datum';
  }
  return 'Text';
}

function describeHeaders(headers: Headers, guard: Guard): Json {
  const known: Record<string, Json> = {};
  let others = 0;
  headers.forEach((value, name) => {
    if (name === 'set-cookie') {
      return;
    }
    if (knownHeaders.has(name) || /^(x-)?ratelimit-[a-z-]+$/.test(name)) {
      guard.allowFixed(name);
      known[name] = headerClass(value);
    } else {
      others += 1;
    }
  });
  return { bekannt: known, weitere: countClass(others) };
}

function describeCookie(cookie: string): Json {
  const attributes = cookie
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());
  const has = (name: string): boolean =>
    attributes.some((part) => part === name || part.startsWith(`${name}=`));
  const sameSite = attributes
    .find((part) => part.startsWith('samesite='))
    ?.slice('samesite='.length);
  const maxAge = has('max-age');
  const expires = has('expires');
  return {
    httpOnly: has('httponly') ? 'ja' : 'nein',
    secure: has('secure') ? 'ja' : 'nein',
    sameSite:
      sameSite === undefined
        ? 'fehlt'
        : sameSite === 'lax'
          ? 'Lax'
          : sameSite === 'strict'
            ? 'Strict'
            : sameSite === 'none'
              ? 'None'
              : 'anderer Wert',
    ablauf:
      maxAge && expires
        ? 'beide'
        : maxAge
          ? 'Max-Age'
          : expires
            ? 'Expires'
            : 'Sitzung',
  };
}

/** Settings for {@link describeResponse}. */
export interface ResponseOptions {
  readonly guard: Guard;
  readonly schemas: Schemas;
  /** The operation, for the schema of the body. */
  readonly operation: JsonObject | undefined;
  /** Default: keys the specification declares. */
  readonly keys?: KeyPolicy;
  readonly booleanValues?: boolean;
}

/**
 * Describes a response without any of its values.
 *
 * @param response - The response.
 * @param options - Guard, schemas, operation and key policy.
 * @returns Status, kind of body, headers, cookies and structure.
 * @example
 * ```ts
 * const response = await client.get({ path: '/api/whoami' });
 * describeResponse(response, { guard, schemas, operation });
 * ```
 */
export function describeResponse(
  response: ProbeResponse,
  options: ResponseOptions,
): Json {
  const { guard, schemas, operation } = options;
  guard.allowFixed(...reportWords, response.status);
  const schema =
    operation === undefined
      ? undefined
      : schemas.responseSchema(operation, response.status);
  return {
    status: response.status,
    format: response.kind,
    kopfzeilen: describeHeaders(response.headers, guard),
    cookies: {
      anzahl: countClass(response.setCookies.length),
      attribute: response.setCookies.slice(0, 5).map(describeCookie),
    },
    struktur:
      response.kind === 'JSON'
        ? describe(response.body, schema, {
            guard,
            schemas,
            keys: options.keys ?? 'specification',
            booleanValues: options.booleanValues ?? false,
          })
        : response.kind,
  };
}
