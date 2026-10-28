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
  findPathItem,
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

// A document from the instance can branch through combiners on every
// level. This bounds the work of one comparison: the check then fails
// instead of giving a partial answer.
const maxSteps = 100_000;

/** The steps one comparison has left, counted against {@link maxSteps}. */
interface Steps {
  left: number;
}

const step = (steps: Steps): void => {
  steps.left -= 1;
  if (steps.left < 0)
    throw new SpikeError('ANTWORT_UNGUELTIG', 'dokumentZuVerschachtelt');
};

const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

// A part of `oneOf` or `anyOf` that only allows null, as for a field that
// may be null. It requires and declares nothing.
const onlyNull = (schema: JsonObject | undefined): boolean =>
  schema !== undefined && schema['type'] === 'null';

// What a schema of the document says about one part of it, such as one
// property or the entries of a list, gathered from the schema and every
// part it combines. Parts of `allOf` stay together, the alternatives of
// `oneOf` and `anyOf` stay alternatives, so that a field declared in two
// parts is read from both and the order of the parts does not matter. Only
// the ancestors of a schema end a cycle, so that two alternatives may
// share a referenced part.
const gather = (
  schemas: Schemas,
  node: unknown,
  pick: (schema: JsonObject) => unknown,
  steps: Steps,
  ancestors: ReadonlySet<JsonObject> = new Set(),
  depth = 0,
): JsonObject | undefined => {
  const schema = schemas.resolve(node);
  if (schema === undefined || ancestors.has(schema) || depth > maxDepth)
    return undefined;
  step(steps);
  const inner = new Set(ancestors).add(schema);
  const parts: JsonObject[] = [];
  const own = pick(schema);
  // `additionalProperties: true` allows any value but describes none.
  if (isObject(own)) parts.push(own);
  for (const part of listOf(schema['allOf'])) {
    const found = gather(schemas, part, pick, steps, inner, depth + 1);
    if (found !== undefined) parts.push(found);
  }
  for (const combiner of ['oneOf', 'anyOf'] as const) {
    const found = listOf(schema[combiner]).flatMap((part) => {
      const one = gather(schemas, part, pick, steps, inner, depth + 1);
      return one === undefined ? [] : [one];
    });
    if (found.length > 0) parts.push({ [combiner]: found });
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { allOf: parts };
};

// The declaration of one property, from every part of a schema.
const propertyOf = (
  schemas: Schemas,
  node: unknown,
  name: string,
  steps: Steps,
): JsonObject | undefined =>
  gather(
    schemas,
    node,
    (schema) => {
      const properties = schema['properties'];
      // Own keys only, so that a name such as `constructor` finds nothing
      // of Object.prototype.
      return isObject(properties) && Object.hasOwn(properties, name)
        ? properties[name]
        : undefined;
    },
    steps,
  );

// The names a schema of the document requires: its own, those of every
// part of `allOf`, and of `oneOf` and `anyOf` only those every alternative
// requires, leaving out an alternative that only allows null.
const requiredOf = (
  schemas: Schemas,
  node: unknown,
  steps: Steps,
  ancestors: ReadonlySet<JsonObject> = new Set(),
  depth = 0,
): ReadonlySet<string> => {
  const found = new Set<string>();
  const schema = schemas.resolve(node);
  if (schema === undefined || ancestors.has(schema) || depth > maxDepth)
    return found;
  step(steps);
  const inner = new Set(ancestors).add(schema);
  for (const name of listOf(schema['required']))
    if (typeof name === 'string') found.add(name);
  for (const part of listOf(schema['allOf']))
    for (const name of requiredOf(schemas, part, steps, inner, depth + 1))
      found.add(name);
  for (const combiner of ['oneOf', 'anyOf'] as const) {
    const sets = listOf(schema[combiner])
      .filter((part) => !onlyNull(schemas.resolve(part)))
      .map((part) => requiredOf(schemas, part, steps, inner, depth + 1));
    const [first, ...rest] = sets;
    if (first === undefined) continue;
    for (const name of first)
      if (rest.every((other) => other.has(name))) found.add(name);
  }
  return found;
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
 * of a map `{}`. Where the client allows several forms with `anyOf`, every
 * form counts. A field that two forms share appears once. In the document
 * a field counts as declared if one part declares it, its type classes and
 * whether it may be null come from every part that declares it, and it is
 * required if the schema or a part of `allOf` requires it, or every
 * alternative of `oneOf` or `anyOf`.
 *
 * @param schemas - The schemas of the document.
 * @param documented - The schema of the answer in the document.
 * @param wanted - The schema of the answer in the contract of the client.
 * @returns One entry per field, in the order of the contract.
 * @throws {SpikeError} If the document needs more than {@link maxSteps}
 *   steps to compare.
 */
export function compareSchema(
  schemas: Schemas,
  documented: unknown,
  wanted: unknown,
): FieldComparison[] {
  const found = new Map<string, FieldComparison>();
  const resolve: Resolve = (node) => schemas.resolve(node);
  const steps: Steps = { left: maxSteps };
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
        const required = requiredOf(schemas, document, steps);
        const clientRequired = Array.isArray(part['required'])
          ? (part['required'] as unknown[])
          : [];
        for (const [name, child] of Object.entries(properties)) {
          const fieldPath = path === '' ? name : `${path}.${name}`;
          const documentChild = propertyOf(schemas, document, name, steps);
          const schema = schemas.resolve(documentChild);
          if (!found.has(fieldPath)) {
            found.set(fieldPath, {
              path: fieldPath,
              document: {
                deklariert: documentChild !== undefined,
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
          gather(schemas, document, (schema) => schema['items'], steps),
          part['items'],
          `${path}[]`,
          depth + 1,
        );
      }
      // A map such as the dates of an appointment, keyed by day.
      if (isObject(part['additionalProperties'])) {
        walk(
          gather(
            schemas,
            document,
            (schema) => schema['additionalProperties'],
            steps,
          ),
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
// such as `pagedMeta` have neither method nor path and are part of the
// answers that use them. An operation with a broken path, method or list
// of parameters stops the check, so that it cannot drop out of the report.
const operationsOf = (contract: unknown): Operation[] => {
  const broken = new SpikeError('DATEI', 'vertragUngueltig');
  if (!isObject(contract)) throw broken;
  return Object.entries(contract).flatMap(([name, raw]): Operation[] => {
    if (!isObject(raw)) throw broken;
    const entry = raw as Entry;
    if (entry.method === undefined && entry.path === undefined) return [];
    const method = methods.find((known) => known === entry.method);
    if (method === undefined || typeof entry.path !== 'string') throw broken;
    const query = entry.query ?? [];
    if (
      !Array.isArray(query) ||
      !query.every((item): item is string => typeof item === 'string')
    )
      throw broken;
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
    let contract: unknown;
    try {
      contract = JSON.parse(contractText);
    } catch {
      throw new SpikeError('DATEI', 'vertragUngueltig');
    }
    const operations = operationsOf(contract);
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
      // The parameters of the operation and those its path declares for
      // every operation on it.
      const declaredQuery = new Set(
        documented === undefined
          ? []
          : schemas
              .parameterDetails(
                documented,
                findPathItem(
                  state.specification,
                  operation.method,
                  operation.path,
                ),
              )
              .filter((parameter) => parameter.location === 'query')
              .map((parameter) => parameter.name),
      );
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
        const steps: Steps = { left: maxSteps };
        const data = propertyOf(schemas, body, 'data', steps);
        entry['werteAlsMap'] =
          gather(
            schemas,
            data,
            (schema) => schema['additionalProperties'],
            steps,
          ) !== undefined;
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

// As in the other scripts: a comparison of URLs would miss a path with a
// space or a symbolic link and end with 0 without running.
if (import.meta.main) {
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
