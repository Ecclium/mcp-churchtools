/**
 * Contract check of the ChurchTools client (ADR 0057).
 *
 * Reads `packages/core/src/churchtools/contract.json`, the schemas of the
 * client as JSON Schema, and the OpenAPI document of the instance from the
 * state file of `scripts/spike/00-inventory.mts`. Sends nothing.
 * Answers: for each operation of the client, whether the instance documents
 * it and marks it as deprecated, whether it declares the query parameters
 * the client sends, and for each field the client reads, at any depth,
 * whether the document declares it, with its type class, required and
 * nullable. At the end it lists where the document departs from what the
 * client expects. Only fixed words and the names of the client leave the
 * script, through the guard of the spike.
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
  type Method,
  Schemas,
} from '../spike/lib/spec.mts';

/** Follows a reference to a schema, or takes a schema as it is. */
export type Resolve = (node: unknown) => JsonObject | undefined;

// The schemas of the client carry no references.
const plain: Resolve = (node) => (isObject(node) ? node : undefined);

// The keywords that combine parts of a schema.
const combiners = ['allOf', 'oneOf', 'anyOf'] as const;

// Deep enough for every schema of the client; it ends a cycle of
// references in the document.
const maxDepth = 32;

const knownTypes = [
  'string',
  'integer',
  'number',
  'boolean',
  'object',
  'array',
] as const;

// The named types of a schema and of every part it combines, and whether
// one of them allows null. A field that may be null is written as `anyOf`
// with a part of type `null`, in the document as in the client.
const typesOf = (
  schema: JsonObject,
  resolve: Resolve,
): { readonly names: ReadonlySet<string>; readonly nullable: boolean } => {
  const names = new Set<string>();
  let nullable = false;
  const seen = new Set<JsonObject>();
  const visit = (node: JsonObject | undefined, depth: number): void => {
    if (node === undefined || seen.has(node) || depth > maxDepth) return;
    seen.add(node);
    if (node['nullable'] === true) nullable = true;
    const type = node['type'];
    for (const entry of Array.isArray(type) ? type : [type]) {
      if (entry === 'null') nullable = true;
      else if (typeof entry === 'string') names.add(entry);
    }
    for (const combiner of combiners) {
      const parts = node[combiner];
      if (Array.isArray(parts))
        for (const part of parts) visit(resolve(part), depth + 1);
    }
  };
  visit(schema, 0);
  return { names, nullable };
};

/**
 * The type class of a schema, as a fixed word.
 *
 * Looks at `type` and at the types of the parts of `allOf`, `oneOf` and
 * `anyOf`, leaving out `null`.
 *
 * @param schema - The resolved schema, if any.
 * @param resolve - Follows references in the parts.
 * @returns A fixed word such as `string` or `unbekannt`.
 */
export function typeClass(
  schema: JsonObject | undefined,
  resolve: Resolve = plain,
): string {
  if (schema === undefined) return 'unbekannt';
  const { names } = typesOf(schema, resolve);
  const [only] = names;
  if (names.size === 1 && only !== undefined) {
    return (knownTypes as readonly string[]).includes(only) ? only : 'anderes';
  }
  return names.size === 0 ? 'ohne Typ' : 'mehrere';
}

/**
 * Whether a schema allows null.
 *
 * @param schema - The resolved schema, if any.
 * @param resolve - Follows references in the parts.
 * @returns Whether `nullable`, a type `null` or a part that allows null is
 *   declared.
 */
export function allowsNull(
  schema: JsonObject | undefined,
  resolve: Resolve = plain,
): boolean {
  return schema !== undefined && typesOf(schema, resolve).nullable;
}

// The names a schema of the document lists as required, also in the parts
// it combines.
const requiredOf = (schemas: Schemas, node: unknown): ReadonlySet<string> => {
  const found = new Set<string>();
  const seen = new Set<JsonObject>();
  const visit = (part: unknown, depth: number): void => {
    const schema = schemas.resolve(part);
    if (schema === undefined || seen.has(schema) || depth > maxDepth) return;
    seen.add(schema);
    const required = schema['required'];
    if (Array.isArray(required))
      for (const name of required)
        if (typeof name === 'string') found.add(name);
    for (const combiner of combiners) {
      const parts = schema[combiner];
      if (Array.isArray(parts))
        for (const item of parts) visit(item, depth + 1);
    }
  };
  visit(node, 0);
  return found;
};

// The schema of the entries of a list or of the values of a map in the
// document, also where the list or map is one part of `oneOf` or `anyOf`,
// as for a list that may be null.
const contentOf = (
  schemas: Schemas,
  node: unknown,
  key: 'items' | 'additionalProperties',
): unknown => {
  const seen = new Set<JsonObject>();
  const visit = (part: unknown, depth: number): unknown => {
    const schema = schemas.resolve(part);
    if (schema === undefined || seen.has(schema) || depth > maxDepth)
      return undefined;
    seen.add(schema);
    // `additionalProperties: true` allows any value but describes none.
    const content = schema[key];
    if (key === 'items' ? content !== undefined : isObject(content))
      return content;
    for (const combiner of combiners) {
      const parts = schema[combiner];
      if (!Array.isArray(parts)) continue;
      for (const item of parts) {
        const found = visit(item, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(node, 0);
};

// A schema of the client and the alternatives it combines with `anyOf`.
const alternatives = (node: unknown, depth = 0): JsonObject[] => {
  if (!isObject(node) || depth > maxDepth) return [];
  const parts = node['anyOf'];
  return [
    node,
    ...(Array.isArray(parts)
      ? parts.flatMap((part: unknown) => alternatives(part, depth + 1))
      : []),
  ];
};

/** What the document declares for one field. */
export interface Field {
  readonly deklariert: boolean;
  readonly typ: string;
  readonly pflicht: boolean;
  readonly nullable: boolean;
}

/** One field the client reads, with what the document and the client say. */
export interface FieldComparison {
  /** The path below the answer, such as `data[].calendar.title`. */
  readonly path: string;
  readonly document: Field;
  /** Type class, required and nullable as the client expects them. */
  readonly client: Omit<Field, 'deklariert'>;
}

/**
 * Compares every field a schema of the client reads, at any depth, with the
 * schema of the document at the same place.
 *
 * Objects add their properties to the path, lists add `[]` and the values
 * of a map `{}`. Where the
 * client allows several forms with `anyOf`, every form counts. A field
 * that two forms share appears once.
 *
 * @param schemas - The schemas of the document.
 * @param documented - The schema of the answer in the document.
 * @param wanted - The schema of the answer in the contract of the client.
 * @returns One entry per field, in the order of the contract.
 */
export function compareSchema(
  schemas: Schemas,
  documented: unknown,
  wanted: unknown,
): FieldComparison[] {
  const found = new Map<string, FieldComparison>();
  const resolve: Resolve = (node) => schemas.resolve(node);
  const walk = (
    document: unknown,
    client: unknown,
    path: string,
    depth: number,
  ): void => {
    if (depth > maxDepth) return;
    for (const part of alternatives(client)) {
      const properties = part['properties'];
      if (isObject(properties)) {
        const declared = schemas.properties(document);
        const required = requiredOf(schemas, document);
        const clientRequired = Array.isArray(part['required'])
          ? (part['required'] as unknown[])
          : [];
        for (const [name, child] of Object.entries(properties)) {
          const fieldPath = path === '' ? name : `${path}.${name}`;
          const documentChild = declared.get(name);
          const schema = schemas.resolve(documentChild);
          if (!found.has(fieldPath)) {
            found.set(fieldPath, {
              path: fieldPath,
              document: {
                deklariert: declared.has(name),
                typ: typeClass(schema, resolve),
                pflicht: required.has(name),
                nullable: allowsNull(schema, resolve),
              },
              client: {
                typ: typeClass(plain(child)),
                pflicht: clientRequired.includes(name),
                nullable: allowsNull(plain(child)),
              },
            });
          }
          walk(documentChild, child, fieldPath, depth + 1);
        }
      }
      if (part['items'] !== undefined) {
        walk(
          contentOf(schemas, document, 'items'),
          part['items'],
          `${path}[]`,
          depth + 1,
        );
      }
      // A map such as the dates of an appointment, keyed by day.
      if (isObject(part['additionalProperties'])) {
        walk(
          contentOf(schemas, document, 'additionalProperties'),
          part['additionalProperties'],
          `${path}{}`,
          depth + 1,
        );
      }
    }
  };
  walk(documented, wanted, '', 0);
  return [...found.values()];
}

/** The kinds of deviation, as fixed words. */
export const deviationKinds = [
  'nicht dokumentiert',
  'veraltet',
  'parameter nicht deklariert',
  'nicht deklariert',
  'anderer Typ',
  'nicht Pflicht',
  'nullable',
] as const;

/** One place where the document departs from what the client expects. */
export interface Deviation {
  readonly operation: string;
  /** The field or parameter, missing for the operation as a whole. */
  readonly feld?: string;
  readonly art: (typeof deviationKinds)[number];
}

/**
 * Lists the fields where the document departs from what the client
 * expects: not declared, another type, not required where the client
 * requires the field, or null allowed where the client does not accept it.
 * Below a field that is not declared, nothing more is listed.
 *
 * @param operation - The name of the operation in the contract.
 * @param fields - The comparison of its fields.
 * @returns The deviations, in the order of the fields.
 */
export function fieldDeviations(
  operation: string,
  fields: readonly FieldComparison[],
): Deviation[] {
  const deviations: Deviation[] = [];
  const missing: string[] = [];
  const concrete = (typ: string): boolean =>
    (knownTypes as readonly string[]).includes(typ);
  for (const { path, document, client } of fields) {
    if (
      missing.some(
        (above) =>
          path.startsWith(`${above}.`) ||
          path.startsWith(`${above}[]`) ||
          path.startsWith(`${above}{}`),
      )
    )
      continue;
    if (!document.deklariert) {
      missing.push(path);
      deviations.push({ operation, feld: path, art: 'nicht deklariert' });
      continue;
    }
    if (
      concrete(document.typ) &&
      concrete(client.typ) &&
      document.typ !== client.typ
    )
      deviations.push({ operation, feld: path, art: 'anderer Typ' });
    if (client.pflicht && !document.pflicht)
      deviations.push({ operation, feld: path, art: 'nicht Pflicht' });
    if (document.nullable && !client.nullable)
      deviations.push({ operation, feld: path, art: 'nullable' });
  }
  return deviations;
}

// One entry of contract.json: an operation of the client, or a building
// block without a path.
interface Entry {
  readonly method?: unknown;
  readonly path?: unknown;
  readonly query?: unknown;
  readonly response?: unknown;
  readonly value?: unknown;
}

const methods: readonly Method[] = ['get', 'post', 'put', 'patch', 'delete'];

interface Operation {
  readonly name: string;
  readonly method: Method;
  readonly path: string;
  readonly query: readonly string[];
  readonly response: unknown;
  /** Only the rights: the schema of one value of the map. */
  readonly value: unknown;
}

// The operations of the contract in the order of the file. Building blocks
// such as `pagedMeta` have no path and are part of the answers that use
// them.
const operationsOf = (contract: unknown): Operation[] => {
  if (!isObject(contract)) throw new SyntaxError('contract');
  return Object.entries(contract).flatMap(([name, raw]): Operation[] => {
    const entry = (isObject(raw) ? raw : {}) as Entry;
    if (typeof entry.path !== 'string') return [];
    const method = methods.find((known) => known === entry.method);
    if (method === undefined) throw new SyntaxError('method');
    const query = Array.isArray(entry.query)
      ? entry.query.filter((item): item is string => typeof item === 'string')
      : [];
    return [
      {
        name,
        method,
        path: entry.path,
        query,
        response: entry.response,
        value: entry.value,
      },
    ];
  });
};

const words = [
  'abgleich',
  'churchtools-client',
  'churchtoolsVersion',
  'unbekannt',
  'operationen',
  'pfad',
  'dokumentiert',
  'veraltet',
  'parameter',
  'felder',
  'deklariert',
  'typ',
  'pflicht',
  'nullable',
  'werteAlsMap',
  'abweichungen',
  'operation',
  'feld',
  'art',
  ...knownTypes,
  'anderes',
  'ohne Typ',
  'mehrere',
  ...deviationKinds,
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
    const operations = operationsOf(JSON.parse(contractText));
    const schemas = new Schemas(state.specification);
    const guard = new Guard();
    guard.allowFixed(...words);
    if (state.version !== null) guard.allowVersion(state.version);

    const report: Record<string, Json> = {};
    const deviations: Deviation[] = [];
    for (const operation of operations) {
      const documented = findOperation(
        state.specification,
        operation.method,
        operation.path,
      );
      const declaredQuery =
        documented === undefined
          ? new Set<string>()
          : schemas.queryParameters(documented);
      const body =
        documented === undefined
          ? undefined
          : schemas.responseSchema(documented, 200);
      const entry: Record<string, Json> = {
        pfad: operation.path,
        dokumentiert: documented !== undefined,
        veraltet: documented?.['deprecated'] === true,
        parameter: Object.fromEntries(
          operation.query.map((name) => [name, declaredQuery.has(name)]),
        ),
      };
      guard.allowFixed(operation.name, operation.path, ...operation.query);
      if (documented === undefined) {
        deviations.push({
          operation: operation.name,
          art: 'nicht dokumentiert',
        });
      } else {
        if (entry['veraltet'] === true)
          deviations.push({ operation: operation.name, art: 'veraltet' });
        for (const name of operation.query)
          if (!declaredQuery.has(name))
            deviations.push({
              operation: operation.name,
              feld: name,
              art: 'parameter nicht deklariert',
            });
      }
      if (operation.response !== undefined) {
        const fields = compareSchema(schemas, body, operation.response);
        guard.allowFixed(...fields.map((field) => field.path));
        entry['felder'] = Object.fromEntries(
          fields.map((field) => [field.path, { ...field.document }]),
        );
        if (documented !== undefined)
          deviations.push(...fieldDeviations(operation.name, fields));
      }
      // The rights: whether the document describes their values as a map,
      // as the client reads them.
      if (operation.value !== undefined) {
        const data = schemas.properties(body).get('data');
        entry['werteAlsMap'] = isObject(schemas.additionalProperties(data));
      }
      report[operation.name] = entry;
    }

    const output: Json = {
      abgleich: 'churchtools-client',
      churchtoolsVersion: state.version ?? 'unbekannt',
      operationen: report,
      abweichungen: deviations.map((deviation) => ({ ...deviation })),
    };
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
