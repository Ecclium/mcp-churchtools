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
 * nullable. For a write it compares the body the client sends with the
 * body the document declares, and reads the answer of the status of
 * success the contract names (ADR 0072). At the end it lists where the
 * document departs from what the client expects. Under `katalog` it compares the catalog of the escape
 * hatch with the document as well (`catalog.mts`). Only fixed words and
 * the names of the client and of the catalog leave the script, through
 * the guard of the spike.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';

import { SpikeError } from '../spike/lib/errors.mts';
import { catalogWords, compareCatalog, readCatalog } from './catalog.mts';
import {
  checkNodeEnvironment,
  readOrigin,
  readState,
  statePath,
} from '../spike/lib/env.mts';
import { Guard, type Json } from '../spike/lib/guard.mts';
import {
  exitCodes,
  installCrashHandlers,
  type Io,
  writeError,
  writeResult,
} from '../spike/lib/output.mts';
import { hostValues } from '../spike/lib/probe.mts';
import {
  findOperation,
  findPathItem,
  isObject,
  type JsonObject,
  type Method,
  type OpenApiDocument,
  Schemas,
} from '../spike/lib/spec.mts';
import { defaultExtractFile, documentOf, readExtract } from './extract.mts';

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
  'Pflicht nicht gesendet',
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

/**
 * Lists where the body the document declares for a write departs from the
 * body the client sends (ADR 0072): a field the client sends that the
 * document does not declare or declares with another type class, and a
 * field the document requires at the top that the client does not send.
 * Whether a field may be null or is required does not count for a field
 * the client sends, because it always sends it and never as null. Each
 * field is named with `koerper.` before its path.
 *
 * @param operation - The name of the operation in the contract.
 * @param fields - The comparison of the fields of the body.
 * @param required - The fields the document requires at the top.
 * @returns The deviations, the fields in the order of the contract first.
 */
export function requestDeviations(
  operation: string,
  fields: readonly FieldComparison[],
  required: ReadonlySet<string>,
): Deviation[] {
  const deviations = fieldDeviations(operation, fields)
    .filter(
      (deviation) =>
        deviation.art === 'nicht deklariert' || deviation.art === 'anderer Typ',
    )
    .map((deviation) => ({
      ...deviation,
      feld: `koerper.${deviation.feld ?? ''}`,
    }));
  const sent = new Set(fields.map((field) => field.path));
  for (const name of required)
    if (!sent.has(name))
      deviations.push({
        operation,
        feld: `koerper.${name}`,
        art: 'Pflicht nicht gesendet',
      });
  return deviations;
}

// One entry of contract.json: an operation of the client, or a building
// block without a path.
interface Entry {
  readonly method?: unknown;
  readonly path?: unknown;
  readonly query?: unknown;
  readonly status?: unknown;
  readonly request?: unknown;
  readonly response?: unknown;
  readonly value?: unknown;
}

const methods: readonly Method[] = ['get', 'post', 'put', 'patch', 'delete'];

/** An operation of the client, as `contract.json` describes it. */
export interface Operation {
  readonly name: string;
  readonly method: Method;
  readonly path: string;
  readonly query: readonly string[];
  /**
   * The status of the answer of success: 200 unless the entry names 201,
   * and 204 for a DELETE.
   */
  readonly status: number;
  /** Only writes: the JSON Schema of the body the client sends. */
  readonly request: unknown;
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
    // A read has no body and is read at 200; a write names the body it
    // sends, so that no write drops out of the comparison, and a DELETE
    // has no body and ends with 204, whose answer has none (ADR 0072).
    const status = entry.status ?? 200;
    if (method === 'delete') {
      if (status !== 204 || entry.request !== undefined) throw broken;
    } else if (status !== 200 && status !== 201) throw broken;
    if (method === 'get' && (entry.request !== undefined || status !== 200))
      throw broken;
    if (method !== 'get' && method !== 'delete' && entry.request === undefined)
      throw broken;
    return [
      {
        name,
        method,
        path: entry.path,
        query,
        status,
        request: entry.request,
        response: entry.response,
        value: entry.value,
      },
    ];
  });
};

const words = [
  'abgleich',
  'koerper',
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

// The words of the part against the extract (ADR 0076).
const extractWords = ['auszug', 'bekannt', 'neu', 'nichtMehr'] as const;

/**
 * Reads the operations of the client from the text of `contract.json`.
 *
 * @param contractText - The text of contract.json.
 * @returns The operations, in the order of the file.
 * @throws {SpikeError} `DATEI` if the file is damaged.
 */
export function contractOperations(contractText: string): Operation[] {
  let contract: unknown;
  try {
    contract = JSON.parse(contractText);
  } catch {
    throw new SpikeError('DATEI', 'vertragUngueltig');
  }
  return operationsOf(contract);
}

/** What the comparison of the client with a document found. */
export interface ContractComparison {
  /** Per operation of the client, what the document declares. */
  readonly report: Record<string, Json>;
  /** Where the document departs from what the client expects. */
  readonly deviations: readonly Deviation[];
  /** Names of the client and of its fields, which stand in the repository. */
  readonly fixed: readonly string[];
  /** Names only the document gives, for the checks of the guard. */
  readonly checked: readonly string[];
}

/**
 * Compares each operation of the client with a document: whether the
 * document documents it and marks it as deprecated, its parameters of the
 * query, the body of a write, every field of the answer it reads and,
 * for the rights, whether the values are a map.
 *
 * @param document - The OpenAPI document, from the state file or made from
 *   the extract.
 * @param operations - The operations of the client.
 * @returns The report, the deviations and the names they show.
 * @throws {SpikeError} If the document needs more than the steps allowed.
 */
export function compareContract(
  document: OpenApiDocument,
  operations: readonly Operation[],
): ContractComparison {
  const schemas = new Schemas(document);
  const report: Record<string, Json> = {};
  const deviations: Deviation[] = [];
  const fixed: string[] = [];
  const checked: string[] = [];
  for (const operation of operations) {
    const documented = findOperation(
      document,
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
              findPathItem(document, operation.method, operation.path),
            )
            .filter((parameter) => parameter.location === 'query')
            .map((parameter) => parameter.name),
    );
    const body =
      documented === undefined
        ? undefined
        : schemas.responseSchema(documented, operation.status);
    const entry: Record<string, Json> = {
      pfad: operation.path,
      dokumentiert: documented !== undefined,
      veraltet: documented?.['deprecated'] === true,
      parameter: Object.fromEntries(
        operation.query.map((name) => [name, declaredQuery.has(name)]),
      ),
    };
    fixed.push(operation.name, operation.path, ...operation.query);
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
    // The body of a write: what the client sends against what the
    // document declares for the request (ADR 0072).
    if (operation.request !== undefined) {
      const requestBody =
        documented === undefined
          ? undefined
          : schemas.requestSchema(documented);
      const fields = compareSchema(schemas, requestBody, operation.request);
      fixed.push(
        ...fields.flatMap((field) => [field.path, `koerper.${field.path}`]),
      );
      entry['koerper'] = Object.fromEntries(
        fields.map((field) => [field.path, { ...field.document }]),
      );
      if (documented !== undefined) {
        // A name the document requires comes from the document, so it
        // passes only the checks for names the document gives.
        const required = requiredOf(schemas, requestBody, {
          left: maxSteps,
        });
        for (const name of required) checked.push(`koerper.${name}`);
        deviations.push(...requestDeviations(operation.name, fields, required));
      }
    }
    if (operation.response !== undefined) {
      const fields = compareSchema(schemas, body, operation.response);
      fixed.push(...fields.map((field) => field.path));
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
  return { report, deviations, fixed, checked };
}

/**
 * Runs the check against the document of the instance in the state file.
 *
 * @param env - Environment of the process.
 * @param contractText - The text of contract.json.
 * @param io - Where to write.
 * @param catalogText - The text of the generated part of the catalog of
 *   the escape hatch.
 * @returns The exit code.
 */
export function run(
  env: Readonly<Record<string, string | undefined>>,
  contractText: string,
  io: Io,
  catalogText: string,
): number {
  try {
    checkNodeEnvironment(env);
    const origin = readOrigin(env);
    const state = readState(statePath(env), origin);
    const operations = contractOperations(contractText);
    const catalog = readCatalog(catalogText);
    const guard = new Guard();
    guard.allowFixed(...words);
    if (state.version !== null) guard.allowVersion(state.version);
    // What could identify the instance or this machine never leaves, also
    // not in a name that only the document of the instance gives (part
    // katalog), as in the probes.
    for (const value of hostValues(origin)) guard.block(value);
    guard.block(statePath(env));
    try {
      guard.block(userInfo().username);
    } catch {
      // Without a user name there is nothing to block.
    }
    guard.block(homedir());

    const compared = compareContract(state.specification, operations);
    guard.allowFixed(...compared.fixed);
    for (const name of compared.checked) guard.allowChecked(name);

    // Names of the generated part stand in the repository; a name only the
    // document gives comes from the instance and stays subject to the
    // block list.
    const catalogPart = compareCatalog(state.specification, catalog);
    guard.allowFixed(...catalogWords, ...catalogPart.fixed);
    for (const name of catalogPart.fromDocument) guard.allowChecked(name);

    const output: Json = {
      abgleich: 'churchtools-client',
      churchtoolsVersion: state.version ?? 'unbekannt',
      operationen: compared.report,
      abweichungen: compared.deviations.map((deviation) => ({ ...deviation })),
      katalog: catalogPart.report,
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

/** A deviation the project knows and has looked at, with its reason. */
export interface AcceptedDeviation extends Deviation {
  readonly grund: string;
}

/** The format of the list of known deviations. */
export const acceptedFormat = 'ecclium.contract.accepted.v1';

/** The list of known deviations, next to the check. */
export const defaultAcceptedFile = new URL(
  './accepted-deviations.json',
  import.meta.url,
);

const deviationKey = (deviation: Deviation): string =>
  JSON.stringify([deviation.operation, deviation.feld ?? null, deviation.art]);

/**
 * Reads the list of the deviations the project knows: each with the
 * operation, the field if any, the kind and a reason, no entry twice.
 *
 * @param text - The text of `accepted-deviations.json`.
 * @returns The entries.
 * @throws {SpikeError} `DATEI` if the list has another form.
 */
export function readAccepted(text: string): AcceptedDeviation[] {
  const broken = (): never => {
    throw new SpikeError('DATEI', 'listeUngueltig');
  };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return broken();
  }
  if (
    !isObject(value) ||
    Object.keys(value).join() !== 'format,entries' ||
    value['format'] !== acceptedFormat ||
    !Array.isArray(value['entries'])
  ) {
    return broken();
  }
  const seen = new Set<string>();
  return (value['entries'] as unknown[]).map((raw) => {
    if (!isObject(raw)) return broken();
    const { operation, feld, art, grund } = raw;
    const keys = Object.keys(raw).join();
    if (
      typeof operation !== 'string' ||
      (feld !== undefined && typeof feld !== 'string') ||
      !deviationKinds.includes(art as Deviation['art']) ||
      typeof grund !== 'string' ||
      grund.trim() === '' ||
      (keys !== 'operation,feld,art,grund' && keys !== 'operation,art,grund')
    ) {
      return broken();
    }
    const deviation: AcceptedDeviation = {
      operation,
      ...(feld === undefined ? {} : { feld }),
      art: art as Deviation['art'],
      grund,
    };
    const key = deviationKey(deviation);
    if (seen.has(key)) return broken();
    seen.add(key);
    return deviation;
  });
}

const withoutReason = ({ operation, feld, art }: Deviation): Json => ({
  operation,
  ...(feld === undefined ? {} : { feld }),
  art,
});

const mismatchNote =
  'Abweichung: Der Abgleich mit dem Auszug findet nicht genau die Abweichungen aus scripts/contract/accepted-deviations.json. Unter «neu» steht, was dazukam, unter «nichtMehr», was wegfiel. Prüfen Sie die Änderung am Client, oder tragen Sie eine belegte Abweichung mit ihrem Grund in die Liste ein.';

/** The exit code for deviations other than the known ones. */
export const mismatchCode = 1;

/**
 * Runs the check in CI: against the extract in the repository instead of
 * the state file, without the part `katalog`, which a test of the
 * generated part holds already, and against the list of the known
 * deviations (ADR 0076).
 *
 * @param contractText - The text of contract.json.
 * @param extractText - The text of the extract.
 * @param acceptedText - The text of the list of known deviations.
 * @param io - Where to write.
 * @returns 0 if the deviations are exactly the known ones, 1 if not, 2
 *   for a damaged file, 3 if the guard withholds the output.
 */
export function runExtract(
  contractText: string,
  extractText: string,
  acceptedText: string,
  io: Io,
): number {
  try {
    const operations = contractOperations(contractText);
    const extract = readExtract(extractText);
    const accepted = readAccepted(acceptedText);
    const compared = compareContract(documentOf(extract), operations);
    const known = new Set(accepted.map(deviationKey));
    const found = new Set(compared.deviations.map(deviationKey));
    const fresh = compared.deviations.filter(
      (deviation) => !known.has(deviationKey(deviation)),
    );
    const gone = accepted.filter(
      (deviation) => !found.has(deviationKey(deviation)),
    );

    // In CI only the counts and the deviations that differ from the list
    // go out; the whole report is what the run against the state file
    // gives.
    const counts = {
      operationen: Object.keys(compared.report).length,
      abweichungen: compared.deviations.length,
      bekannt: accepted.length,
    };
    const guard = new Guard();
    guard.allowFixed(...words, ...extractWords, ...Object.values(counts));
    guard.allowVersion(extract.source.churchToolsVersion);
    guard.allowFixed(...compared.fixed);
    for (const name of compared.checked) guard.allowChecked(name);
    // The known deviations stand in the repository.
    guard.allowFixed(
      ...accepted.flatMap((deviation) => [
        deviation.operation,
        ...(deviation.feld === undefined ? [] : [deviation.feld]),
      ]),
    );

    const output: Json = {
      abgleich: 'auszug',
      churchtoolsVersion: extract.source.churchToolsVersion,
      ...counts,
      neu: fresh.map(withoutReason),
      nichtMehr: gone.map(withoutReason),
    };
    const code = writeResult(output, guard, io);
    if (code !== exitCodes.ok) return code;
    if (fresh.length > 0 || gone.length > 0) {
      io.stderr(`${mismatchNote}\n`);
      return mismatchCode;
    }
    return exitCodes.ok;
  } catch (error) {
    return writeError(error, io);
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
  if (process.argv.includes('--auszug')) {
    process.exitCode = runExtract(
      contractText,
      readFileSync(defaultExtractFile, 'utf8'),
      readFileSync(defaultAcceptedFile, 'utf8'),
      io,
    );
  } else {
    const catalogText = readFileSync(
      new URL(
        '../../packages/core/src/churchtools/catalog/generated.ts',
        import.meta.url,
      ),
      'utf8',
    );
    process.exitCode = run(process.env, contractText, io, catalogText);
  }
}
