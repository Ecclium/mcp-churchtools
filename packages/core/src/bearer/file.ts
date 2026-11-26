/**
 * The file of the static bearer tokens (ADR 0074), named by
 * `ECCLIUM_HTTP_TOKENS_FILE`: how it reads, what it may hold and how it is
 * written.
 *
 * It holds only hashes, never a token. Each entry has a neutral name, the
 * SHA-256 of its token, its scopes, the day it came into being and the
 * last day it holds. Two entries may share a name for the seven days of a
 * rotation; no two share a hash. A token holds at most 365 days.
 *
 * Where it stands: the server reads it for every request with a token,
 * and the commands `ecclium token` read and write it. The reader of the
 * files of the configuration opens it without following a link and checks
 * it on the open descriptor: a regular file of the user that group and
 * others do not write, because whoever writes it decides who may use the
 * server. Then the reader of YAML and the schema below take over.
 *
 * The serializer writes a fixed form with every value in double quotes,
 * so that a name such as `null` or a hash of digits stays a string. Every
 * value it writes has only letters, digits and hyphens.
 *
 * Nothing here returns or throws the path, a message of the system or a
 * value of the file: a refusal is a code, with the path of a field or a
 * line.
 *
 * @packageDocumentation
 */
import { isIsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  type ConfigFileSystem,
  readConfigTextFile,
} from '../config/text-file.js';
import { readConfigYaml } from '../config/yaml.js';
import {
  type BearerScope,
  type BearerTokenEntry,
  isBearerTokenName,
} from './token.js';

/** The version of the file this code reads and writes. */
export const bearerTokensFileVersion = 1;

/** The most entries the file may hold. */
export const maxBearerTokens = 64;

/** The most bytes the file may hold: 64 KiB. */
export const maxBearerTokensFileBytes = 65_536;

/** The most days a token may hold, counted from the day it came into being. */
export const maxBearerTokenDays = 365;

/** The days a new token holds unless the operator names others. */
export const defaultBearerTokenDays = 180;

/** The days an old token still holds after a rotation, at most. */
export const bearerRotationDays = 7;

/** The reasons to refuse the file itself, frozen. */
export const bearerTokensFileCodes = Object.freeze([
  'bearer_tokens_file_relative',
  'bearer_tokens_file_platform',
  'bearer_tokens_file_missing',
  'bearer_tokens_file_symlink',
  'bearer_tokens_file_unreadable',
  'bearer_tokens_file_not_regular',
  'bearer_tokens_file_owner',
  'bearer_tokens_file_mode',
  'bearer_tokens_file_too_large',
  'bearer_tokens_file_bom',
  'bearer_tokens_file_encoding',
  'bearer_tokens_file_unsafe',
] as const);

/**
 * Every reason to refuse the file, frozen: of the file, of its YAML, of
 * its version and of its entries.
 */
export const bearerTokensCodes = Object.freeze([
  ...bearerTokensFileCodes,
  'bearer_tokens_yaml_syntax',
  'bearer_tokens_yaml_unsupported',
  'bearer_tokens_version_unknown',
  'bearer_tokens_invalid',
  'bearer_tokens_duplicate',
] as const);

/** A reason to refuse the file of the tokens. */
export type BearerTokensCode = (typeof bearerTokensCodes)[number];

/** The checked entries, or why the file holds none. */
export type BearerTokensFileResult =
  | {
      readonly ok: true;
      readonly entries: readonly BearerTokenEntry[];
    }
  | {
      readonly ok: false;
      readonly code: BearerTokensCode;
      /** The path of a field, such as `tokens[2].expiresAt`. */
      readonly field?: string;
      /** The line of a problem of YAML, from 1. */
      readonly line?: number;
    };

/**
 * The day that lies a number of days after another.
 *
 * @param day - A UTC day as `YYYY-MM-DD`.
 * @param days - Whole days, also negative.
 * @returns The day, as `YYYY-MM-DD`.
 * @throws {TypeError} When the day is no day of the calendar or the days
 *   are no safe integer.
 * @example
 * ```ts
 * addDays('2026-11-26', 180); // '2027-05-25'
 * ```
 */
export function addDays(day: string, days: number): string {
  if (!isIsoDate(day) || !Number.isSafeInteger(days)) {
    throw new TypeError('The day or the number of days is invalid.');
  }
  const time =
    Date.UTC(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      Number(day.slice(8, 10)),
    ) +
    days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

const daySchema = z.string().refine((value) => isIsoDate(value));

const scopesSchema = z.union([
  z.tuple([z.literal('read')]),
  z.tuple([z.literal('read'), z.literal('write')]),
]);

const entrySchema = z
  .strictObject({
    name: z.string().refine((value) => isBearerTokenName(value)),
    sha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    scopes: scopesSchema,
    createdAt: daySchema,
    expiresAt: daySchema,
  })
  .superRefine((entry, context) => {
    // zod runs this also when a field failed already; such a field has its
    // issue, and the days are compared only when both are days.
    if (!isIsoDate(entry.createdAt) || !isIsoDate(entry.expiresAt)) return;
    // A token holds from the day it came into being for at most a year.
    if (
      entry.expiresAt < entry.createdAt ||
      entry.expiresAt > addDays(entry.createdAt, maxBearerTokenDays)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'out of range',
      });
    }
  });

const fileSchema = z.strictObject({
  version: z.literal(bearerTokensFileVersion),
  tokens: z.array(entrySchema).max(maxBearerTokens),
});

// The path of a field from the path of an issue, such as tokens[2].name.
const fieldOf = (path: readonly PropertyKey[]): string | undefined => {
  let field = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      field += `[${String(segment)}]`;
    } else if (typeof segment === 'string') {
      field += field === '' ? segment : `.${segment}`;
    } else {
      break;
    }
  }
  return field === '' ? undefined : field;
};

const refuse = (
  code: BearerTokensCode,
  field?: string,
  line?: number,
): BearerTokensFileResult =>
  Object.freeze({
    __proto__: null,
    ok: false,
    code,
    ...(field === undefined ? {} : { field }),
    ...(line === undefined ? {} : { line }),
  });

// An own data property of a plain object, never through a getter.
const ownData = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property !== undefined && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

/**
 * Checks plain values as the file of the tokens of version 1.
 *
 * @param value - The plain values, as the reader of YAML returns them.
 * @returns The entries, deeply frozen and in the order of the file, or the
 *   code of the first problem with the path of its field. It never throws.
 * @example
 * ```ts
 * checkBearerTokens({ version: 1, tokens: [] }); // { ok: true, entries: [] }
 * ```
 */
export function checkBearerTokens(value: unknown): BearerTokensFileResult {
  // Without its version, or with another, the rest of the file means
  // something else, so its entries are not checked against this schema.
  if (ownData(value, 'version') !== bearerTokensFileVersion) {
    return refuse(
      'bearer_tokens_version_unknown',
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? 'version'
        : undefined,
    );
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) {
    const [field] = parsed.error.issues
      .slice(0, 1)
      .map((issue) => fieldOf(issue.path));
    return refuse('bearer_tokens_invalid', field);
  }
  const seen = new Set<string>();
  const entries: BearerTokenEntry[] = [];
  for (const [index, entry] of parsed.data.tokens.entries()) {
    if (seen.has(entry.sha256)) {
      return refuse(
        'bearer_tokens_duplicate',
        `tokens[${String(index)}].sha256`,
      );
    }
    seen.add(entry.sha256);
    entries.push(
      Object.freeze({
        name: entry.name,
        sha256: entry.sha256,
        scopes: Object.freeze([...entry.scopes] as BearerScope[]),
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      }),
    );
  }
  return Object.freeze({
    __proto__: null,
    ok: true,
    entries: Object.freeze(entries),
  });
}

/**
 * Reads, parses and checks the file of the tokens. The path must be
 * absolute. Folders above the file are trusted: no flag of open checks
 * them.
 *
 * @param path - The absolute path of the file.
 * @param fs - The file functions, only for tests.
 * @returns The entries, or the code of the first check that failed with
 *   the path of the field or the line. It never throws for a file.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const read = readBearerTokensFile('/config/http-tokens.yaml');
 * if (!read.ok) report(read.code, read.field, read.line);
 * ```
 */
export function readBearerTokensFile(
  path: string,
  fs?: ConfigFileSystem,
): BearerTokensFileResult {
  if (typeof path !== 'string') {
    throw new TypeError('The path of the file of the tokens must be a string.');
  }
  const read = readConfigTextFile(path, maxBearerTokensFileBytes, fs);
  if (!read.ok) return refuse(`bearer_tokens_file_${read.reason}`);
  const yaml = readConfigYaml(read.text);
  if (!yaml.ok) {
    return refuse(`bearer_tokens_${yaml.code}`, undefined, yaml.line);
  }
  return checkBearerTokens(yaml.value);
}

// Every value the serializer writes: letters, digits and hyphens only, so
// that double quotes need no escape.
const plainValue = /^[0-9A-Za-z-]{1,64}$/;

const quoted = (value: string): string => {
  if (!plainValue.test(value)) {
    throw new TypeError('A value of the file of the tokens has another form.');
  }
  return `"${value}"`;
};

/**
 * Writes the entries in the fixed form of the file, version 1. The text
 * starts with a comment in German for the operator. Reading the text with
 * {@link checkBearerTokens} after the reader of YAML gives the same
 * entries.
 *
 * @param entries - The entries, which the caller has checked.
 * @returns The text of the file, UTF-8 without a byte order mark, ending
 *   with a line break.
 * @throws {TypeError} When the entries do not pass the schema, so that no
 *   text comes into being that the server would refuse.
 * @example
 * ```ts
 * serializeBearerTokens([]); // '# …\nversion: 1\ntokens: []\n'
 * ```
 */
export function serializeBearerTokens(
  entries: readonly BearerTokenEntry[],
): string {
  const checked = checkBearerTokens({
    version: bearerTokensFileVersion,
    tokens: entries.map((entry) => ({
      name: entry.name,
      sha256: entry.sha256,
      scopes: [...entry.scopes],
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    })),
  });
  if (!checked.ok) {
    throw new TypeError('The entries do not pass the schema of the file.');
  }
  const lines = [
    '# Bearer-Tokens für `ecclium serve-http`. Die Datei hält nur Hashes, nie ein Token.',
    '# `ecclium token` schreibt sie. Wer sie von Hand ändert, prüft sie mit `ecclium token list`.',
    `version: ${String(bearerTokensFileVersion)}`,
  ];
  if (checked.entries.length === 0) {
    lines.push('tokens: []');
  } else {
    lines.push('tokens:');
    for (const entry of checked.entries) {
      lines.push(
        `  - name: ${quoted(entry.name)}`,
        `    sha256: ${quoted(entry.sha256)}`,
        `    scopes: [${entry.scopes.map(quoted).join(', ')}]`,
        `    createdAt: ${quoted(entry.createdAt)}`,
        `    expiresAt: ${quoted(entry.expiresAt)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
