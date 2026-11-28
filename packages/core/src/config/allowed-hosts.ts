/**
 * The grammar of the hosts a request over HTTP may name in `Host` and
 * `Origin`, against DNS rebinding (ADR 0073, threat T21), and of the
 * address the server over HTTP binds to. It lives in the configuration, so
 * that the loader, `ecclium config check` and the server read
 * `ECCLIUM_ALLOWED_HOSTS` and `ECCLIUM_HTTP_ADDRESS` alike; the comparison
 * of the headers stays in the way in of the server.
 *
 * An entry is a name with or without a port, and only in its canonical
 * form, so that one entry has one spelling. Parsing an entry the way a URL
 * parser does would let forms such as `127.1` or a user before an `@`
 * through as equal to an entry.
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

/**
 * The longest value of `ECCLIUM_ALLOWED_HOSTS`: 16 names of 253 characters
 * with the highest port and the commas, far more than a server answers
 * for.
 */
export const maxAllowedHostsLength = 16 * (253 + ':65535'.length + 1) - 1;

// One label of a DNS name: letters, digits and hyphens, at most 63, no
// hyphen at either end.
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// What a URL parser reads as a number at the end of a name: decimal
// digits, or 0x with hex digits or none (the rule ends-in-a-number of the
// WHATWG URL standard).
const number = /^(?:[0-9]+|0x[0-9a-f]*)$/;
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
  return labels.every((part) => label.test(part)) && !number.test(last);
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
  if (typeof text !== 'string' || !printableAscii.test(text)) return undefined;
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
 * Reads a list of entries separated by commas, the form of
 * `ECCLIUM_ALLOWED_HOSTS`. Spaces around an entry do not count. A list
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
  if (typeof text !== 'string') return Object.freeze({ ok: false, entry: 0 });
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
 * Whether a text is an address the server over HTTP may bind to: an IPv4
 * or IPv6 address written out in the canonical form of the entries, IPv6
 * without brackets, never a name such as `localhost`, so that the address
 * does not depend on a lookup.
 *
 * @param text - The address, such as `127.0.0.1` or `::1`.
 * @returns Whether it is one.
 * @example
 * ```ts
 * isHttpBindAddress('0.0.0.0'); // true
 * isHttpBindAddress('localhost'); // false
 * isHttpBindAddress('[::1]'); // false
 * ```
 */
export function isHttpBindAddress(text: string): boolean {
  if (typeof text !== 'string') return false;
  if (isIpv4(text)) return true;
  return text.length > 0 && !text.includes('[') && isCanonicalIpv6(text);
}

/**
 * The addresses of loopback the server over HTTP binds to without a list
 * of allowed hosts (ADR 0073).
 */
export const loopbackBindAddresses: readonly string[] = Object.freeze([
  '127.0.0.1',
  '::1',
]);
