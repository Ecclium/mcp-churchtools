/**
 * Checks the target of a request before the outbound path opens a socket
 * for it (ADR 0056). The transport sends to its one origin only, so this
 * check is the second guard behind the fixed origin: it refuses what should
 * never reach ChurchTools, such as a token in the address or the parameters
 * that put a login token or a session into the query. A write is held to
 * more (ADR 0072): it has no query, and DELETE reaches only one appointment
 * or one booking.
 *
 * @packageDocumentation
 */
import type { HttpMethod } from '../logger/index.js';
import { revealSecret, type Secret } from './secret.js';

/**
 * The reasons to refuse a target, one per rule, frozen. A code names the
 * rule, never the target, so no message made from it can show the address
 * or the token.
 */
export const targetCodes = Object.freeze([
  'target_not_https',
  'target_credentials',
  'target_origin',
  'target_fragment',
  'target_path',
  'target_parameter_name',
  'target_forbidden_parameter',
  'target_token',
  'target_write_query',
  'target_delete_path',
] as const);

/** The reason to refuse a target. */
export type TargetCode = (typeof targetCodes)[number];

/** The path and query to send, or the reason to refuse the target. */
export type TargetResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: TargetCode };

// Query parameters that hand ChurchTools a login token or ask it for a
// session. The token goes only into the Authorization header (ADR 0023).
const forbiddenParameters: readonly string[] = Object.freeze([
  'login_token',
  'with_session',
]);

const refuse = (code: TargetCode): TargetResult =>
  Object.freeze({ __proto__: null, ok: false, code });

const isNameCharacter = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f;

// A parameter name is letters, digits and underscores, with an optional []
// for a list such as ids[]. PHP turns dots, spaces and an open bracket in a
// name into underscores, so login.token or login[token would reach the
// server as login_token. Such names never pass. The check goes character by
// character: a regular expression would keep the name in its statics.
const baseOfName = (name: string): string | undefined => {
  const base = name.endsWith('[]') ? name.slice(0, -2) : name;
  if (base.length === 0) return undefined;
  for (let index = 0; index < base.length; index += 1) {
    if (!isNameCharacter(base.charCodeAt(index))) return undefined;
  }
  return base;
};

const hexValue = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
};

// Decodes %XX for visible ASCII and leaves everything else as it is.
// decodeURIComponent throws on a lone %, which a path may hold, and a token
// holds only visible ASCII (ADR 0054).
const decodeVisibleAscii = (text: string): string => {
  let decoded = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x25 && index + 2 < text.length) {
      const high = hexValue(text.charCodeAt(index + 1));
      const low = hexValue(text.charCodeAt(index + 2));
      const code = high * 16 + low;
      if (high >= 0 && low >= 0 && code >= 0x21 && code <= 0x7e) {
        decoded += String.fromCharCode(code);
        index += 2;
        continue;
      }
    }
    decoded += text.charAt(index);
  }
  return decoded;
};

// Serialises a URL through the built-in method, which throws for anything
// but a real URL. The check then reads a fresh copy: a proxy, an object
// with its own href or a real URL with its own origin property cannot show
// it one address while the request goes to another.
const serialise = (target: URL): string => {
  try {
    return URL.prototype.toString.call(target);
  } catch {
    throw new TypeError('A request target must be a URL.');
  }
};

/**
 * Checks a request target against the origin of a transport and gives the
 * path and query to send. The rules run in a fixed order, and the first one
 * the target breaks gives the code: https only, no user or password, the
 * same origin, no fragment, no path that starts with `//`, parameter names
 * of letters, digits and underscores with an optional `[]`, neither
 * `login_token` nor `with_session`, and the token nowhere in the address.
 *
 * The search for the token compares the address as sent and the address
 * with visible ASCII decoded from `%XX`, with the token as it is and with
 * each backslash as a slash. A token holds only visible ASCII, so this also
 * covers each decoded name and value of the query. It
 * guards against mistakes, such as a token pasted into a parameter, not
 * against code that sets out to hide the token in another encoding.
 *
 * @param target - The address to request.
 * @param origin - The origin of the transport, as its configuration gave it.
 * @param token - The token the transport sends in its header.
 * @returns The path with the query, or the code of the broken rule. Never
 *   the target itself.
 * @throws {TypeError} When the target is not a URL.
 * @example
 * ```ts
 * checkRequestTarget(
 *   new URL('https://example.church.tools/api/whoami'),
 *   'https://example.church.tools',
 *   token,
 * );
 * // { ok: true, path: '/api/whoami' }
 * ```
 */
export function checkRequestTarget(
  target: URL,
  origin: string,
  token: Secret,
): TargetResult {
  const url = new URL(serialise(target));
  const address = url.href;
  if (url.protocol !== 'https:') return refuse('target_not_https');
  if (url.username !== '' || url.password !== '') {
    return refuse('target_credentials');
  }
  if (url.origin !== origin) return refuse('target_origin');
  // An empty fragment leaves hash empty but stays in the address.
  if (address.includes('#')) return refuse('target_fragment');
  if (url.pathname.startsWith('//')) return refuse('target_path');
  for (const name of url.searchParams.keys()) {
    const base = baseOfName(name);
    if (base === undefined) return refuse('target_parameter_name');
    if (forbiddenParameters.includes(base.toLowerCase())) {
      return refuse('target_forbidden_parameter');
    }
  }
  const value = revealSecret(token);
  // The parser turns a backslash in the path of an https address into a
  // slash, so a token with a backslash reaches the path in that form.
  const values = [value, value.replaceAll('\\', '/')];
  const forms = [address, decodeVisibleAscii(address)];
  if (forms.some((form) => values.some((shape) => form.includes(shape)))) {
    return refuse('target_token');
  }
  return Object.freeze({
    __proto__: null,
    ok: true,
    path: `${url.pathname}${url.search}`,
  });
}

// Whether a segment of a path is the ID of an object as ChurchTools gives
// it: a whole number from 1 in decimal digits without a leading zero, at
// most a safe integer. Character by character, as the names of parameters.
const isIdSegment = (segment: string | undefined): boolean => {
  if (segment === undefined || segment.length < 1 || segment.length > 16) {
    return false;
  }
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code < 0x30 || code > 0x39 || (index === 0 && code === 0x30)) {
      return false;
    }
  }
  return Number(segment) <= Number.MAX_SAFE_INTEGER;
};

// The two forms of path DELETE may reach: one appointment of a calendar
// and one booking. Ecclium takes back only appointments and bookings it
// created and nobody changed since; it never deletes a page of the wiki, a
// person or a group (ADR 0072).
const isDeletablePath = (path: string): boolean => {
  const parts = path.split('/');
  if (parts[0] !== '' || parts[1] !== 'api') return false;
  if (parts.length === 6) {
    return (
      parts[2] === 'calendars' &&
      isIdSegment(parts[3]) &&
      parts[4] === 'appointments' &&
      isIdSegment(parts[5])
    );
  }
  return parts.length === 4 && parts[2] === 'bookings' && isIdSegment(parts[3]);
};

/**
 * Checks what a write may reach, after {@link checkRequestTarget} has given
 * the path (ADR 0072). A write carries its values in its body, never in a
 * query, so no value of a write reaches the access log of the server. A
 * DELETE reaches only `/api/calendars/{id}/appointments/{id}` and
 * `/api/bookings/{id}`, each ID a whole number from 1. A GET passes.
 *
 * @param method - The method of the request.
 * @param path - The path with the query, as `checkRequestTarget` gave it.
 * @returns The code of the broken rule, or undefined when the target fits.
 * @example
 * ```ts
 * checkWriteTarget('DELETE', '/api/bookings/12'); // undefined
 * checkWriteTarget('DELETE', '/api/wiki/categories/1/pages/x'); // 'target_delete_path'
 * ```
 */
export function checkWriteTarget(
  method: HttpMethod,
  path: string,
): TargetCode | undefined {
  if (method === 'GET') return undefined;
  if (path.includes('?')) return 'target_write_query';
  if (method === 'DELETE' && !isDeletablePath(path)) {
    return 'target_delete_path';
  }
  return undefined;
}
