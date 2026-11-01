/**
 * What the smoke test reads from the environment.
 *
 * The address and the token file have the names the server reads, so the
 * values of a client configuration fit unchanged. The switches for the
 * search tools and the escape hatch and the search terms carry the prefix
 * `ECCLIUM_SMOKE_`. The smoke test never hands them to the server, which
 * would refuse to start with a variable it does not know (ADR 0055).
 *
 * The smoke test reads the token itself, but sends it only with the switch,
 * for the reads of its guard (ADR 0049). Without the switch it reads the
 * token only to make sure that it appears nowhere in what the server
 * writes. The level of redaction and the key file for pseudonyms come
 * under the names of the server as well; the key it reads only for the
 * same search (ADR 0069).
 *
 * @packageDocumentation
 */
import { isAbsolute } from 'node:path';

import {
  checkNodeEnvironment,
  readPrivateFile,
  type Environment,
} from '../spike/lib/env.mts';
import { SpikeError } from '../spike/lib/errors.mts';
import { checkSwitch, placeholderHost } from '../spike/lib/gate.mts';

/** The variables the smoke test reads. It ignores every other one. */
export const smokeVariables = [
  'ECCLIUM_CHURCHTOOLS_URL',
  'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
  'ECCLIUM_REDACTION',
  'ECCLIUM_PSEUDONYM_KEY_FILE',
  'ECCLIUM_SMOKE_ALLOW_SEARCH',
  'ECCLIUM_SMOKE_ALLOW_API',
  'ECCLIUM_SMOKE_QUERY',
  'ECCLIUM_SMOKE_SONG_QUERY',
] as const;

/** What the smoke test needs for the search tools. */
export interface SearchSettings {
  /**
   * Whether the second switch lets the smoke test call the escape hatch,
   * which it takes only together with the switch for the search tools.
   */
  readonly api: boolean;
  /** The term both search tools get. Never printed. */
  readonly query: string;
  /**
   * The term the searches of songs get, for an instance whose songs do not
   * carry the term of the persons; without it they take that term. Never
   * printed.
   */
  readonly songQuery: string | undefined;
}

/** What the smoke test read from the environment. */
export interface SmokeSettings {
  /** Origin of the instance, such as `https://example.church.tools`. */
  readonly origin: string;
  /** Path of the token file, as the server gets it. */
  readonly tokenFile: string;
  /** The token, for the guard and for the search for leaks. */
  readonly token: string;
  /**
   * The level of redaction of the server, `standard` unless the
   * environment names `strict`.
   */
  readonly redaction: 'standard' | 'strict';
  /**
   * The key file and the key for pseudonyms, only with `strict`. The key
   * is only for the search for leaks; the server reads its own copy.
   */
  readonly pseudonymKey:
    { readonly file: string; readonly key: string } | undefined;
  /** Present only with the switch for the search tools. */
  readonly search: SearchSettings | undefined;
}

const maxTokenBytes = 4096;

/** The form of a key for pseudonyms, as `openssl rand -hex 32` writes it. */
const keyPattern = /^[0-9a-f]{64}$/;

/**
 * Reads the level of redaction and, with `strict`, the key file.
 *
 * Only `standard` and `strict` pass: with `off` the checks of the masks
 * would fail, and a key file without `strict` would do nothing in the
 * server, so the run would not test what its caller meant.
 *
 * @param env - Environment of the process.
 * @returns The level and, with `strict`, the key file and its key.
 * @throws {SpikeError} If the level is another one, the key file is missing with strict or set without it, relative, unsafe or not a key.
 */
export function readRedaction(
  env: Environment,
): Pick<SmokeSettings, 'redaction' | 'pseudonymKey'> {
  const level = env['ECCLIUM_REDACTION'] ?? '';
  const file = env['ECCLIUM_PSEUDONYM_KEY_FILE'] ?? '';
  if (level !== '' && level !== 'standard' && level !== 'strict') {
    throw new SpikeError('KONFIGURATION', 'smokeMaskierungUngueltig');
  }
  if (level !== 'strict') {
    if (file !== '') {
      throw new SpikeError('KONFIGURATION', 'smokeSchluesselOhneStrict');
    }
    return { redaction: 'standard', pseudonymKey: undefined };
  }
  if (file === '') {
    throw new SpikeError('KONFIGURATION', 'smokeSchluesselFehlt');
  }
  if (!isAbsolute(file)) {
    throw new SpikeError('KONFIGURATION', 'smokeSchluesselRelativ');
  }
  const key = readPrivateFile(
    file,
    maxTokenBytes,
    'smokeSchluesselUnsicher',
    'smokeSchluesselNichtGefunden',
  ).replace(/\n$/, '');
  if (!keyPattern.test(key)) {
    throw new SpikeError('DATEI', 'smokeSchluesselUngueltig');
  }
  return { redaction: 'strict', pseudonymKey: { file, key } };
}

/** The longest search term the search tools take (ADR 0060). */
export const maxQueryLength = 100;

/**
 * Reads the address of the instance.
 *
 * Only the canonical origin with `https` passes, the form the server takes:
 * no user, path, query, fragment, slash at the end or explicit port 443.
 *
 * @param env - Environment of the process.
 * @returns The origin.
 * @throws {SpikeError} If the variable is missing, has another form or is the placeholder of the docs.
 */
export function readSmokeOrigin(env: Environment): string {
  const raw = env['ECCLIUM_CHURCHTOOLS_URL'] ?? '';
  if (raw === '') {
    throw new SpikeError('KONFIGURATION', 'smokeAdresseFehlt');
  }
  const url = URL.parse(raw);
  if (url === null || url.protocol !== 'https:' || url.origin !== raw) {
    throw new SpikeError('KONFIGURATION', 'smokeAdresseUngueltig');
  }
  if (url.hostname === placeholderHost) {
    throw new SpikeError('KONFIGURATION', 'smokePlatzhalter');
  }
  return url.origin;
}

/**
 * Tells whether a text is a search term the search tools take unchanged:
 * 1 to 100 characters, no white space at either end, well formed and
 * without control characters (ADR 0060).
 *
 * @param text - The term from the environment.
 * @returns Whether the term fits.
 */
export function isSearchTerm(text: string): boolean {
  let control = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) control = true;
  }
  return (
    text.length >= 1 &&
    text.length <= maxQueryLength &&
    text === text.trim() &&
    text.isWellFormed() &&
    !control
  );
}

/**
 * Reads and checks everything the smoke test takes from the environment,
 * before it starts the server or sends a request.
 *
 * @param env - Environment of the process.
 * @returns The settings.
 * @throws {SpikeError} If Node.js would load foreign code or trust foreign certificates, the address or the token file is missing or unsafe, the token is in a variable, the level of redaction or the key file does not fit, the search term comes without the switch or the other way round, the switch does not fit the host, or the escape hatch comes with strict.
 */
export function readSmokeSettings(env: Environment): SmokeSettings {
  try {
    checkNodeEnvironment(env);
  } catch {
    throw new SpikeError('KONFIGURATION', 'smokeUmgebungUnsicher');
  }
  // The reads of the guard send the token. These variables would let
  // Node.js trust other certificates or send it through a proxy.
  for (const name of [
    'NODE_USE_SYSTEM_CA',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_USE_ENV_PROXY',
  ]) {
    if ((env[name] ?? '') !== '') {
      throw new SpikeError('KONFIGURATION', 'smokeUmgebungUnsicher');
    }
  }
  const origin = readSmokeOrigin(env);
  // The server would take the token from this variable too, but then the
  // smoke test would have to hand it on in the environment of the child.
  if ((env['ECCLIUM_CHURCHTOOLS_TOKEN'] ?? '') !== '') {
    throw new SpikeError('KONFIGURATION', 'smokeTokenVariable');
  }
  const tokenFile = env['ECCLIUM_CHURCHTOOLS_TOKEN_FILE'] ?? '';
  if (tokenFile === '') {
    throw new SpikeError('KONFIGURATION', 'smokeTokenDateiFehlt');
  }
  // The server takes only an absolute path; say so here, before it starts.
  if (!isAbsolute(tokenFile)) {
    throw new SpikeError('KONFIGURATION', 'smokeTokenDateiRelativ');
  }
  const token = readPrivateFile(
    tokenFile,
    maxTokenBytes,
    'smokeTokenDateiUnsicher',
    'smokeTokenDateiNichtGefunden',
  ).replace(/\r?\n$/, '');
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new SpikeError('DATEI', 'smokeTokenUngueltig');
  }
  const masking = readRedaction(env);

  const switchValue = env['ECCLIUM_SMOKE_ALLOW_SEARCH'] ?? '';
  const apiValue = env['ECCLIUM_SMOKE_ALLOW_API'] ?? '';
  const query = env['ECCLIUM_SMOKE_QUERY'] ?? '';
  const songQuery = env['ECCLIUM_SMOKE_SONG_QUERY'] ?? '';
  if (switchValue === '') {
    if (query !== '') {
      throw new SpikeError('KONFIGURATION', 'smokeSuchbegriffOhneSchalter');
    }
    if (songQuery !== '') {
      throw new SpikeError('KONFIGURATION', 'smokeLiedbegriffOhneSchalter');
    }
    // The escape hatch passes on whole answers, so it runs only behind the
    // guard of the test instance, which the switch for the search tools
    // starts (ADR 0049, ADR 0067).
    if (apiValue !== '') {
      throw new SpikeError('KONFIGURATION', 'smokeApiOhneSuchschalter');
    }
    return { origin, tokenFile, token, ...masking, search: undefined };
  }
  // As with the probes, the switch must name the first label of the host,
  // typed by hand, so that a mistyped address stops the run (ADR 0049).
  checkSwitch(env, origin, {
    variable: 'ECCLIUM_SMOKE_ALLOW_SEARCH',
    missing: 'smokeSchalterFehlt',
    wrong: 'smokeSchalterFalsch',
  });
  if (query === '') {
    throw new SpikeError('KONFIGURATION', 'smokeSuchbegriffFehlt');
  }
  if (!isSearchTerm(query)) {
    throw new SpikeError('KONFIGURATION', 'smokeSuchbegriffUngueltig');
  }
  if (songQuery !== '' && !isSearchTerm(songQuery)) {
    throw new SpikeError('KONFIGURATION', 'smokeLiedbegriffUngueltig');
  }
  // Typed by hand like the first switch, so that a copied address does not
  // turn on the escape hatch by mistake.
  if (apiValue !== '') {
    checkSwitch(env, origin, {
      variable: 'ECCLIUM_SMOKE_ALLOW_API',
      missing: 'smokeApiSchalterFalsch',
      wrong: 'smokeApiSchalterFalsch',
    });
    // With strict and the toolset api the server does not start (ADR
    // 0069); its tests show that, the smoke test says so before the start.
    if (masking.redaction === 'strict') {
      throw new SpikeError('KONFIGURATION', 'smokeApiMitStrict');
    }
  }
  return {
    origin,
    tokenFile,
    token,
    ...masking,
    search: {
      api: apiValue !== '',
      query,
      songQuery: songQuery === '' ? undefined : songQuery,
    },
  };
}
