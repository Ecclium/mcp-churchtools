/**
 * Reads and checks everything a probe takes from its environment.
 *
 * The probes run with a real token against a real instance. Before they
 * send a request, they refuse an environment in which Node.js could load
 * foreign code or trust a foreign certificate, and they check the token
 * file and the state file closely: no link, owned by the caller, no access
 * for others, small, outside every Git working tree. Files are opened
 * without following links and checked on the open handle, so they cannot
 * be swapped between check and read.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { SpikeError, type HintKey } from './errors.mts';
import { asOpenApi, isObject, type OpenApiDocument } from './spec.mts';

/** Variables the probes read. Every other variable is ignored. */
export const spikeVariables = [
  'ECCLIUM_SPIKE_BASE_URL',
  'ECCLIUM_SPIKE_TOKEN_FILE',
  'ECCLIUM_SPIKE_STATE_FILE',
  'ECCLIUM_SPIKE_WIKI_CATEGORY_ID',
  'ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID',
] as const;

/** The environment of a probe, as far as the probes read it. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The state that 00-inventory writes and the other probes read. */
export interface SpikeState {
  readonly format: 'ecclium-spike-state.v1';
  /** SHA-256 of the origin, so that a state is not used for another instance. */
  readonly instance: string;
  /** ChurchTools version as major and minor number, if the instance names it. */
  readonly version: string | null;
  /** The OpenAPI document the instance published when 00-inventory ran. */
  readonly specification: OpenApiDocument;
}

const maxTokenBytes = 4096;
const maxStateBytes = 64 * 1024 * 1024;

/**
 * Refuses an environment in which Node.js loads foreign code or trusts
 * foreign certificates.
 *
 * `NODE_OPTIONS` can load code before the probe starts, `NODE_PATH` and
 * `NODE_DEBUG` change what is loaded and printed, and `NODE_EXTRA_CA_CERTS`
 * or `NODE_TLS_REJECT_UNAUTHORIZED=0` would let a third party read the
 * token on its way.
 *
 * @param env - Environment of the process.
 * @throws {SpikeError} If one of these variables is set.
 */
export function checkNodeEnvironment(env: Environment): void {
  const set = (name: string): boolean => (env[name] ?? '') !== '';
  if (
    set('NODE_OPTIONS') ||
    set('NODE_DEBUG') ||
    set('NODE_PATH') ||
    set('NODE_EXTRA_CA_CERTS') ||
    env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0'
  ) {
    throw new SpikeError('KONFIGURATION', 'umgebungUnsicher');
  }
}

/**
 * Reads the base URL of the instance.
 *
 * Only an `https` address without user, path, query or fragment is
 * accepted, so the token can go to exactly one origin.
 *
 * @param env - Environment of the process.
 * @returns The origin, such as `https://example.church.tools`.
 * @throws {SpikeError} If the variable is missing or has another form.
 */
export function readOrigin(env: Environment): string {
  const raw = env['ECCLIUM_SPIKE_BASE_URL'] ?? '';
  if (raw === '') {
    throw new SpikeError('KONFIGURATION', 'basisUrlFehlt');
  }
  const url = URL.parse(raw);
  if (
    url === null ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    /[?#@]/.test(raw)
  ) {
    throw new SpikeError('KONFIGURATION', 'basisUrlUngueltig');
  }
  return url.origin;
}

/**
 * Reads a wiki category ID from the environment.
 *
 * @param env - Environment of the process.
 * @param name - Name of the variable.
 * @param required - Whether the variable must be set.
 * @returns The ID, or `undefined` if an optional variable is not set.
 * @throws {SpikeError} If the variable is required and missing, or has another form.
 */
export function readCategoryId(
  env: Environment,
  name:
    'ECCLIUM_SPIKE_WIKI_CATEGORY_ID' | 'ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID',
  required: boolean,
): number | undefined {
  const raw = env[name] ?? '';
  const hint: HintKey =
    name === 'ECCLIUM_SPIKE_WIKI_CATEGORY_ID'
      ? 'kategorieFehlt'
      : 'gesperrteKategorieUngueltig';
  if (raw === '') {
    if (required) {
      throw new SpikeError('KONFIGURATION', hint);
    }
    return undefined;
  }
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    throw new SpikeError('KONFIGURATION', hint);
  }
  return Number(raw);
}

/**
 * Tells whether a path lies inside a Git working tree.
 *
 * A token or state file there could end up in a commit.
 *
 * @param path - Path of a file.
 * @returns Whether a folder above the file contains `.git`.
 */
export function isInsideGitWorkTree(path: string): boolean {
  let folder = dirname(resolve(path));
  for (;;) {
    if (existsSync(join(folder, '.git'))) {
      return true;
    }
    const parent = dirname(folder);
    if (parent === folder) {
      return false;
    }
    folder = parent;
  }
}

function readPrivateFile(
  path: string,
  maxBytes: number,
  hint: HintKey,
  missingHint: HintKey,
): string {
  if (isInsideGitWorkTree(path)) {
    throw new SpikeError('DATEI', hint);
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const missing = isObject(error) && error['code'] === 'ENOENT';
    throw new SpikeError('DATEI', missing ? missingHint : hint);
  }
  try {
    const stats = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !stats.isFile() ||
      (owner !== undefined && stats.uid !== owner) ||
      (stats.mode & 0o077) !== 0 ||
      stats.size > maxBytes
    ) {
      throw new SpikeError('DATEI', hint);
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Reads the ChurchTools token from its file.
 *
 * @param env - Environment of the process.
 * @returns The token.
 * @throws {SpikeError} If the file is missing, unsafe or not exactly one line of printable ASCII.
 */
export function readToken(env: Environment): string {
  const path = env['ECCLIUM_SPIKE_TOKEN_FILE'] ?? '';
  if (path === '') {
    throw new SpikeError('KONFIGURATION', 'tokenDateiFehlt');
  }
  const content = readPrivateFile(
    path,
    maxTokenBytes,
    'tokenDateiUnsicher',
    'tokenDateiNichtGefunden',
  );
  const token = content.replace(/\r?\n$/, '');
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new SpikeError('DATEI', 'tokenUngueltig');
  }
  return token;
}

/**
 * Computes the value that ties a state to its instance.
 *
 * @param origin - Origin of the instance.
 * @returns SHA-256 of the origin, as hexadecimal text.
 */
export function instanceId(origin: string): string {
  return createHash('sha256').update(origin).digest('hex');
}

/**
 * Reads the path of the state file from the environment.
 *
 * @param env - Environment of the process.
 * @returns The path.
 * @throws {SpikeError} If the variable is missing.
 */
export function statePath(env: Environment): string {
  const path = env['ECCLIUM_SPIKE_STATE_FILE'] ?? '';
  if (path === '') {
    throw new SpikeError('KONFIGURATION', 'stateDateiFehlt');
  }
  return path;
}

/**
 * Checks, before the first request, that 00-inventory can create the state
 * file.
 *
 * {@link createState} checks again when it creates the file. This check
 * only spares the requests of a run that could not keep its result.
 *
 * @param path - Path of the state file.
 * @throws {SpikeError} If the path exists, even as a link, or lies inside a Git working tree.
 */
export function checkNewState(path: string): void {
  if (isInsideGitWorkTree(path)) {
    throw new SpikeError('DATEI', 'stateDateiUnsicher');
  }
  let exists: boolean;
  try {
    exists = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    throw new SpikeError('DATEI', 'stateDateiUnsicher');
  }
  if (exists) {
    throw new SpikeError('DATEI', 'stateDateiVorhanden');
  }
}

/**
 * Creates the state file. It must not exist yet.
 *
 * The file is created exclusively with mode 0600, so no other process can
 * have prepared it, and nobody else can read it.
 *
 * @param path - Path of the state file.
 * @param state - The state to write.
 * @throws {SpikeError} If the file exists or cannot be created safely.
 */
export function createState(path: string, state: SpikeState): void {
  if (isInsideGitWorkTree(path)) {
    throw new SpikeError('DATEI', 'stateDateiUnsicher');
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    const exists = isObject(error) && error['code'] === 'EEXIST';
    throw new SpikeError(
      'DATEI',
      exists ? 'stateDateiVorhanden' : 'stateDateiUnsicher',
    );
  }
  try {
    writeSync(descriptor, JSON.stringify(state));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Reads the state file that 00-inventory wrote for this instance.
 *
 * @param path - Path of the state file.
 * @param origin - Origin of the instance the probe talks to.
 * @returns The state.
 * @throws {SpikeError} If the file is unsafe, damaged or belongs to another instance.
 */
export function readState(path: string, origin: string): SpikeState {
  const content = readPrivateFile(
    path,
    maxStateBytes,
    'stateDateiUnsicher',
    'stateDateiNichtGefunden',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new SpikeError('DATEI', 'stateDateiUngueltig');
  }
  if (
    !isObject(parsed) ||
    parsed['format'] !== 'ecclium-spike-state.v1' ||
    parsed['instance'] !== instanceId(origin) ||
    !(typeof parsed['version'] === 'string' || parsed['version'] === null) ||
    asOpenApi(parsed['specification']) === undefined
  ) {
    throw new SpikeError('DATEI', 'stateDateiUngueltig');
  }
  return parsed as unknown as SpikeState;
}
