/**
 * The hosts a request over HTTP may name in `Host` and `Origin`, against
 * DNS rebinding (ADR 0073, threat T21). An entry is a name with or without
 * a port, and a header matches it only as it stands: an entry without a
 * port allows the name without a port and nothing else.
 *
 * The entries follow a grammar of their own and only in their canonical
 * form, so that one entry has one spelling. The headers are then compared
 * as text and never parsed: a header that is not the spelling of an entry,
 * such as `127.1`, a user before an `@` or two values joined by a comma,
 * matches none. Parsing a header the way a URL parser does would let such
 * forms through as equal to an entry.
 *
 * @packageDocumentation
 */

/** A host a request may name: a name and, if the entry has one, a port. */
export interface AllowedHost {
  /**
   * The name in lower case: a DNS name, an IPv4 address or an IPv6
   * address in brackets.
   */
  readonly name: string;
  /** The port of the entry, or `undefined` for an entry without one. */
  readonly port: number | undefined;
}

/** What {@link parseAllowedHosts} gives back. */
export type AllowedHostsResult =
  | { readonly ok: true; readonly hosts: readonly AllowedHost[] }
  | {
      readonly ok: false;
      /**
       * The place of the first entry that is no host, counted from 1, or 0
       * for a list without entries. Never the entry itself.
       */
      readonly entry: number;
    };

/** The names of loopback, which `Origin` may also name with `http`. */
export const loopbackNames: readonly string[] = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

// One label of a DNS name: letters, digits and hyphens, at most 63, no
// hyphen at either end.
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const decimal = /^[0-9]+$/;
const octet = /^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
const port = /^[1-9][0-9]{0,4}$/;
const ipv6Characters = /^[0-9a-f:.]{2,45}$/;
const printableAscii = /^[\x21-\x7e]+$/;

const isIpv4 = (text: string): boolean => {
  const parts = text.split('.');
  return parts.length === 4 && parts.every((part) => octet.test(part));
};

// A DNS name whose last label is a number would be read as an IPv4 address
// by a URL parser ("127.1"), so only the four parts of an address in their
// canonical form count as one, and a name never ends in a number.
const isDnsName = (text: string): boolean => {
  if (text.length > 253) return false;
  const labels = text.split('.');
  const last = labels.at(-1) ?? '';
  return labels.every((part) => label.test(part)) && !decimal.test(last);
};

// An IPv6 address only in the form a URL parser writes it, compressed and
// in lower case, so that an entry has one spelling.
const isCanonicalIpv6 = (text: string): boolean => {
  if (!ipv6Characters.test(text)) return false;
  try {
    return new URL(`http://[${text}]/`).hostname === `[${text}]`;
  } catch {
    return false;
  }
};

const isName = (name: string): boolean =>
  name.startsWith('[') && name.endsWith(']')
    ? isCanonicalIpv6(name.slice(1, -1))
    : isIpv4(name) || isDnsName(name);

const isPort = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= 65_535;

/**
 * Reads one entry in its canonical form: a name in lower case, then
 * optionally a colon and a port from 1 to 65535 without a leading zero.
 * Upper case letters count as lower case, everything else must stand as
 * the grammar writes it.
 *
 * @param text - One entry, such as `mcp.example.org` or `[::1]:8787`.
 * @returns The entry, or `undefined` when the text is no entry.
 * @example
 * ```ts
 * parseAllowedHost('Mcp.Example.org:8443'); // { name: 'mcp.example.org', port: 8443 }
 * parseAllowedHost('127.1'); // undefined
 * ```
 */
export function parseAllowedHost(text: string): AllowedHost | undefined {
  if (!printableAscii.test(text)) return undefined;
  const entry = text.toLowerCase();
  // The port follows the last colon, unless that colon is inside the
  // brackets of an IPv6 address.
  const colon = entry.lastIndexOf(':');
  const hasPort = colon > entry.lastIndexOf(']');
  const name = hasPort ? entry.slice(0, colon) : entry;
  const digits = hasPort ? entry.slice(colon + 1) : undefined;
  if (!isName(name)) return undefined;
  if (digits === undefined) return Object.freeze({ name, port: undefined });
  if (!port.test(digits) || !isPort(Number(digits))) return undefined;
  return Object.freeze({ name, port: Number(digits) });
}

/**
 * Reads a list of entries separated by commas, the form in which the
 * command for the server over HTTP will read `ECCLIUM_ALLOWED_HOSTS`.
 * Spaces around an entry do not count. A list
 * without entries, an empty entry and an entry that is no host end the
 * reading; the result names only the place of the entry, never its text.
 *
 * @param text - The list, such as `mcp.example.org, localhost:8787`.
 * @returns The entries in their order without repeats, or the place of the
 *   first one that is no host.
 * @example
 * ```ts
 * parseAllowedHosts('mcp.example.org'); // { ok: true, hosts: [...] }
 * ```
 */
export function parseAllowedHosts(text: string): AllowedHostsResult {
  const entries = text.split(',').map((entry) => entry.trim());
  if (entries.length === 1 && entries[0] === '') {
    return Object.freeze({ ok: false, entry: 0 });
  }
  const hosts: AllowedHost[] = [];
  for (const [index, entry] of entries.entries()) {
    const host = parseAllowedHost(entry);
    if (host === undefined) {
      return Object.freeze({ ok: false, entry: index + 1 });
    }
    const known = hosts.some(
      (other) => other.name === host.name && other.port === host.port,
    );
    if (!known) hosts.push(host);
  }
  return Object.freeze({ ok: true, hosts: Object.freeze(hosts) });
}

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
 * Whether a value has the form of an entry this module gives out, so that
 * a caller cannot pass an entry the grammar would refuse.
 *
 * @param value - Anything.
 * @returns Whether it is an entry in its canonical form.
 * @example
 * ```ts
 * isAllowedHost({ name: 'mcp.example.org', port: undefined }); // true
 * isAllowedHost({ name: '127.1', port: undefined }); // false
 * ```
 */
export function isAllowedHost(value: unknown): value is AllowedHost {
  if (typeof value !== 'object' || value === null) return false;
  const { name, port: entryPort } = value as Readonly<Record<string, unknown>>;
  if (typeof name !== 'string' || !isName(name)) return false;
  return (
    entryPort === undefined ||
    (typeof entryPort === 'number' && isPort(entryPort))
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
