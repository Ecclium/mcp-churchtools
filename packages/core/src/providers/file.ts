/**
 * Reads the file of the providers from `ECCLIUM_PROVIDERS_FILE` (ADR
 * 0033), with the checks of every file of the configuration: an absolute
 * path, opened without following a link, a regular file of the user that
 * group and others cannot write, at most 64 KiB, UTF-8 without a byte
 * order mark, and YAML through the one reader of the configuration. The
 * file holds no secret, so others may read it.
 *
 * @packageDocumentation
 */
import {
  type ConfigFileSystem,
  readConfigTextFile,
} from '../config/text-file.js';
import { readConfigYaml } from '../config/yaml.js';
import {
  checkProviders,
  type ProviderSettings,
  providersCheckCodes,
} from './schema.js';

/** The reasons to refuse the file itself, frozen. */
export const providersFileCodes = Object.freeze([
  'providers_file_relative',
  'providers_file_platform',
  'providers_file_missing',
  'providers_file_symlink',
  'providers_file_unreadable',
  'providers_file_not_regular',
  'providers_file_owner',
  'providers_file_mode',
  'providers_file_too_large',
  'providers_file_bom',
  'providers_file_encoding',
  'providers_file_unsafe',
] as const);

/** The reasons to refuse the text of the file as YAML, frozen. */
export const providersYamlCodes = Object.freeze([
  'providers_yaml_syntax',
  'providers_yaml_unsupported',
] as const);

/**
 * Every reason to refuse the file of the providers, frozen: the file, its
 * YAML and the check of `providers.v1`.
 */
export const providersCodes = Object.freeze([
  ...providersFileCodes,
  ...providersYamlCodes,
  ...providersCheckCodes,
] as const);

/** A reason to refuse the file of the providers. */
export type ProvidersCode = (typeof providersCodes)[number];

/** The checked providers, or why the file holds none. */
export type ProvidersFileResult =
  | { readonly ok: true; readonly providers: readonly ProviderSettings[] }
  | {
      readonly ok: false;
      readonly code: ProvidersCode;
      /** The path of a field, such as `providers[0].endpoint`. */
      readonly field?: string;
      /** The line of a problem of YAML, from 1. */
      readonly line?: number;
    };

/** The most bytes the file of the providers may hold: 64 KiB. */
export const maxProvidersFileBytes = 65_536;

/**
 * Reads, parses and checks the file of the providers. The path must be
 * absolute. Folders above the file are trusted: no flag of open checks
 * them.
 *
 * @param path - The absolute path of the file.
 * @param fs - The file functions, only for tests.
 * @returns The checked providers, or the code of the first check that
 *   failed with the path of the field or the line. It never throws for a
 *   file.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const read = readProvidersFile('/path/to/providers.yaml');
 * if (!read.ok) report(read.code, read.field, read.line);
 * ```
 */
export function readProvidersFile(
  path: string,
  fs?: ConfigFileSystem,
): ProvidersFileResult {
  if (typeof path !== 'string') {
    throw new TypeError(
      'The path of the file of the providers must be a string.',
    );
  }
  const read = readConfigTextFile(path, maxProvidersFileBytes, fs);
  if (!read.ok) {
    return Object.freeze({
      __proto__: null,
      ok: false,
      code: `providers_file_${read.reason}` as const,
    });
  }
  const yaml = readConfigYaml(read.text);
  if (!yaml.ok) {
    return Object.freeze({
      __proto__: null,
      ok: false,
      code: `providers_${yaml.code}` as const,
      ...(yaml.line === undefined ? {} : { line: yaml.line }),
    });
  }
  return checkProviders(yaml.value);
}
