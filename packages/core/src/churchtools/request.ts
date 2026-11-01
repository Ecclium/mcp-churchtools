/**
 * Sends one request of the ChurchTools client in a fixed order (ADR 0057):
 * the check of the tenant, a place of the throttle, the transport, then
 * reading the answer. It writes the fixed events of the operation and
 * passes every error of the transport on unchanged. A write goes the same
 * way, under the same throttle (ADR 0072).
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  type ErrorCode,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { HttpResponse, HttpTransport } from '../http/index.js';
import type {
  ChurchToolsMissingEvent,
  ChurchToolsRefusedEvent,
  ChurchToolsStatusEvent,
} from '../logger/index.js';
import type { RequestThrottle } from '../throttle/index.js';
import { readAnswer, statusFailure } from './answer.js';

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

// The checks every request passes before the transport: the tenant of
// the call must be the instance of the client, and the throttle must give
// a place (ADR 0057).
const enter = (ctx: TenantContext, path: RequestPath): void => {
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
};

/** A read answer: its root object and the `date` header, if it came. */
export interface ReadAnswer {
  /** The parsed root object of the answer. */
  readonly root: Readonly<Record<string, unknown>>;
  /** The `date` header as ChurchTools sent it, unchecked. */
  readonly date: string | undefined;
}

/** What a 400 means for a write that knows its cause (ADR 0072). */
export interface BadRequest {
  /** The stable code of the error. */
  readonly code: ErrorCode;
  /** The sentence for the model, in English. */
  readonly message: string;
}

// Logs and throws for an answer whose status is not the one of success.
// Its body is never read, so no value ChurchTools echoes in an error leaves
// the client (ADR 0057).
const failStatus = (
  ctx: TenantContext,
  response: HttpResponse,
  events: Pick<OperationEvents, 'status' | 'missing'>,
  badRequest?: BadRequest,
): never => {
  if (response.status === 404 && events.missing !== undefined) {
    ctx.log.warn(events.missing, { status: 404, code: 'not_found' });
    throw new EccliumError('not_found');
  }
  if (response.status === 400 && badRequest !== undefined) {
    ctx.log.warn(events.status, { status: 400, code: badRequest.code });
    throw new EccliumError(badRequest.code, badRequest.message);
  }
  const failure = statusFailure(response);
  ctx.log.warn(events.status, {
    status: response.status,
    code: failure.code,
  });
  throw new EccliumError(
    failure.code,
    failure.waitSeconds === undefined
      ? undefined
      : waitMessage('ChurchTools', failure.waitSeconds),
  );
};

/**
 * Sends a GET and reads its answer, keeping the `date` header for a plan,
 * which compares it with the own clock before it writes (ADR 0029).
 *
 * @param ctx - The context of the call.
 * @param path - Origin, transport and throttle of the client.
 * @param url - The target, built by the operation.
 * @param limits - The limits of the operation.
 * @param events - The events of the operation.
 * @returns The parsed root object of an answer with status 200 and its
 *   `date` header.
 * @throws {EccliumError} For another tenant, a full throttle, every status
 *   but 200 and every answer that is not read; errors of the transport as
 *   they are.
 * @example
 * ```ts
 * const { root, date } = await fetchRead(ctx, path, url, limits, events);
 * ```
 */
export async function fetchRead(
  ctx: TenantContext,
  path: RequestPath,
  url: URL,
  limits: OperationLimits,
  events: OperationEvents,
): Promise<ReadAnswer> {
  enter(ctx, path);
  const response = await path.transport.get(url, {
    signal: ctx.signal,
    maxResponseBytes: limits.maxResponseBytes,
  });
  const read = readAnswer(response, { maxElements: limits.maxElements });
  if (read.ok) {
    return Object.freeze({
      __proto__: null,
      root: read.root,
      date: response.headers.date,
    });
  }
  if (read.reason === 'status') return failStatus(ctx, response, events);
  ctx.log.warn(events.refused, { code: read.code });
  throw new EccliumError(read.code);
}

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
  return (await fetchRead(ctx, path, url, limits, events)).root;
}

/** One write of the client and what it expects back (ADR 0072). */
export interface WriteCall {
  /** POST creates an object, PATCH changes one. */
  readonly method: 'POST' | 'PATCH';
  /** The target, built by the operation, without a query. */
  readonly url: URL;
  /** The body, JSON in UTF-8. */
  readonly body: Uint8Array;
  /** The status of success: 201 for POST, 200 for PATCH. */
  readonly success: 200 | 201;
  /**
   * The event for an answer of success whose body the client does not
   * take. Given, the body of the answer of success is read as JSON; left
   * out, it is not read at all, because its form is not shown and the read
   * after the write shows what changed.
   */
  readonly refused?: ChurchToolsRefusedEvent;
  /**
   * What a 400 means for this operation, when ChurchTools is known to send
   * it for a state of its own rather than for a mistake of the client, such
   * as a title that a page of the category already has (F8). Without it, a
   * 400 is internal as for a read.
   */
  readonly badRequest?: BadRequest;
}

/**
 * Sends a write and, when asked, reads its answer of success. The tenant,
 * the throttle and the transport come in the order of a read. ChurchTools
 * may have written whenever this throws after the transport was called,
 * so the caller reads again before deciding (ADR 0072).
 *
 * @param ctx - The context of the call.
 * @param path - Origin, transport and throttle of the client.
 * @param call - Method, target, body and what the write expects back.
 * @param limits - The limits of the answer.
 * @param events - The events of an answer with another status.
 * @returns The parsed root object of the answer of success, or undefined
 *   when its body is not read.
 * @throws {EccliumError} For another tenant, a full throttle, every other
 *   status and an answer of success that is not taken; errors of the
 *   transport as they are.
 * @example
 * ```ts
 * await sendWrite(ctx, path, { method: 'PATCH', url, body, success: 200 }, limits, events);
 * ```
 */
export async function sendWrite(
  ctx: TenantContext,
  path: RequestPath,
  call: WriteCall,
  limits: OperationLimits,
  events: Pick<OperationEvents, 'status' | 'missing'>,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  enter(ctx, path);
  const options = {
    signal: ctx.signal,
    maxResponseBytes: limits.maxResponseBytes,
    body: call.body,
  };
  const response =
    call.method === 'POST'
      ? await path.transport.post(call.url, options)
      : await path.transport.patch(call.url, options);
  if (response.status !== call.success) {
    return failStatus(ctx, response, events, call.badRequest);
  }
  if (call.refused === undefined) return undefined;
  const read = readAnswer(response, {
    maxElements: limits.maxElements,
    status: call.success,
  });
  if (read.ok) return read.root;
  ctx.log.warn(call.refused, { code: read.code });
  throw new EccliumError(read.code);
}
