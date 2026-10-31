/**
 * The operation catalog of the escape hatch (ADR 0067): the generated part
 * from the facts, the classification by hand and the checks of a read.
 * Only the modules of the raw client import it (the rule
 * operation-catalog-only-in-client).
 *
 * @packageDocumentation
 */
import { type LookupResult, lookupOperation } from './catalog.js';
import { classification, objectParameters } from './classification.js';
import { generatedOperations } from './generated.js';

export {
  isFixedExclusion,
  type LookupResult,
  type PathParameter,
  type QueryParameter,
  type ReadableOperation,
  type RefusalReason,
} from './catalog.js';
export { classification, objectParameters } from './classification.js';
export { generatedOperations } from './generated.js';
export {
  buildOperationUrl,
  type ObjectValue,
  type OperationUrl,
} from './parameters.js';
export type { ExclusionReason, ObjectParameters } from './types.js';

/**
 * Looks up an operation in the catalog of the core and checks that the
 * escape hatch may read it.
 *
 * @param operationId - The ID as the caller gave it.
 * @returns The readable operation, `unknown`, or the reason the core
 *   refuses it.
 * @example
 * ```ts
 * const found = findReadableOperation('get-groups-groupId');
 * if (found.ok) console.log(found.operation.sensitivity); // 'special'
 * ```
 */
export function findReadableOperation(operationId: unknown): LookupResult {
  return lookupOperation(
    operationId,
    generatedOperations,
    classification,
    objectParameters,
  );
}
