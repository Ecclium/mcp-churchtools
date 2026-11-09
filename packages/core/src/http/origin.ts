/**
 * Checks the address of a ChurchTools instance (ADR 0055). Only the
 * canonical https origin passes, and nothing is normalised, so the host
 * allow-list of the outbound path can never differ from what the
 * configuration accepted. It opens no connection.
 *
 * @packageDocumentation
 */
import { hostPattern } from '../logger/index.js';

/**
 * The reasons to refuse an address, one per rule, frozen. A code names the
 * rule, never the address, so no message made from it can show the address.
 */
export const originCodes = Object.freeze([
  'url_too_long',
  'url_invalid',
  'url_not_https',
  'url_credentials',
  'url_path',
  'url_ip_address',
  'url_trailing_dot',
  'url_localhost',
  'url_single_label',
  'url_host',
  'url_port',
  'url_not_canonical',
] as const);

/** The reason to refuse an address. */
export type OriginCode = (typeof originCodes)[number];

/** The checked origin, or the reason to refuse the address. */
export type OriginResult =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly code: OriginCode };

// The longest address that can pass: https://, a host of 253 characters,
// the highest port and a slash at the end. A longer input is refused before
// the parser sees it.
const maxLength = 'https://'.length + 253 + ':65535'.length + '/'.length;

// The parser turns every host whose last label is a number into an IPv4
// address of four decimal parts, or refuses the address. An IPv6 address
// keeps its brackets.
const ipv4Pattern = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// A refusal fits both results, that of an origin and that of an endpoint.
const refuse = (
  code: OriginCode,
): { readonly ok: false; readonly code: OriginCode } =>
  Object.freeze({ __proto__: null, ok: false, code });

/**
 * Checks the address of a ChurchTools instance and gives its origin. Only
 * the canonical form passes: https, a DNS name in lower case with at least
 * one dot and international names as Punycode, any port but 0 and the
 * default port left out, no user, path, query or fragment, and at most a
 * slash at the end. The rules run in a fixed order, and the first one the
 * address breaks gives the code.
 *
 * @param input - The address as configured.
 * @returns The origin without the slash at the end, or the code of the
 *   broken rule. Never the input itself.
 * @throws {TypeError} When the input is not a string.
 * @example
 * ```ts
 * parseChurchToolsOrigin('https://example.church.tools/');
 * // { ok: true, origin: 'https://example.church.tools' }
 * ```
 */
export function parseChurchToolsOrigin(input: string): OriginResult {
  if (typeof input !== 'string') {
    throw new TypeError('An address must be a string.');
  }
  if (input.length > maxLength) return refuse('url_too_long');
  const url = URL.parse(input);
  if (url === null) return refuse('url_invalid');
  if (url.protocol !== 'https:') return refuse('url_not_https');
  if (url.username !== '' || url.password !== '') {
    return refuse('url_credentials');
  }
  // A query or a fragment starts with ? or #. The parser drops an empty
  // one from search and hash, so the input itself is searched, without a
  // regular expression: its statics would keep an address with a token
  // pasted into the query.
  if (url.pathname !== '/' || input.includes('?') || input.includes('#')) {
    return refuse('url_path');
  }
  const host = url.hostname;
  if (host.startsWith('[') || ipv4Pattern.test(host)) {
    return refuse('url_ip_address');
  }
  if (host.endsWith('.')) return refuse('url_trailing_dot');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return refuse('url_localhost');
  }
  if (!host.includes('.')) return refuse('url_single_label');
  if (!hostPattern.test(host)) return refuse('url_host');
  if (url.port === '0') return refuse('url_port');
  // Whatever the parser changed, such as capitals, the default port, an
  // escaped letter, a backslash, a tab or a name that is not Punycode,
  // makes the input differ from the origin.
  const origin = url.origin;
  if (input !== origin && input !== `${origin}/`) {
    return refuse('url_not_canonical');
  }
  return Object.freeze({ __proto__: null, ok: true, origin });
}

/** The longest path of the endpoint of a model (ADR 0033). */
export const maxEndpointPathLength = 256;

/** The checked endpoint of a model, or the reason to refuse its address. */
export type EndpointResult =
  | {
      readonly ok: true;
      /** The origin, checked as that of an instance. */
      readonly origin: string;
      /** The path, such as `/v1/chat/completions`. */
      readonly path: string;
      /** The host without the port, as the audit names it. */
      readonly host: string;
    }
  | { readonly ok: false; readonly code: OriginCode };

// The characters of a path that need no escape: letters, digits, the four
// unreserved marks and the slash between segments. Character by character,
// without a regular expression, as the names of parameters.
const isPathCharacter = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x2d ||
  code === 0x2e ||
  code === 0x5f ||
  code === 0x7e ||
  code === 0x2f;

/**
 * Checks the address of the endpoint of a language model and splits it
 * into origin and path (ADR 0033). The origin gets every rule of the
 * address of an instance. The path must be more than a slash, without an
 * empty segment, an escape, a query or a fragment, and the whole address
 * must be canonical, so that the transport sends to exactly what the
 * configuration accepted.
 *
 * @param input - The address as configured.
 * @returns Origin, path and host, or the code of the broken rule. Never
 *   the input itself.
 * @throws {TypeError} When the input is not a string.
 * @example
 * ```ts
 * parseModelEndpoint('https://model.example.org/v1/chat/completions');
 * // { ok: true, origin: 'https://model.example.org',
 * //   path: '/v1/chat/completions', host: 'model.example.org' }
 * ```
 */
export function parseModelEndpoint(input: string): EndpointResult {
  if (typeof input !== 'string') {
    throw new TypeError('An address must be a string.');
  }
  if (input.length > maxLength + maxEndpointPathLength) {
    return refuse('url_too_long');
  }
  const url = URL.parse(input);
  if (url === null) return refuse('url_invalid');
  if (url.protocol !== 'https:') return refuse('url_not_https');
  // The origin drops a user and a password, so they are checked here.
  if (url.username !== '' || url.password !== '') {
    return refuse('url_credentials');
  }
  const path = url.pathname;
  if (
    input.includes('?') ||
    input.includes('#') ||
    path.length < 2 ||
    path.length > maxEndpointPathLength ||
    path.includes('//') ||
    path.endsWith('/')
  ) {
    return refuse('url_path');
  }
  for (let index = 0; index < path.length; index += 1) {
    if (!isPathCharacter(path.charCodeAt(index))) return refuse('url_path');
  }
  const checked = parseChurchToolsOrigin(url.origin);
  if (!checked.ok) return refuse(checked.code);
  // Capitals, the default port, an escaped letter, a backslash or a dot
  // segment the parser removed make the input differ.
  if (input !== `${checked.origin}${path}`) return refuse('url_not_canonical');
  return Object.freeze({
    __proto__: null,
    ok: true,
    origin: checked.origin,
    path,
    host: url.hostname,
  });
}
