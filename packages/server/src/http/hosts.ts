/**
 * The hosts a request over HTTP may name in `Host` and `Origin`, against
 * DNS rebinding (ADR 0073, threat T21). An entry is a name with or without
 * a port, and a header matches it only as it stands: an entry without a
 * port allows the name without a port and nothing else.
 *
 * The grammar of the entries lives in the configuration of core, so that
 * the loader reads `ECCLIUM_ALLOWED_HOSTS` as this place does; this module
 * passes it on. The headers are compared as text and never parsed: a
 * header that is not the spelling of an entry, such as `127.1`, a user
 * before an `@` or two values joined by a comma, matches none. Parsing a
 * header the way a URL parser does would let such forms through as equal
 * to an entry.
 *
 * @packageDocumentation
 */
import type { AllowedHost } from '@ecclium/mcp-churchtools-core';

export {
  type AllowedHost,
  type AllowedHostsResult,
  isAllowedHost,
  parseAllowedHost,
  parseAllowedHosts,
} from '@ecclium/mcp-churchtools-core';

/** The names of loopback, which `Origin` may also name with `http`. */
export const loopbackNames: readonly string[] = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

const printableAscii = /^[\x21-\x7e]+$/;

const isPort = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= 65_535;

/**
 * The entries of a server without a list: the names of loopback with the
 * port of the server (ADR 0073).
 *
 * @param serverPort - The port the server listens on, 1 to 65535.
 * @returns `localhost`, `127.0.0.1` and `[::1]`, each with the port.
 * @throws {RangeError} For a port outside 1 to 65535.
 * @example
 * ```ts
 * loopbackHosts(8787); // [{ name: 'localhost', port: 8787 }, ...]
 * ```
 */
export function loopbackHosts(serverPort: number): readonly AllowedHost[] {
  if (!isPort(serverPort)) {
    throw new RangeError('The port of the server lies outside 1 to 65535.');
  }
  return Object.freeze(
    loopbackNames.map((name) => Object.freeze({ name, port: serverPort })),
  );
}

/**
 * The spelling of an entry in `Host`: the name, then a colon and the port.
 *
 * @param host - An entry.
 * @returns The name with the port, or the name alone.
 * @example
 * ```ts
 * authorityOf({ name: '[::1]', port: 8787 }); // '[::1]:8787'
 * ```
 */
export function authorityOf(host: AllowedHost): string {
  return host.port === undefined
    ? host.name
    : `${host.name}:${String(host.port)}`;
}

/**
 * Whether a header `Host` is the spelling of an entry. Only letters of
 * ASCII count in either case; anything else must stand as in the entry.
 *
 * @param header - The value of `Host`, or `null` without one.
 * @param hosts - The entries.
 * @returns Whether the header names an entry.
 * @example
 * ```ts
 * hostAllowed('LOCALHOST:8787', loopbackHosts(8787)); // true
 * hostAllowed('localhost:8788', loopbackHosts(8787)); // false
 * ```
 */
export function hostAllowed(
  header: string | null,
  hosts: readonly AllowedHost[],
): boolean {
  if (header === null || !printableAscii.test(header)) return false;
  const value = header.toLowerCase();
  return hosts.some((host) => authorityOf(host) === value);
}

/**
 * Whether a header `Origin` may stand: without one, yes, else it must be
 * `https://` and the spelling of an entry, for the names of loopback also
 * `http://`, exactly as a browser writes an origin, in lower case and
 * without a path.
 *
 * @param header - The value of `Origin`, or `null` without one.
 * @param hosts - The entries.
 * @returns Whether the request may go on.
 * @example
 * ```ts
 * originAllowed('http://localhost:8787', loopbackHosts(8787)); // true
 * originAllowed('null', loopbackHosts(8787)); // false
 * ```
 */
export function originAllowed(
  header: string | null,
  hosts: readonly AllowedHost[],
): boolean {
  if (header === null) return true;
  return hosts.some((host) => {
    const authority = authorityOf(host);
    return (
      header === `https://${authority}` ||
      (loopbackNames.includes(host.name) && header === `http://${authority}`)
    );
  });
}
