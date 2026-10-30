/**
 * The list of the operations the escape hatch reads, in the form of the
 * plugin API (ADR 0067). It comes from the catalog of the core alone and
 * asks ChurchTools nothing, so a tool can search it before it reads.
 *
 * @packageDocumentation
 */
import type {
  ApiOperation,
  ApiParameter,
  ApiParameterKind,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  findReadableOperation,
  generatedOperations,
  type PathParameter,
  type QueryParameter,
  type ReadableOperation,
} from './catalog/index.js';

const parameter = (
  name: string,
  kind: ApiParameterKind,
  required: boolean,
  list: boolean,
  values: readonly string[] | undefined,
): ApiParameter =>
  Object.freeze({
    name,
    kind,
    required,
    list,
    ...(values === undefined ? {} : { values: Object.freeze([...values]) }),
  });

const pathParameter = (entry: PathParameter): ApiParameter =>
  parameter(entry.name, entry.kind, true, false, entry.values);

// A parameter of the query the core never sends, of a kind it cannot fill
// or held back by the classification, is not listed: a model that set it
// would only get a refusal.
const queryParameters = (
  entries: readonly QueryParameter[],
): readonly ApiParameter[] =>
  Object.freeze(
    entries.flatMap((entry) =>
      entry.kind === 'unsupported'
        ? []
        : [
            parameter(
              entry.name,
              entry.kind,
              entry.required,
              entry.list === true,
              entry.values,
            ),
          ],
    ),
  );

const apiOperation = (operation: ReadableOperation): ApiOperation =>
  Object.freeze({
    operationId: operation.operationId,
    path: operation.path,
    sensitivity: operation.sensitivity,
    pathParameters: Object.freeze(operation.pathParameters.map(pathParameter)),
    queryParameters: queryParameters(operation.queryParameters),
  });

/**
 * Lists every operation of the catalog that the escape hatch reads, with
 * the same checks as a read: an operation is listed only if a read of it
 * would pass the catalog. Computed on each call, so that a server without
 * the escape hatch never builds it.
 *
 * @returns The operations, sorted by `operationId`, frozen.
 * @example
 * ```ts
 * listReadableOperations().find((entry) => entry.operationId === 'get-groups-groupId')?.path;
 * // '/api/groups/{groupId}'
 * ```
 */
export function listReadableOperations(): readonly ApiOperation[] {
  const listed = generatedOperations.flatMap((operation) => {
    const found = findReadableOperation(operation.operationId);
    return found.ok ? [apiOperation(found.operation)] : [];
  });
  listed.sort((a, b) =>
    a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0,
  );
  return Object.freeze(listed);
}
