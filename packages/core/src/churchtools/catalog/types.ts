/**
 * The types of the operation catalog of the escape hatch (ADR 0067): the
 * part that `pnpm docs:refresh` writes from the facts of the OpenAPI
 * document, and the classification of each operation by hand.
 *
 * @packageDocumentation
 */
import type { Sensitivity } from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The kinds of value of a parameter, as the generated part names them. A
 * kind the core cannot send safely, such as an object or a parameter in a
 * header, is `unsupported`.
 */
export const parameterKinds = Object.freeze([
  'integer',
  'number',
  'boolean',
  'string',
  'date',
  'date-time',
  'date-or-date-time',
  'enum',
  'unsupported',
] as const);

/** The kind of value of a parameter. */
export type ParameterKind = (typeof parameterKinds)[number];

/** Where a parameter goes, as the OpenAPI document says. */
export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/** A parameter of an operation in the generated part. */
export interface CatalogParameter {
  /** The name, such as `groupId` or `ids[]`. */
  readonly name: string;
  /** Where it goes. */
  readonly in: ParameterLocation;
  /** Whether the operation needs it. */
  readonly required: boolean;
  /** The kind of each value. */
  readonly kind: ParameterKind;
  /** Set when the value is a list, sent value by value under the name. */
  readonly list?: true;
  /** The allowed values of the kind `enum`. */
  readonly values?: readonly string[];
}

/** One operation of the generated part, without any text of the document. */
export interface GeneratedOperation {
  /** The ID of the operation in the OpenAPI document. */
  readonly operationId: string;
  /** The method of HTTP in lower case. The core reads only `get`. */
  readonly method: string;
  /** The path with `/api` in front and its parameters in braces. */
  readonly path: string;
  /** Whether the document marks the operation as deprecated. */
  readonly deprecated: boolean;
  /** Whether a successful answer is JSON and nothing else. */
  readonly json: boolean;
  /** The parameters in the order of the facts. */
  readonly parameters: readonly CatalogParameter[];
}

/**
 * The kinds a classification may give a path parameter whose kind the
 * document names wrongly or not at all.
 */
export type PathKindOverride = 'integer' | 'guid';

/**
 * Why an operation is excluded. The first seven are the fixed exclusions
 * of the escape hatch; the rest are reasons of the classification by hand
 * (ADR 0067). `birthdate` stands for an operation that reveals the day of
 * a birthday, which the mask cuts to the year.
 */
export const exclusionReasons = Object.freeze([
  'secret',
  'csrf',
  'file',
  'finance',
  'log',
  'export',
  'system',
  'care',
  'communication',
  'scope',
  'media',
  'parameter',
  'deprecated',
  'birthdate',
] as const);

/** Why an operation is excluded. */
export type ExclusionReason = (typeof exclusionReasons)[number];

/** An operation the escape hatch may read, with its sensitivity. */
export interface AllowedOperation {
  readonly allowed: true;
  /** How sensitive its answer is; the stricter of tool and operation wins. */
  readonly sensitivity: Sensitivity;
  /** Kinds of path parameters that replace those of the document. */
  readonly pathKinds?: Readonly<Record<string, PathKindOverride>>;
  /**
   * Parameters of the query the core never sends for this operation, such
   * as filters that would reveal what the mask hides.
   */
  readonly withoutQuery?: readonly string[];
}

/** An operation the escape hatch never reads, with the reason. */
export interface ExcludedOperation {
  readonly allowed: false;
  /** Why it is excluded. */
  readonly reason: ExclusionReason;
}

/** The classification of one operation by hand. */
export type Classification = AllowedOperation | ExcludedOperation;

/**
 * Classifies an operation as readable.
 *
 * @param sensitivity - How sensitive its answer is.
 * @param pathKinds - Kinds of path parameters that replace those of the
 *   document, where it names them wrongly or not at all.
 * @param withoutQuery - Parameters of the query the core never sends for
 *   this operation.
 * @returns The classification, frozen.
 * @example
 * ```ts
 * allowed('special', { groupId: 'integer' });
 * allowed('special', undefined, ['birthday_after']);
 * ```
 */
export function allowed(
  sensitivity: Sensitivity,
  pathKinds?: Readonly<Record<string, PathKindOverride>>,
  withoutQuery?: readonly string[],
): AllowedOperation {
  return Object.freeze({
    allowed: true,
    sensitivity,
    ...(pathKinds === undefined
      ? {}
      : { pathKinds: Object.freeze({ ...pathKinds }) }),
    ...(withoutQuery === undefined
      ? {}
      : { withoutQuery: Object.freeze([...withoutQuery]) }),
  });
}

/**
 * Classifies an operation as excluded.
 *
 * @param reason - Why the escape hatch never reads it.
 * @returns The classification, frozen.
 * @example
 * ```ts
 * excluded('secret');
 * ```
 */
export function excluded(reason: ExclusionReason): ExcludedOperation {
  return Object.freeze({ allowed: false, reason });
}

/**
 * Freezes the operations of the generated part with every parameter and
 * list of values, so that no code can change the catalog while it runs.
 *
 * @param operations - The operations as the generated part writes them.
 * @returns The same operations, frozen in every level.
 * @example
 * ```ts
 * const operations = frozenOperations([]);
 * ```
 */
export function frozenOperations(
  operations: readonly GeneratedOperation[],
): readonly GeneratedOperation[] {
  for (const operation of operations) {
    for (const parameter of operation.parameters) {
      if (parameter.values !== undefined) Object.freeze(parameter.values);
      Object.freeze(parameter);
    }
    Object.freeze(operation.parameters);
    Object.freeze(operation);
  }
  return Object.freeze(operations);
}
