/**
 * Reads one operation of the escape hatch by its `operationId` (ADR 0067).
 * The operation comes only from the catalog of the core, the URL only from
 * its template and the checked values, and every refusal of the catalog or
 * the values ends before the check of the tenant, the throttle and any
 * request. The answer goes through the limits of every answer of
 * ChurchTools but has no schema of its own: the caller gets the parsed
 * root only to mask it.
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  type Sensitivity,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import { HttpTransportError } from '../http/index.js';
import {
  buildOperationUrl,
  findReadableOperation,
  type RefusalReason,
} from './catalog/index.js';
import { fetchAnswer, type RequestPath } from './request.js';

/** A read of the escape hatch, as the core passes it on. */
export interface OperationRequest {
  /** The ID of the operation in the catalog. */
  readonly operationId: unknown;
  /** The path parameters, a plain object of names and values. */
  readonly path?: unknown;
  /** The parameters of the query, a plain object of names and values. */
  readonly query?: unknown;
}

/** The answer of a read of the escape hatch, before the mask. */
export interface OperationAnswer {
  readonly operationId: string;
  /** The sensitivity of the operation from the classification. */
  readonly sensitivity: Sensitivity;
  /** The parsed root object of the answer, without a schema. */
  readonly root: Readonly<Record<string, unknown>>;
}

/**
 * The limits of an answer of the escape hatch. A result passes on at most
 * 64 KiB, counted twice and with escapes, so a larger answer would never
 * fit; PHP writes umlauts as `ü` and `/` as `\/`, which the mask
 * writes shorter.
 */
export const operationLimits = Object.freeze({
  maxResponseBytes: 256 * 1024,
  maxElements: 32_768,
});

/** The message of an answer that is too large, for the model. */
export const tooLargeAnswer =
  'The answer of ChurchTools is too large for one result. Ask for fewer entries with limit or a filter.';

const unknownOperation =
  'No GET operation with this operationId is in the catalog of Ecclium. Look the operation up first.';

// One fixed sentence per reason, in English for the model. None names a
// value of the request.
const refusals: Readonly<Record<RefusalReason, string>> = Object.freeze({
  unclassified:
    'Ecclium has not classified this operation yet and does not read it.',
  method: 'Ecclium reads only GET operations.',
  deprecated: 'Ecclium does not read deprecated operations.',
  media: 'Ecclium reads only operations that answer with JSON.',
  fixed:
    'Ecclium never reads operations with tokens, secrets, files, finances, logs, exports or settings.',
  kind: 'Ecclium cannot fill the parameters of this operation safely.',
  secret: 'Ecclium never reads tokens or secrets.',
  csrf: 'Ecclium never reads the CSRF token.',
  file: 'Ecclium does not read files or documents.',
  finance: 'Ecclium does not read finances.',
  log: 'Ecclium does not read logs or histories.',
  export: 'Ecclium does not read exports.',
  system: 'Ecclium does not read the settings of the system or of persons.',
  care: 'Ecclium does not read data of pastoral care or health.',
  communication: 'Ecclium does not read communication between persons.',
  scope: 'This operation lies outside the areas that Ecclium reads.',
  parameter: 'Ecclium cannot fill a path parameter of this operation safely.',
});

/**
 * Reads one operation of the catalog.
 *
 * @param ctx - The context of the call.
 * @param path - Origin, transport and throttle of the client.
 * @param request - The operation and the values of its parameters.
 * @returns The ID, the sensitivity and the parsed root of the answer,
 *   frozen.
 * @throws {EccliumError} `validation` for an unknown operation or a value
 *   that does not fit, `policy_denied` for an operation the core does not
 *   read, `upstream` with a hint on `limit` for an answer that is too
 *   large, and the errors of {@link fetchAnswer}.
 * @example
 * ```ts
 * const answer = await readOperation(ctx, path, {
 *   operationId: 'get-groups-groupId',
 *   path: { groupId: 12 },
 * });
 * ```
 */
export async function readOperation(
  ctx: TenantContext,
  path: RequestPath,
  request: OperationRequest,
): Promise<OperationAnswer> {
  // Each part is read once, so that a getter cannot show the checks one
  // value and the request another.
  const { operationId, path: pathValues, query } = request;
  const found = findReadableOperation(operationId);
  if (!found.ok) {
    if (found.reason === 'unknown') {
      ctx.log.warn('churchtools_operation_unknown', { code: 'validation' });
      throw new EccliumError('validation', unknownOperation);
    }
    ctx.log.warn('churchtools_operation_refused', { code: 'policy_denied' });
    throw new EccliumError('policy_denied', refusals[found.reason]);
  }
  const operation = found.operation;
  const built = buildOperationUrl(path.origin, operation, {
    path: pathValues,
    query,
  });
  if (!built.ok) {
    ctx.log.warn('churchtools_operation_input_refused', {
      code: 'validation',
    });
    throw new EccliumError('validation', built.message);
  }
  let root: Readonly<Record<string, unknown>>;
  try {
    root = await fetchAnswer(ctx, path, built.url, operationLimits, {
      status: 'churchtools_operation_status',
      refused: 'churchtools_operation_answer_refused',
      // A 404 means a missing object only where the path names one.
      ...(operation.pathParameters.length > 0
        ? { missing: 'churchtools_operation_missing' }
        : {}),
    });
  } catch (error) {
    if (error instanceof HttpTransportError && error.category === 'too_large') {
      ctx.log.warn('churchtools_operation_too_large', { code: 'upstream' });
      throw new EccliumError('upstream', tooLargeAnswer);
    }
    throw error;
  }
  return Object.freeze({
    __proto__: null,
    operationId: operation.operationId,
    sensitivity: operation.sensitivity,
    root,
  });
}
