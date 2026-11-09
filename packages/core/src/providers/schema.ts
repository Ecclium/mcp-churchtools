/**
 * The file of the providers of language models, `providers.v1` (ADR 0033).
 *
 * Where it stands in a run: before any run, when the configuration is
 * loaded. The file names each model a routine may choose by its alias:
 * the vendor, the model, the country of the data centre, the endpoint, the
 * file of the key and, outside Switzerland and the EEA, the basis of the
 * transfer. The operator should never have to guess where the data of the
 * parish go, so a provider outside without a basis stops the start, and
 * vendor, model, country and host must fit the patterns of the audit, in
 * which every event of a run names them.
 *
 * The key itself never stands in this file, only the path of its file;
 * the composition root reads that file when it builds the transport of
 * the provider. A field that looks like a key stops the start with a code
 * of its own.
 *
 * @packageDocumentation
 */
import { isAbsolute } from 'node:path';

import type { ProviderInfo } from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { auditFieldSchemas } from '../audit/schema.js';
import { parseModelEndpoint } from '../http/index.js';
import { checkTransferBasis, transferBases } from '../model/countries.js';
import { policyFieldOf } from '../policy/check.js';

/** The limits of the file of the providers, frozen. */
export const providersLimits: {
  readonly providers: number;
  readonly alias: number;
  readonly endpoint: number;
  readonly keyFile: number;
} = Object.freeze({
  /** The most providers of one file. */
  providers: 10,
  /** The longest alias, as the ID of a routine. */
  alias: 63,
  /** The longest address of an endpoint. */
  endpoint: 600,
  /** The longest path of the file of a key. */
  keyFile: 4096,
});

// The alias of a provider, as `generate.model` of a routine names it:
// lowercase letters, digits and dashes, as the ID of a routine.
const aliasPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The names of fields that would hold a key in the file itself. Compared
// in lower case and without separators, so `api_key` and `API-Key` fit.
const keyFieldNames: readonly string[] = Object.freeze([
  'apikey',
  'key',
  'token',
  'secret',
  'password',
  'bearer',
  'authorization',
]);

const providerSchema = z.strictObject({
  alias: z.string().max(providersLimits.alias).regex(aliasPattern),
  vendor: auditFieldSchemas.vendor,
  model: auditFieldSchemas.model,
  hostingCountry: auditFieldSchemas.hostingCountry,
  endpoint: z
    .string()
    .max(providersLimits.endpoint)
    .regex(/^https:\/\//)
    .refine((value) => parseModelEndpoint(value).ok),
  structuredOutput: z.boolean(),
  apiKeyFile: z
    .string()
    .min(1)
    .max(providersLimits.keyFile)
    .refine((value) => isAbsolute(value)),
  transferBasis: z.enum(transferBases).optional(),
});

/** The schema of the file, strict: an unknown field fails it. */
export const providersFileSchema = z.strictObject({
  schema: z.literal('providers.v1'),
  providers: z.array(providerSchema).min(1).max(providersLimits.providers),
});

/** One provider as the configuration checked it. */
export interface ProviderSettings {
  /** The alias a routine names, such as `default`. */
  readonly alias: string;
  /** Vendor, model, country, host and basis, as every event names them. */
  readonly info: ProviderInfo;
  /** The address of the endpoint, canonical https with a path. */
  readonly endpoint: string;
  /** Whether the vendor follows a JSON Schema for the answer. */
  readonly structuredOutput: boolean;
  /** The absolute path of the file of the key. */
  readonly apiKeyFile: string;
}

/** Why a value is no file of providers, frozen. */
export const providersCheckCodes = Object.freeze([
  'providers_version_unknown',
  'providers_invalid',
  'providers_key_inline',
  'providers_contradiction',
  'providers_transfer_basis_missing',
  'providers_transfer_basis_needless',
] as const);

/** Why a value is no file of providers. */
export type ProvidersCheckCode = (typeof providersCheckCodes)[number];

/** The checked providers, or why there are none. */
export type ProvidersCheckResult =
  | { readonly ok: true; readonly providers: readonly ProviderSettings[] }
  | {
      readonly ok: false;
      readonly code: ProvidersCheckCode;
      /** The path of the field, such as `providers[1].transferBasis`. */
      readonly field?: string;
    };

const refuse = (
  code: ProvidersCheckCode,
  field?: string,
): ProvidersCheckResult =>
  Object.freeze({
    __proto__: null,
    ok: false,
    code,
    ...(field === undefined ? {} : { field }),
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

// Whether a name of a field looks like it holds a key.
const looksLikeKey = (name: string): boolean =>
  keyFieldNames.includes(name.toLowerCase().replaceAll(/[^a-z]/g, ''));

/**
 * Checks the plain values of a file of providers: the version, no key in
 * the file, the schema, every alias once and the rule of the country and
 * the basis of the transfer.
 *
 * @param value - The plain values of the file.
 * @returns The providers, frozen, in the order of the file, or the code of
 *   the first problem with the path of its field. It never throws.
 * @example
 * ```ts
 * checkProviders({ schema: 'providers.v2' });
 * // { ok: false, code: 'providers_version_unknown', field: 'schema' }
 * ```
 */
export function checkProviders(value: unknown): ProvidersCheckResult {
  // Without its version, or with another, the rest of the file means
  // something else, so its fields are not checked against this schema.
  if (ownData(value, 'schema') !== 'providers.v1') {
    return refuse(
      'providers_version_unknown',
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? 'schema'
        : undefined,
    );
  }
  // A key in the file is refused before the schema, which would only call
  // the field unknown: the operator should learn that the key belongs in a
  // file of its own.
  const entries = ownData(value, 'providers');
  if (Array.isArray(entries)) {
    for (const [index, entry] of (entries as unknown[]).entries()) {
      if (typeof entry !== 'object' || entry === null) continue;
      if (Object.keys(entry).some(looksLikeKey)) {
        return refuse('providers_key_inline', `providers[${String(index)}]`);
      }
    }
  }
  const parsed = providersFileSchema.safeParse(value);
  if (!parsed.success) {
    // A failed parse has at least one issue; the first one counts.
    const [field] = parsed.error.issues
      .slice(0, 1)
      .map((issue) => policyFieldOf(issue.path));
    return refuse('providers_invalid', field);
  }
  const aliases = new Set<string>();
  const providers: ProviderSettings[] = [];
  for (const [index, entry] of parsed.data.providers.entries()) {
    const at = `providers[${String(index)}]`;
    if (aliases.has(entry.alias)) {
      return refuse('providers_contradiction', `${at}.alias`);
    }
    aliases.add(entry.alias);
    const problem = checkTransferBasis(
      entry.hostingCountry,
      entry.transferBasis,
    );
    if (problem !== undefined) {
      return refuse(`providers_${problem}`, `${at}.transferBasis`);
    }
    // The schema has already checked the address with the same function.
    const endpoint = parseModelEndpoint(entry.endpoint) as {
      readonly host: string;
    };
    providers.push(
      Object.freeze({
        alias: entry.alias,
        info: Object.freeze({
          vendor: entry.vendor,
          model: entry.model,
          hostingCountry: entry.hostingCountry,
          endpointHost: endpoint.host,
          ...(entry.transferBasis === undefined
            ? {}
            : { transferBasis: entry.transferBasis }),
        }),
        endpoint: entry.endpoint,
        structuredOutput: entry.structuredOutput,
        apiKeyFile: entry.apiKeyFile,
      }),
    );
  }
  return Object.freeze({
    __proto__: null,
    ok: true,
    providers: Object.freeze(providers),
  });
}

/**
 * The JSON Schema of the file of the providers, made with `z.toJSONSchema`
 * from the schema of zod on each call, for editors. It does not express
 * an alias twice, the rule of country and basis and the checks of the
 * endpoint beyond `https`, which the server refuses as well.
 *
 * @returns The schema in JSON Schema 2020-12, a new object each time.
 * @example
 * ```ts
 * providersJsonSchema().type; // 'object'
 * ```
 */
export function providersJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(providersFileSchema, {
    target: 'draft-2020-12',
    io: 'input',
  });
}
