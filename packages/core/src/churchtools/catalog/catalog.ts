/**
 * Looks up an operation of the escape hatch by its `operationId` (ADR
 * 0067). An operation is readable only if the generated part knows it,
 * the classification by hand allows it, it is a GET with an answer in
 * JSON, no fixed rule excludes it and every path parameter has a kind the
 * core fills safely. Each of these checks also runs at the time of a read,
 * so a wrong classification still never reaches ChurchTools.
 *
 * @packageDocumentation
 */
import type { Sensitivity } from '@ecclium/mcp-churchtools-plugin-api';

import type {
  CatalogParameter,
  Classification,
  ExclusionReason,
  GeneratedOperation,
  ParameterKind,
} from './types.js';

/** The kinds of a path parameter the core fills: each has a closed form. */
export type PathKind = 'integer' | 'guid' | 'date' | 'enum';

/** A path parameter of a readable operation. */
export interface PathParameter {
  readonly name: string;
  readonly kind: PathKind;
  /** The allowed values of the kind `enum`. */
  readonly values?: readonly string[];
}

/** A parameter of the query of a readable operation. */
export interface QueryParameter {
  readonly name: string;
  readonly required: boolean;
  /** The kind of each value; `unsupported` is declared but never sent. */
  readonly kind: ParameterKind;
  /** Set when the value is a list, sent value by value under the name. */
  readonly list?: true;
  /** The allowed values of the kind `enum`. */
  readonly values?: readonly string[];
}

/** An operation the escape hatch may read. */
export interface ReadableOperation {
  readonly operationId: string;
  /** The path with `/api` in front and its parameters in braces. */
  readonly path: string;
  readonly sensitivity: Sensitivity;
  /** The path parameters in the order of the path. */
  readonly pathParameters: readonly PathParameter[];
  readonly queryParameters: readonly QueryParameter[];
}

/** Why the core refuses to read an operation it knows. */
export type RefusalReason =
  ExclusionReason | 'unclassified' | 'method' | 'fixed' | 'kind';

/** What looking up an operation gives. */
export type LookupResult =
  | { readonly ok: true; readonly operation: ReadableOperation }
  | { readonly ok: false; readonly reason: 'unknown' }
  | { readonly ok: false; readonly reason: RefusalReason };

/**
 * Parts of a literal segment of a path that the escape hatch never reads,
 * whatever the classification says: tokens and sign-in, secrets, CSRF,
 * finances, files and images, logs, exports and the settings of the system
 * (ADR 0067). A segment is matched in lower case, a part anywhere in it.
 */
export const fixedExclusionParts: readonly string[] = Object.freeze([
  'token',
  'login',
  'secret',
  'password',
  'csrf',
  'twofactor',
  'oauth',
  'saml',
  'sso',
  'captcha',
  'finance',
  'file',
  'image',
  'log',
  'history',
  'export',
  'csv',
  'ical',
  'datev',
  'setting',
  'config',
  'sync',
  'license',
  'queue',
  'job',
]);

/**
 * Whether a fixed rule excludes a path, whatever the classification says.
 * Only literal segments count, never a parameter in braces.
 *
 * @param path - The path of an operation, such as `/api/persons/{personId}`.
 * @returns `true` if a literal segment holds one of
 *   {@link fixedExclusionParts}.
 * @example
 * ```ts
 * isFixedExclusion('/api/persons/{personId}/logintoken'); // true
 * isFixedExclusion('/api/groups/{groupId}'); // false
 * ```
 */
export function isFixedExclusion(path: string): boolean {
  return path
    .split('/')
    .filter((segment) => !segment.startsWith('{'))
    .some((segment) => {
      const lower = segment.toLowerCase();
      return fixedExclusionParts.some((part) => lower.includes(part));
    });
}

// A value of the kind enum in a path: lower case letters, digits and
// underscores, so that it can never hold a character of a path or a query.
const isEnumSegment = (value: string): boolean => {
  if (value.length === 0 || value.length > 64) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const fits =
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x5f;
    if (!fits) return false;
  }
  return true;
};

// The names in braces of a path, in order. A path with an unclosed or
// empty brace gives undefined.
const namesInPath = (path: string): readonly string[] | undefined => {
  const names: string[] = [];
  let index = 0;
  while (index < path.length) {
    const open = path.indexOf('{', index);
    if (open === -1) break;
    const close = path.indexOf('}', open);
    if (close === -1 || close === open + 1) return undefined;
    const name = path.slice(open + 1, close);
    if (name.includes('{')) return undefined;
    names.push(name);
    index = close + 1;
  }
  return path.indexOf('}', index) === -1 ? names : undefined;
};

// The path parameter with its safe kind, or undefined when the core cannot
// fill it safely.
const pathParameter = (
  parameter: CatalogParameter,
  override: string | undefined,
): PathParameter | undefined => {
  if (!parameter.required || parameter.list === true) return undefined;
  if (override === 'integer' || override === 'guid') {
    return Object.freeze({ name: parameter.name, kind: override });
  }
  if (override !== undefined) return undefined;
  if (parameter.kind === 'integer' || parameter.kind === 'date') {
    return Object.freeze({ name: parameter.name, kind: parameter.kind });
  }
  if (
    parameter.kind === 'enum' &&
    parameter.values !== undefined &&
    parameter.values.length > 0 &&
    parameter.values.every(isEnumSegment)
  ) {
    return Object.freeze({
      name: parameter.name,
      kind: 'enum',
      values: parameter.values,
    });
  }
  return undefined;
};

// The readable form of an allowed operation, or the reason it is not.
const readable = (
  operation: GeneratedOperation,
  sensitivity: Sensitivity,
  pathKinds: Readonly<Record<string, string>>,
  withoutQuery: readonly string[],
): LookupResult => {
  const refuse = (reason: RefusalReason): LookupResult =>
    Object.freeze({ ok: false, reason });
  if (operation.method !== 'get') return refuse('method');
  if (operation.deprecated) return refuse('deprecated');
  if (!operation.json) return refuse('media');
  if (isFixedExclusion(operation.path)) return refuse('fixed');
  const names = namesInPath(operation.path);
  if (names === undefined || !operation.path.startsWith('/api/')) {
    return refuse('kind');
  }
  // Every override names a path parameter of the operation.
  for (const name of Object.keys(pathKinds)) {
    if (!names.includes(name)) return refuse('kind');
  }
  const pathParameters: PathParameter[] = [];
  for (const name of names) {
    const declared = operation.parameters.filter(
      (parameter) => parameter.in === 'path' && parameter.name === name,
    );
    const only = declared.length === 1 ? declared[0] : undefined;
    const override = Object.hasOwn(pathKinds, name)
      ? pathKinds[name]
      : undefined;
    const checked =
      only === undefined ? undefined : pathParameter(only, override);
    if (checked === undefined) return refuse('kind');
    pathParameters.push(checked);
  }
  // Every parameter the classification withholds is one of the query.
  for (const name of withoutQuery) {
    const declared = operation.parameters.some(
      (parameter) => parameter.in === 'query' && parameter.name === name,
    );
    if (!declared) return refuse('kind');
  }
  const queryParameters: QueryParameter[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in === 'path') {
      if (!names.includes(parameter.name)) return refuse('kind');
      continue;
    }
    // A header or a cookie is never sent; one the operation needs makes
    // it unreadable.
    if (parameter.in !== 'query') {
      if (parameter.required) return refuse('kind');
      continue;
    }
    // A withheld parameter stays declared, so that a request with it gets
    // the message that Ecclium does not send it.
    const kind = withoutQuery.includes(parameter.name)
      ? 'unsupported'
      : parameter.kind;
    if (parameter.required && kind === 'unsupported') {
      return refuse('kind');
    }
    queryParameters.push(
      Object.freeze({
        name: parameter.name,
        required: parameter.required,
        kind,
        ...(parameter.list === true ? { list: true as const } : {}),
        ...(parameter.values === undefined ? {} : { values: parameter.values }),
      }),
    );
  }
  return Object.freeze({
    ok: true,
    operation: Object.freeze({
      operationId: operation.operationId,
      path: operation.path,
      sensitivity,
      pathParameters: Object.freeze(pathParameters),
      queryParameters: Object.freeze(queryParameters),
    }),
  });
};

/**
 * Looks up an operation by its `operationId` in a catalog and checks that
 * the escape hatch may read it.
 *
 * @param operationId - The ID as the caller gave it.
 * @param operations - The generated part.
 * @param classification - The classification by hand, keyed by ID.
 * @returns The readable operation, `unknown` for an ID the generated part
 *   does not know, or the reason the core refuses it.
 * @example
 * ```ts
 * const found = lookupOperation('get-groups-groupId', operations, classes);
 * if (found.ok) console.log(found.operation.path);
 * ```
 */
export function lookupOperation(
  operationId: unknown,
  operations: readonly GeneratedOperation[],
  classification: Readonly<Record<string, Classification>>,
): LookupResult {
  const operation =
    typeof operationId === 'string'
      ? operations.find((entry) => entry.operationId === operationId)
      : undefined;
  if (operation === undefined) {
    return Object.freeze({ ok: false, reason: 'unknown' });
  }
  // Own properties only, so that an ID such as toString never reaches the
  // prototype of the object.
  const entry = Object.hasOwn(classification, operation.operationId)
    ? classification[operation.operationId]
    : undefined;
  if (entry === undefined) {
    return Object.freeze({ ok: false, reason: 'unclassified' });
  }
  if (!entry.allowed) return Object.freeze({ ok: false, reason: entry.reason });
  return readable(
    operation,
    entry.sensitivity,
    entry.pathKinds ?? {},
    entry.withoutQuery ?? [],
  );
}
