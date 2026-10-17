/**
 * Contract check of the ChurchTools client (ADR 0057).
 *
 * Reads `packages/core/src/churchtools/contract.json`, the schemas of the
 * client as JSON Schema, and the OpenAPI document of the instance from the
 * state file of `scripts/spike/00-inventory.mts`. Sends nothing.
 * Answers: for each operation of the client, whether the instance documents
 * it and marks it as deprecated, whether it declares the query parameters
 * the client sends, and for each field the client reads whether the
 * document declares it, with its type class, required and nullable. Only
 * fixed words and the names of the client leave the script, through the
 * guard of the spike.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { readFileSync } from 'node:fs';

import { SpikeError } from '../spike/lib/errors.mts';
import {
  checkNodeEnvironment,
  readOrigin,
  readState,
  statePath,
} from '../spike/lib/env.mts';
import { Guard, type Json } from '../spike/lib/guard.mts';
import {
  installCrashHandlers,
  type Io,
  writeError,
  writeResult,
} from '../spike/lib/output.mts';
import {
  findOperation,
  isObject,
  type JsonObject,
  Schemas,
} from '../spike/lib/spec.mts';

/**
 * The type class of a schema of the document, as a fixed word.
 *
 * @param schema - The resolved schema, if any.
 * @returns A fixed word such as `string` or `unbekannt`.
 */
export function typeClass(schema: JsonObject | undefined): string {
  if (schema === undefined) return 'unbekannt';
  const type = schema['type'];
  const types = Array.isArray(type) ? type : [type];
  const named = types.filter(
    (entry) => typeof entry === 'string' && entry !== 'null',
  );
  if (named.length === 1) {
    const only = named[0] as string;
    return [
      'string',
      'integer',
      'number',
      'boolean',
      'object',
      'array',
    ].includes(only)
      ? only
      : 'anderes';
  }
  return named.length === 0 ? 'ohne Typ' : 'mehrere';
}

/**
 * Whether a schema of the document allows null.
 *
 * @param schema - The resolved schema, if any.
 * @returns Whether `nullable` or a type `null` is declared.
 */
export function allowsNull(schema: JsonObject | undefined): boolean {
  if (schema === undefined) return false;
  const type = schema['type'];
  return (
    schema['nullable'] === true ||
    (Array.isArray(type) && type.includes('null'))
  );
}

interface Field {
  readonly deklariert: boolean;
  readonly typ: string;
  readonly pflicht: boolean;
  readonly nullable: boolean;
}

/**
 * Compares the fields of one object of the contract with the schema of the
 * document.
 *
 * @param schemas - The schemas of the document.
 * @param documented - The schema of the object in the document.
 * @param wanted - The names the client reads.
 * @returns For each name, what the document declares.
 */
export function compareFields(
  schemas: Schemas,
  documented: unknown,
  wanted: readonly string[],
): Record<string, Field> {
  const properties = schemas.properties(documented);
  const resolved = schemas.resolve(documented);
  const required = Array.isArray(resolved?.['required'])
    ? (resolved['required'] as unknown[])
    : [];
  return Object.fromEntries(
    wanted.map((name) => {
      const schema = schemas.resolve(properties.get(name));
      return [
        name,
        {
          deklariert: properties.has(name),
          typ: typeClass(schema),
          pflicht: required.includes(name),
          nullable: allowsNull(schema),
        },
      ];
    }),
  );
}

interface Contract {
  readonly whoami: {
    readonly path: string;
    readonly query: readonly string[];
    readonly response: {
      readonly properties: {
        readonly data: {
          readonly properties: Readonly<Record<string, unknown>>;
        };
        readonly meta: {
          readonly properties: Readonly<Record<string, unknown>>;
        };
      };
    };
  };
  readonly permissions: {
    readonly path: string;
    readonly query: readonly string[];
  };
}

const words = [
  'abgleich',
  'churchtools-client',
  'churchtoolsVersion',
  'unbekannt',
  'operationen',
  'whoami',
  'permissions',
  'dokumentiert',
  'veraltet',
  'parameter',
  'felder',
  'data',
  'meta',
  'deklariert',
  'typ',
  'pflicht',
  'nullable',
  'werteAlsMap',
  'string',
  'integer',
  'number',
  'boolean',
  'object',
  'array',
  'anderes',
  'ohne Typ',
  'mehrere',
];

/**
 * Runs the check.
 *
 * @param env - Environment of the process.
 * @param contractText - The text of contract.json.
 * @param io - Where to write.
 * @returns The exit code.
 */
export function run(
  env: Readonly<Record<string, string | undefined>>,
  contractText: string,
  io: Io,
): number {
  try {
    checkNodeEnvironment(env);
    const origin = readOrigin(env);
    const state = readState(statePath(env), origin);
    const contract = JSON.parse(contractText) as Contract;
    const schemas = new Schemas(state.specification);
    const guard = new Guard();
    guard.allowFixed(...words);
    if (state.version !== null) guard.allowVersion(state.version);

    const dataNames = Object.keys(
      contract.whoami.response.properties.data.properties,
    );
    const metaNames = Object.keys(
      contract.whoami.response.properties.meta.properties,
    );
    const queryNames = [
      ...contract.whoami.query,
      ...contract.permissions.query,
    ];
    guard.allowFixed(
      ...dataNames,
      ...metaNames,
      ...queryNames,
      contract.whoami.path,
      contract.permissions.path,
    );

    const whoami = findOperation(
      state.specification,
      'get',
      contract.whoami.path,
    );
    const permissions = findOperation(
      state.specification,
      'get',
      contract.permissions.path,
    );
    const whoamiBody =
      whoami === undefined ? undefined : schemas.responseSchema(whoami, 200);
    const whoamiProperties = schemas.properties(whoamiBody);
    const permissionsBody =
      permissions === undefined
        ? undefined
        : schemas.responseSchema(permissions, 200);
    const permissionsData = schemas.properties(permissionsBody).get('data');
    const declared = (
      operation: JsonObject | undefined,
      names: readonly string[],
    ): Record<string, boolean> => {
      const found =
        operation === undefined
          ? new Set<string>()
          : schemas.queryParameters(operation);
      return Object.fromEntries(names.map((name) => [name, found.has(name)]));
    };

    const output: Json = {
      abgleich: 'churchtools-client',
      churchtoolsVersion: state.version ?? 'unbekannt',
      operationen: {
        whoami: {
          dokumentiert: whoami !== undefined,
          veraltet: whoami?.['deprecated'] === true,
          parameter: declared(whoami, contract.whoami.query),
          felder: {
            data: compareFields(
              schemas,
              whoamiProperties.get('data'),
              dataNames,
            ),
            meta: compareFields(
              schemas,
              whoamiProperties.get('meta'),
              metaNames,
            ),
          },
        },
        permissions: {
          dokumentiert: permissions !== undefined,
          veraltet: permissions?.['deprecated'] === true,
          werteAlsMap: isObject(schemas.additionalProperties(permissionsData)),
        },
      },
    } as unknown as Json;
    return writeResult(output, guard, io);
  } catch (error) {
    return writeError(
      error instanceof SyntaxError
        ? new SpikeError('DATEI', 'stateDateiUngueltig')
        : error,
      io,
    );
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  installCrashHandlers(io);
  const contractText = readFileSync(
    new URL(
      '../../packages/core/src/churchtools/contract.json',
      import.meta.url,
    ),
    'utf8',
  );
  process.exitCode = run(process.env, contractText, io);
}
