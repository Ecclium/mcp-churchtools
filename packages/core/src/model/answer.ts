/**
 * Reads the answer of the endpoint of a language model and the JSON a
 * model writes into its text (ADR 0033).
 *
 * Where it stands in a run: right after the call of the model, before the
 * adapter looks at what came back. The vendor is outside the trust of the
 * core, so its answer gets the checks of an answer of ChurchTools in the
 * same order: status, media type, byte order mark, UTF-8, the shape and
 * `JSON.parse`. The body of an answer that is no success is never read,
 * so no text of the vendor leaves this module.
 *
 * @packageDocumentation
 */
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';

import type { HttpResponse } from '../http/index.js';
import { fitsShape } from '../json/shape.js';

/** Why an answer or a text was not read. */
export type ModelAnswerReason =
  'status' | 'media' | 'bom' | 'utf8' | 'shape' | 'json';

/** What reading gives: the object, or the code and the reason. */
export type ModelAnswerResult =
  | { readonly ok: true; readonly root: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly reason: ModelAnswerReason;
    };

/**
 * The limits of the shape of an answer and of the JSON of a model, frozen.
 * An answer of a routine has at most ten blocks of 100 entries with eight
 * fields, so 20'000 elements leave room, and its depth stays below eight.
 */
export const modelAnswerLimits: {
  readonly maxDepth: number;
  readonly maxElements: number;
} = Object.freeze({ maxDepth: 16, maxElements: 20_000 });

// Fatal, so invalid UTF-8 is an error. With ignoreBOM, a byte order mark
// is never dropped silently.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const refused = (
  code: ErrorCode,
  reason: ModelAnswerReason,
): ModelAnswerResult =>
  Object.freeze({ __proto__: null, ok: false, code, reason });

// A 400, 404 or 422 says that model, path or the structured output of the
// configuration do not fit the vendor, so the operator must act. 401 and
// 403 say the same of the key. A 429 says the vendor limits the calls.
// Everything else, also another status of success, is the vendor's.
const statusCode = (status: number): ErrorCode => {
  if (status === 400 || status === 404 || status === 422) return 'config';
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

// The shape check and JSON.parse, for a decoded text. Only an object
// counts as an answer.
const parseObject = (text: string): ModelAnswerResult => {
  if (!fitsShape(text, modelAnswerLimits)) return refused('upstream', 'shape');
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
};

/**
 * Reads the answer of the endpoint of a model: status 200, media type
 * JSON, no byte order mark, UTF-8, the shape and an object.
 *
 * @param response - The answer of the transport to the model.
 * @returns The object of the answer, or the code and the reason.
 * @example
 * ```ts
 * const read = readModelAnswer(await transport.post(options));
 * if (!read.ok) throw new EccliumError(read.code, 'The model failed.');
 * ```
 */
export function readModelAnswer(response: HttpResponse): ModelAnswerResult {
  if (response.status !== 200) {
    return refused(statusCode(response.status), 'status');
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
  return parseObject(text);
}

/**
 * Reads the JSON a model wrote as the text of its answer, when the vendor
 * has no structured output: one object, which a fence of Markdown such as
 * three backticks with `json` may surround, with the shape and the limits
 * of an answer.
 *
 * @param text - The text of the answer of the model.
 * @returns The object, or the code and the reason.
 * @example
 * ```ts
 * parseModelJson('{"blocks":{}}'); // { ok: true, root: { blocks: {} } }
 * ```
 */
export function parseModelJson(text: string): ModelAnswerResult {
  let inner = text.trim();
  // Many models put JSON into a fence even when asked not to. Only a
  // fence around the whole text is dropped: its first line, which may
  // name the language, and the closing backticks.
  const fence = '```';
  if (inner.startsWith(fence) && inner.endsWith(fence)) {
    const firstLine = inner.indexOf('\n');
    inner =
      firstLine === -1 ? '' : inner.slice(firstLine + 1, -fence.length).trim();
  }
  return parseObject(inner);
}
