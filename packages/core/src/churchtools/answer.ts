/**
 * Reads an answer of ChurchTools in a fixed order (ADR 0057): status, media
 * type, byte order mark, UTF-8, the shape check and `JSON.parse`. It knows no
 * schema, writes no log and never reads the body of an answer other than
 * the status of success, 200 or, for a page that a write created, 201
 * (ADR 0072), so that values ChurchTools echoes in an error never leave it.
 *
 * @packageDocumentation
 */
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';

import type { HttpResponse } from '../http/index.js';
import { fitsShape } from './json-shape.js';
import { retryAfterSeconds } from './retry-after.js';

/** Why an answer was not read. */
export type AnswerReason =
  'status' | 'media' | 'bom' | 'utf8' | 'shape' | 'json';

/** What reading an answer gives. */
export type AnswerResult =
  | { readonly ok: true; readonly root: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly reason: AnswerReason;
      /** Whole seconds to wait, for a 429 with a usable `Retry-After`. */
      readonly waitSeconds?: number;
    };

/** The limits of one operation. */
export interface AnswerLimits {
  /** The most opening brackets and commas outside of strings. */
  readonly maxElements: number;
  /**
   * The status of the answer that is read, 200 unless given, 201 for the
   * answer to a write that created an object. Every other status is an
   * error, also another status of success.
   */
  readonly status?: 200 | 201;
}

/** The most levels of objects and arrays in an answer. */
export const maxAnswerDepth = 16;

// Fatal, so invalid UTF-8 is an error. With ignoreBOM, a byte order mark
// is never dropped silently; JSON.parse would refuse it as a second guard.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const refused = (code: ErrorCode, reason: AnswerReason): AnswerResult =>
  Object.freeze({ __proto__: null, ok: false, code, reason });

// The status contract of HttpResponse is 200 to 299 and 400 to 599; the
// transport refuses everything else (ADR 0056). 400 means the client sent
// something it should have refused itself, so it is internal; a write that
// knows another meaning of 400 gives its own code (ADR 0072).
const statusCode = (status: number): ErrorCode => {
  if (status === 400) return 'internal';
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limited';
  return 'upstream';
};

const isJson = (contentType: string | undefined): boolean => {
  if (contentType === undefined) return false;
  const end = contentType.indexOf(';');
  const type = (end === -1 ? contentType : contentType.slice(0, end)).trim();
  return type.toLowerCase() === 'application/json';
};

const startsWithBom = (body: Uint8Array): boolean =>
  body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;

/** Why an answer with another status than expected ends a call. */
export interface StatusFailure {
  /** The stable code of the error. */
  readonly code: ErrorCode;
  /** Whole seconds to wait, for a 429 with a usable `Retry-After`. */
  readonly waitSeconds?: number;
}

/**
 * Gives the code of an answer whose status is not the one of success, and
 * for a 429 the wait from `Retry-After`. It reads only the status and that
 * one header, never the body.
 *
 * @param response - The answer as the transport gave it.
 * @returns The code, and the wait if there is one.
 * @example
 * ```ts
 * statusFailure(answer).code; // 'permission' for a 403
 * ```
 */
export function statusFailure(response: HttpResponse): StatusFailure {
  const code = statusCode(response.status);
  const wait =
    code === 'rate_limited'
      ? retryAfterSeconds(response.headers['retry-after'])
      : undefined;
  return wait === undefined
    ? Object.freeze({ __proto__: null, code })
    : Object.freeze({ __proto__: null, code, waitSeconds: wait });
}

/**
 * Reads an answer of ChurchTools within fixed limits.
 *
 * @param response - The answer as the transport gave it.
 * @param limits - The limit of elements of the operation.
 * @returns The parsed root object, or a fixed code and reason.
 * @example
 * ```ts
 * const read = readAnswer(answer, { maxElements: 5_000 });
 * if (read.ok) console.log(Object.keys(read.root));
 * ```
 */
export function readAnswer(
  response: HttpResponse,
  limits: AnswerLimits,
): AnswerResult {
  if (response.status !== (limits.status ?? 200)) {
    const failure = statusFailure(response);
    return failure.waitSeconds === undefined
      ? refused(failure.code, 'status')
      : Object.freeze({
          __proto__: null,
          ok: false,
          code: failure.code,
          reason: 'status',
          waitSeconds: failure.waitSeconds,
        });
  }
  if (!isJson(response.headers['content-type'])) {
    return refused('upstream', 'media');
  }
  if (startsWithBom(response.body)) return refused('upstream', 'bom');
  let text: string;
  try {
    text = decoder.decode(response.body);
  } catch {
    return refused('upstream', 'utf8');
  }
  if (
    !fitsShape(text, {
      maxDepth: maxAnswerDepth,
      maxElements: limits.maxElements,
    })
  ) {
    return refused('upstream', 'shape');
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return refused('upstream', 'json');
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return refused('upstream', 'shape');
  }
  return Object.freeze({
    __proto__: null,
    ok: true,
    root: root as Readonly<Record<string, unknown>>,
  });
}
