/**
 * Reads the address of the ping of the runner from a file (ADR 0009, ADR
 * 0035), in the format of Healthchecks, such as
 * `https://hc-ping.com/<uuid>`. Its path works like a secret: whoever
 * knows it can report to the check. So the file gets the checks of the
 * token file, by the same reader, the address the checks of
 * `parsePingUrl`, and the address stays a `Secret` until the transport to
 * the ping opens it. Every refusal keeps its reason under a name of its
 * own, so that a message names this file, not the token file.
 *
 * Where it stands: at the start of the runner. A server never pings, so
 * it checks the form of the path alone and never reads the file.
 *
 * @packageDocumentation
 */
import { parsePingUrl, Secret } from '../http/index.js';
import {
  readTokenFile,
  type TokenFileCode,
  type TokenFileSystem,
} from './token-file.js';

// Each reason of the reader of the token file under the name it has for
// this file. Written out, not built from the names, so that a new reason
// of the reader fails the type check here instead of passing unnamed. The
// codes come from a closed list, so no lookup reaches the prototype.
const fromTokenFile: Readonly<Record<TokenFileCode, PingUrlFileCode>> =
  Object.freeze({
    token_file_relative: 'ping_url_file_relative',
    token_file_platform: 'ping_url_file_platform',
    token_file_missing: 'ping_url_file_missing',
    token_file_symlink: 'ping_url_file_symlink',
    token_file_unreadable: 'ping_url_file_unreadable',
    token_file_not_regular: 'ping_url_file_not_regular',
    token_file_owner: 'ping_url_file_owner',
    token_file_mode: 'ping_url_file_mode',
    token_file_too_large: 'ping_url_file_too_large',
    token_file_empty: 'ping_url_file_empty',
    token_file_bom: 'ping_url_file_bom',
    token_file_characters: 'ping_url_file_characters',
    token_file_unsafe: 'ping_url_file_unsafe',
    token_invalid: 'ping_url_invalid',
  });

/**
 * The reasons to refuse the file of the address of the ping, frozen, in
 * the order of the reasons of the token file. A code never carries the
 * path or the content of the file.
 */
export const pingUrlFileCodes = Object.freeze([
  'ping_url_file_relative',
  'ping_url_file_platform',
  'ping_url_file_missing',
  'ping_url_file_symlink',
  'ping_url_file_unreadable',
  'ping_url_file_not_regular',
  'ping_url_file_owner',
  'ping_url_file_mode',
  'ping_url_file_too_large',
  'ping_url_file_empty',
  'ping_url_file_bom',
  'ping_url_file_characters',
  'ping_url_file_unsafe',
  'ping_url_invalid',
] as const);

/** The reason to refuse the file of the address of the ping. */
export type PingUrlFileCode = (typeof pingUrlFileCodes)[number];

/** The address of the ping, and what a report may show of it. */
export interface PingUrl {
  /** The whole address, which only the transport to the ping opens. */
  readonly url: Secret;
  /** The host of the address, which is no secret. */
  readonly host: string;
  /** Its port, or empty for the default port 443. */
  readonly port: string;
}

/** The address, or the reason to refuse the file. */
export type PingUrlFileResult =
  | { readonly ok: true; readonly value: PingUrl }
  | { readonly ok: false; readonly code: PingUrlFileCode };

// Checks the address and wraps it. A RangeError makes the reader refuse
// the file as `token_invalid`; its message never shows the address.
const wrap = (value: string): PingUrl => {
  const checked = parsePingUrl(value);
  if (!checked.ok) {
    throw new RangeError('The address of the ping is refused.');
  }
  const url = new Secret(value);
  // The checked origin is https://host or https://host:port.
  const port = checked.origin.slice(`https://${checked.host}`.length + 1);
  return Object.freeze({ url, host: checked.host, port });
};

/**
 * Reads the address of the ping from a file. The checks of the file are
 * those of the token file; the content must be one address as
 * `parsePingUrl` takes it, with one line ending at most.
 *
 * Folders above the file are trusted: no flag of open checks them.
 *
 * @param path - The absolute path of the file.
 * @param fs - The file functions, only for tests.
 * @returns The address with its host and port, or the code of the first
 *   check that failed.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const ping = readPingUrlFile('/run/secrets/ping_url');
 * if (!ping.ok) report(ping.code);
 * ```
 */
export function readPingUrlFile(
  path: string,
  fs?: TokenFileSystem,
): PingUrlFileResult {
  const read = readTokenFile(path, wrap, fs);
  if (read.ok) {
    return Object.freeze({ __proto__: null, ok: true, value: read.value });
  }
  return Object.freeze({
    __proto__: null,
    ok: false,
    code: fromTokenFile[read.code],
  });
}
