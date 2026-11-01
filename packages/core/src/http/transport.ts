/**
 * The HTTP transport of the outbound path (ADR 0056): one origin, one
 * secret, GET to read and, since ADR 0072, POST, PUT, PATCH and DELETE to
 * write. It checks every target before a socket opens, sends the token only
 * in its Authorization header, passes on only three headers of an answer
 * and reduces every failure to a fixed category. A write carries a JSON
 * body of limited size and no query, reaches only the paths of the writes
 * the core knows, and no request is ever sent twice.
 *
 * Only `compose.ts` and `compose-mock.ts` use this module. Its build path
 * takes a dispatcher, a socket and limits, which the factories never take
 * from a caller.
 *
 * @packageDocumentation
 */
import { Buffer } from 'node:buffer';
import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { isUint8Array } from 'node:util/types';

import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';
import { Agent, buildConnector, type Dispatcher } from 'undici';

import type { HttpFailureEvent, HttpMethod } from '../logger/index.js';
import {
  categoriseFailure,
  type FailureCategory,
  HttpTransportError,
} from './failure.js';
import { keepKnownHeaders, type ResponseHeaders } from './response-headers.js';
import { revealSecret, type Secret } from './secret.js';
import { checkRequestTarget, checkWriteTarget } from './target.js';

/** The answer of the server, frozen. */
export interface HttpResponse {
  /** The HTTP status, 200 to 299 or 400 to 599; any other is refused. */
  readonly status: number;
  /** `content-type`, `retry-after` and `date`, where the server sent them. */
  readonly headers: ResponseHeaders;
  /** The whole body, never longer than the limit of the call. */
  readonly body: Uint8Array;
}

/** What a call of the transport takes besides the address. */
export interface HttpRequestOptions {
  /** Aborts the call. Its reason never leaves the transport. */
  readonly signal?: AbortSignal;
  /** The most bytes of body the call accepts, from 1 to 8 MiB. */
  readonly maxResponseBytes: number;
}

/** What a write with a body takes besides the address (ADR 0072). */
export interface HttpWriteOptions extends HttpRequestOptions {
  /**
   * The body as JSON in UTF-8, from 1 byte to 1 MiB. The transport copies
   * it when the call starts, so a later change by the caller sends nothing
   * else, and sends it as `application/json`.
   */
  readonly body: Uint8Array;
}

/**
 * The outbound path to one origin. Built only by the composition root, so
 * no tool can build one with an origin of its own (ADR 0056).
 */
export interface HttpTransport {
  /**
   * Sends a GET to the origin of the transport and reads the whole answer.
   *
   * @throws {HttpTransportError} For every failure, with a fixed category.
   */
  get(url: URL, options: HttpRequestOptions): Promise<HttpResponse>;
  /**
   * Sends a POST with a JSON body and no query and reads the whole answer.
   * After any failure but `refused`, ChurchTools may have written: read
   * again before deciding (ADR 0072).
   *
   * @throws {HttpTransportError} For every failure, with a fixed category.
   */
  post(url: URL, options: HttpWriteOptions): Promise<HttpResponse>;
  /**
   * Sends a PUT with a JSON body and no query, as {@link HttpTransport.post}.
   *
   * @throws {HttpTransportError} For every failure, with a fixed category.
   */
  put(url: URL, options: HttpWriteOptions): Promise<HttpResponse>;
  /**
   * Sends a PATCH with a JSON body and no query, as {@link HttpTransport.post}.
   *
   * @throws {HttpTransportError} For every failure, with a fixed category.
   */
  patch(url: URL, options: HttpWriteOptions): Promise<HttpResponse>;
  /**
   * Sends a DELETE without body and query, only to one appointment of a
   * calendar or one booking, for taking back what Ecclium created
   * (ADR 0072). Every other target is refused, as for each write every
   * path but those of its forms.
   *
   * @throws {HttpTransportError} For every failure, with a fixed category.
   */
  delete(url: URL, options: HttpRequestOptions): Promise<HttpResponse>;
  /** Lets running calls finish, then closes every connection. */
  close(): Promise<void>;
  /** Closes every connection at once and aborts running calls. */
  destroy(): Promise<void>;
}

/** The limits of a transport, all in milliseconds or bytes. */
export interface TransportLimits {
  /** Time to open a connection, TLS included. */
  readonly connectMs: number;
  /** Time until the headers of the answer have arrived. */
  readonly headersMs: number;
  /** The longest pause while the body arrives. */
  readonly bodyMs: number;
  /** Time for the whole call, body included. */
  readonly totalMs: number;
  /** How long an idle connection stays open, also as the cap for the server. */
  readonly keepAliveMs: number;
  /**
   * The most connections to the origin at once. Further calls wait in the
   * transport, where an abort or the deadline ends them at once.
   */
  readonly connections: number;
  /** The most bytes of body of any answer. */
  readonly maxResponseBytes: number;
  /** The most bytes of body of any write. */
  readonly maxRequestBytes: number;
  /** The most bytes of the headers of an answer. */
  readonly maxHeaderBytes: number;
}

/**
 * The limits of every transport the factories build (ADR 0056). Answers of
 * ChurchTools come within a second, a page of 100 entries stays far below
 * 8 MiB, and a tool passes on at most 64 KiB. A write carries at most one
 * text of 64 KiB, which JSON may escape to six times its size, so 1 MiB
 * leaves room and still bounds what one call can send (ADR 0072).
 */
export const transportLimits: TransportLimits = Object.freeze({
  connectMs: 10_000,
  headersMs: 15_000,
  bodyMs: 15_000,
  totalMs: 30_000,
  keepAliveMs: 10_000,
  connections: 4,
  maxResponseBytes: 8 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
  maxRequestBytes: 1024 * 1024,
});

/**
 * The options of the agent of a transport, without its connector. HTTP/2
 * is off and the parser fixed to llhttp, so that what runs in production
 * is what the tests see and no variable of the environment switches the
 * parser (ADR 0056). One origin per agent: a request to any other fails in
 * undici as well. One request per connection at a time: a connection that
 * closes then fails the one request it carries, and undici sends again only
 * requests it has not yet written, so no write goes out twice (ADR 0072).
 *
 * @param limits - The limits of the transport.
 * @returns The options, frozen.
 * @example
 * ```ts
 * agentOptions(transportLimits).allowH2; // false
 * ```
 */
export function agentOptions(limits: TransportLimits) {
  return Object.freeze({
    allowH2: false,
    useMilo: false,
    maxOrigins: 1,
    connections: limits.connections,
    pipelining: 1,
    headersTimeout: limits.headersMs,
    bodyTimeout: limits.bodyMs,
    keepAliveTimeout: limits.keepAliveMs,
    keepAliveMaxTimeout: limits.keepAliveMs,
    maxResponseSize: limits.maxResponseBytes,
    maxHeaderSize: limits.maxHeaderBytes,
  });
}

/**
 * Builds the agent of a transport with a connector of its own: it checks
 * certificates explicitly, whatever `NODE_TLS_REJECT_UNAUTHORIZED` says,
 * offers no HTTP/2 and gives up after the connect limit. A connect limit
 * on the agent would not reach a connector that is a function.
 *
 * @param limits - The limits of the transport.
 * @param socket - For tests only: gives an already connected socket, which
 *   the connector puts under TLS for the origin as it would any socket.
 * @returns The agent.
 * @example
 * ```ts
 * const agent = createAgent(transportLimits);
 * ```
 */
export function createAgent(
  limits: TransportLimits,
  socket?: () => Socket,
): Agent {
  const connector = buildConnector({
    rejectUnauthorized: true,
    allowH2: false,
    timeout: limits.connectMs,
  });
  const connect: buildConnector.connector =
    socket === undefined
      ? connector
      : (options, callback) => {
          connector({ ...options, httpSocket: socket() }, callback);
        };
  return new Agent({ ...agentOptions(limits), connect });
}

/**
 * Whether a value fits as the User-Agent of a transport: 1 to 256
 * characters of printable ASCII, no blank at either end. The factories
 * refuse any other value before they build anything.
 *
 * @param value - The value the composition root gives.
 * @returns Whether the transport may send it.
 * @example
 * ```ts
 * isUserAgent('Ecclium/1.0.0'); // true
 * ```
 */
export function isUserAgent(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return value.trim() === value;
}

/** What a transport is built from. */
export interface TransportSettings {
  /** The origin, as the configuration checked it. */
  readonly origin: string;
  /** The token for the Authorization header. */
  readonly token: Secret;
  /** The fixed User-Agent, as {@link isUserAgent} accepts it. */
  readonly userAgent: string;
  /** The logger, bound to the tenant by the composition root. */
  readonly logger: Logger;
  /** The clock for the duration in the log. */
  readonly clock: Clock;
  /** The limits of the transport. */
  readonly limits: TransportLimits;
}

// Whether a signal of the caller has aborted, read through the getter of
// the class with the signal as receiver: an own property named aborted
// cannot answer for it. For anything but a real AbortSignal the getter
// throws.
const hasAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined &&
  Reflect.get<AbortSignal, 'aborted'>(AbortSignal.prototype, 'aborted', signal);

// The listener goes on and off through the class as well, so that no own
// property of the signal answers for it. hasAborted has already shown that
// the signal is a real AbortSignal.
const listen = (signal: AbortSignal | undefined, listener: () => void) => {
  if (signal === undefined) return;
  EventTarget.prototype.addEventListener.call(signal, 'abort', listener, {
    once: true,
  });
};
const unlisten = (signal: AbortSignal | undefined, listener: () => void) => {
  if (signal === undefined) return;
  EventTarget.prototype.removeEventListener.call(signal, 'abort', listener);
};

const ignore = (): undefined => undefined;

// The event of each category, from the catalog of the logger (ADR 0054).
// Written out, not built from the category, so that every name can be
// found and a new category fails the type check here until it has one.
// The categories come from a closed list, so no lookup reaches the
// prototype.
const failureEvents: Readonly<Record<FailureCategory, HttpFailureEvent>> =
  Object.freeze({
    refused: 'http_refused',
    connect: 'http_connect',
    tls: 'http_tls',
    timeout: 'http_timeout',
    aborted: 'http_aborted',
    interrupted: 'http_interrupted',
    too_large: 'http_too_large',
    redirect: 'http_redirect',
    encoding: 'http_encoding',
    status: 'http_status',
    failed: 'http_failed',
  });

// Destroys a body the transport does not read. Destroying a body that has
// already arrived in full makes undici emit an error on it a tick later,
// which would end the process without a listener.
const drop = (body: Readable): void => {
  body.on('error', ignore);
  body.destroy();
};

// An own data property of the options, never a getter.
const ownValue = (options: unknown, key: string): unknown => {
  if (typeof options !== 'object' || options === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(options, key);
  return property !== undefined && 'value' in property
    ? property.value
    : undefined;
};

// The methods that carry a body. GET and DELETE never do (ADR 0072).
const withBody: readonly HttpMethod[] = Object.freeze(['POST', 'PUT', 'PATCH']);

// The prototype every typed array shares, whose byteLength getter reads
// the internal slot of a view. Read through it, an own property of the
// view cannot answer for the length.
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;

// A copy of the body of a write, or undefined when it is not a real
// Uint8Array of 1 byte to the limit. isUint8Array reads the internal slot,
// so a proxy or an object that only claims the type never fits. A view
// above the limit is refused before anything is copied; the length of the
// copy counts in the end, so a caller cannot change the body between the
// check and the send.
const copyBody = (value: unknown, max: number): Uint8Array | undefined => {
  if (
    !isUint8Array(value) ||
    (Reflect.get(typedArrayPrototype, 'byteLength', value) as number) > max
  ) {
    return undefined;
  }
  const body = new Uint8Array(value);
  return body.byteLength >= 1 && body.byteLength <= max ? body : undefined;
};

/**
 * Builds a transport on a dispatcher. The dispatcher is the agent from
 * {@link createAgent} or, for tests, a MockAgent; either way every call goes
 * through the same checks.
 *
 * @param dispatcher - Sends the requests to the origin.
 * @param settings - Origin, token, logger, clock and limits.
 * @returns The transport, frozen. It holds the dispatcher and the token
 *   only in its closures.
 * @example
 * ```ts
 * const transport = createTransport(createAgent(transportLimits), settings);
 * ```
 */
export function createTransport(
  dispatcher: Dispatcher,
  settings: TransportSettings,
): HttpTransport {
  const { origin, token, userAgent, logger, clock, limits } = settings;

  // Whether a body holds the token, as it is or escaped for JSON. A token
  // holds only visible ASCII (ADR 0054), so latin1 compares byte by byte.
  const carriesToken = (body: Uint8Array): boolean => {
    const value = revealSecret(token);
    const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return [value, JSON.stringify(value).slice(1, -1)].some((form) =>
      bytes.includes(form, 0, 'latin1'),
    );
  };

  // Calls beyond the connections of the pool wait here, not in undici: an
  // abort takes a waiting call out at once, while undici keeps a request
  // it has queued until a connection takes it. A call holds its place
  // until it has read or dropped the whole answer.
  let busy = 0;
  const waiting: (() => void)[] = [];
  const enter = (stop: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (busy < limits.connections) {
        busy += 1;
        resolve();
        return;
      }
      const onStop = (): void => {
        waiting.splice(waiting.indexOf(take), 1);
        reject(stop.reason as Error);
      };
      const take = (): void => {
        stop.removeEventListener('abort', onStop);
        resolve();
      };
      waiting.push(take);
      stop.addEventListener('abort', onStop, { once: true });
    });
  const leave = (): void => {
    const next = waiting.shift();
    if (next === undefined) busy -= 1;
    else next();
  };

  // Sends one request: the checks of target, limit, signal and body come
  // first, then a place in the queue, then the request, then the whole
  // answer. Every method goes this one way, so a write gets exactly the
  // checks, limits and failures of a read (ADR 0072).
  const send = async (
    method: HttpMethod,
    url: URL,
    options: HttpRequestOptions | HttpWriteOptions,
  ): Promise<HttpResponse> => {
    const started = clock.now();
    const duration = (): number =>
      Math.max(0, Math.round(clock.now() - started));
    const fail = (category: FailureCategory): HttpTransportError => {
      const error = new HttpTransportError(category);
      logger.warn(failureEvents[category], {
        code: error.code,
        durationMs: duration(),
        method,
      });
      return error;
    };

    // Checks before anything is sent. A limit out of range, a signal that
    // is no AbortSignal, a target the checks refuse and a body that is
    // missing, too large, given where none belongs or carries the token are
    // mistakes in the code that calls, never a socket.
    let max: number;
    let signal: AbortSignal | undefined;
    let path: string;
    let body: Uint8Array | undefined;
    try {
      const limit = ownValue(options, 'maxResponseBytes');
      const given = ownValue(options, 'signal');
      const target = checkRequestTarget(url, origin, token);
      if (
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > limits.maxResponseBytes ||
        !target.ok ||
        checkWriteTarget(method, target.path) !== undefined
      ) {
        throw new TypeError('refused');
      }
      const raw = ownValue(options, 'body');
      if (withBody.includes(method)) {
        body = copyBody(raw, limits.maxRequestBytes);
        // The token goes only into its header. A token in the body is a
        // mistake, such as a value pasted into a field. The search covers
        // the token as it is and as a string of JSON writes it, with a
        // backslash before each quote and backslash; it guards against
        // mistakes, not against code that sets out to encode it otherwise.
        if (body === undefined || carriesToken(body)) {
          throw new TypeError('refused');
        }
      } else if (raw !== undefined) {
        throw new TypeError('refused');
      }
      signal = given as AbortSignal | undefined;
      hasAborted(signal);
      max = limit as number;
      path = target.path;
    } catch {
      throw fail('refused');
    }
    if (hasAborted(signal)) throw fail('aborted');

    // The own deadline aborts with a reason of its own, which the failure
    // categories recognise by identity. The reason of the caller never
    // reaches undici: its signal only aborts the own controller. The call
    // ends when the controller aborts, wherever it waits, and does not
    // wait for undici to take the abort.
    const deadline = Object.freeze({ __proto__: null });
    const controller = new AbortController();
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(controller.signal.reason as Error);
        },
        { once: true },
      );
    });
    stopped.catch(ignore);
    const onAbort = (): void => {
      controller.abort(Object.freeze({ __proto__: null }));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let entered = false;
    let decided: FailureCategory | undefined;
    let phase: 'request' | 'body' = 'request';
    try {
      timer = setTimeout(() => {
        controller.abort(deadline);
      }, limits.totalMs);
      listen(signal, onAbort);
      await enter(controller.signal);
      entered = true;
      const headers: Record<string, string> = {
        authorization: `Login ${revealSecret(token)}`,
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': userAgent,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const pending = dispatcher.request({
        origin,
        path,
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      let answer: Dispatcher.ResponseData;
      try {
        answer = await Promise.race([pending, stopped]);
      } catch (error) {
        // An answer that comes after the abort is dropped unread.
        void pending.then((late) => {
          drop(late.body);
        }, ignore);
        throw error;
      }
      phase = 'body';
      // An answer the transport does not take is dropped before the
      // error, so that its connection does not stay busy in the pool.
      const refuse = (category: FailureCategory): never => {
        decided = category;
        drop(answer.body);
        throw new HttpTransportError(category);
      };
      const status = answer.statusCode;
      if (status >= 300 && status < 400) refuse('redirect');
      if (status < 200 || status > 599) refuse('status');
      const kept = keepKnownHeaders(answer.headers);
      if (!kept.ok) return refuse('encoding');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of answer.body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > max) refuse('too_large');
        chunks.push(chunk);
      }
      const read = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        read.set(chunk, offset);
        offset += chunk.byteLength;
      }
      logger.info('http_response', {
        durationMs: duration(),
        method,
        status,
      });
      return Object.freeze({
        __proto__: null,
        status,
        headers: kept.headers,
        body: read,
      });
    } catch (error) {
      throw fail(
        decided ??
          categoriseFailure(error, {
            phase,
            deadline,
            callerAborted: hasAborted(signal),
          }),
      );
    } finally {
      clearTimeout(timer);
      unlisten(signal, onAbort);
      if (entered) leave();
    }
  };

  return Object.freeze({
    get: (url: URL, options: HttpRequestOptions) => send('GET', url, options),
    post: (url: URL, options: HttpWriteOptions) => send('POST', url, options),
    put: (url: URL, options: HttpWriteOptions) => send('PUT', url, options),
    patch: (url: URL, options: HttpWriteOptions) => send('PATCH', url, options),
    delete: (url: URL, options: HttpRequestOptions) =>
      send('DELETE', url, options),
    close: async (): Promise<void> => {
      await dispatcher.close();
    },
    destroy: async (): Promise<void> => {
      await dispatcher.destroy();
    },
  });
}
