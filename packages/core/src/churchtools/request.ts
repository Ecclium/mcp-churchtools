/**
 * Sends one request of the ChurchTools client in a fixed order (ADR 0057):
 * the check of the tenant, a place of the throttle, the transport, then
 * reading the answer. It writes the fixed events of the operation and
 * passes every error of the transport on unchanged.
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { HttpTransport } from '../http/index.js';
import type {
  ChurchToolsMissingEvent,
  ChurchToolsRefusedEvent,
  ChurchToolsStatusEvent,
} from '../logger/index.js';
import type { RequestThrottle } from '../throttle/index.js';
import { readAnswer } from './answer.js';

/** What a request goes through. */
export interface RequestPath {
  /** The origin of the client, which `ctx.instance` must match. */
  readonly origin: string;
  readonly transport: HttpTransport;
  readonly throttle: RequestThrottle;
}

/** The limits of one operation. */
export interface OperationLimits {
  /** The most bytes of an answer. */
  readonly maxResponseBytes: number;
  /** The most opening brackets and commas of an answer. */
  readonly maxElements: number;
}

/**
 * The fixed events of one operation, each a name of the catalog of the
 * logger, so that the type check refuses a name without an entry
 * (ADR 0054).
 */
export interface OperationEvents {
  /** An answer with a status other than 200. */
  readonly status: ChurchToolsStatusEvent;
  /** An answer with status 200 that is not read. */
  readonly refused: ChurchToolsRefusedEvent;
  /**
   * An answer with status 404 of an operation that reads one object by its
   * ID: it then ends with `not_found`. Left out, a 404 is `upstream`,
   * because the path of every other operation is fixed and exists.
   */
  readonly missing?: ChurchToolsMissingEvent;
}

/**
 * The message of a rate limit with a wait, in English for the model.
 *
 * @param who - Whose limit it is.
 * @param seconds - The wait in whole seconds.
 * @returns One line.
 */
const waitMessage = (
  who: 'ChurchTools' | 'Ecclium',
  seconds: number,
): string =>
  who === 'ChurchTools'
    ? `ChurchTools limits the number of requests. Wait ${String(seconds)} seconds, then try again.`
    : `Ecclium limits its own requests to ChurchTools. Wait ${String(seconds)} seconds, then try again.`;

/**
 * Sends a GET and reads its answer.
 *
 * @param ctx - The context of the call.
 * @param path - Origin, transport and throttle of the client.
 * @param url - The target, built by the operation.
 * @param limits - The limits of the operation.
 * @param events - The events of the operation.
 * @returns The parsed root object of an answer with status 200.
 * @throws {EccliumError} For another tenant, a full throttle, every status
 *   but 200 and every answer that is not read; errors of the transport as
 *   they are.
 * @example
 * ```ts
 * const root = await fetchAnswer(ctx, path, url, limits, events);
 * ```
 */
export async function fetchAnswer(
  ctx: TenantContext,
  path: RequestPath,
  url: URL,
  limits: OperationLimits,
  events: OperationEvents,
): Promise<Readonly<Record<string, unknown>>> {
  if (ctx.instance !== path.origin) {
    ctx.log.error('churchtools_context_mismatch', { code: 'internal' });
    throw new EccliumError('internal');
  }
  const place = path.throttle.take();
  if (!place.ok) {
    ctx.log.warn('churchtools_throttled', { code: 'rate_limited' });
    throw new EccliumError(
      'rate_limited',
      waitMessage('Ecclium', place.waitSeconds),
    );
  }
  const response = await path.transport.get(url, {
    signal: ctx.signal,
    maxResponseBytes: limits.maxResponseBytes,
  });
  const read = readAnswer(response, { maxElements: limits.maxElements });
  if (read.ok) return read.root;
  if (
    read.reason === 'status' &&
    response.status === 404 &&
    events.missing !== undefined
  ) {
    ctx.log.warn(events.missing, { status: 404, code: 'not_found' });
    throw new EccliumError('not_found');
  }
  if (read.reason === 'status') {
    ctx.log.warn(events.status, { status: response.status, code: read.code });
  } else {
    ctx.log.warn(events.refused, { code: read.code });
  }
  throw new EccliumError(
    read.code,
    read.waitSeconds === undefined
      ? undefined
      : waitMessage('ChurchTools', read.waitSeconds),
  );
}
