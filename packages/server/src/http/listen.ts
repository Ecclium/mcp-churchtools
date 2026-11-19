/**
 * The bridge between node:http and the application of the server over HTTP
 * (ADR 0073): it listens on a port, hands each request to the application
 * as a `Request` and writes the answer in one piece. It replaces no global
 * object and writes nothing past the logger, which is why it takes the
 * place of `@hono/node-server`.
 *
 * - The URL of a request has a fixed base and only the path of the client,
 *   never its `Host`; the application checks `Host` itself. A target that
 *   is no path, such as the absolute form a proxy takes or `*`, ends with
 *   400.
 * - The headers come from `rawHeaders`, so that two headers of the same
 *   name reach the checks joined by a comma and match no entry.
 * - The body is a stream without a buffer: nothing is read before the
 *   application reads, so a refused sign-in reads no body. Past 1 MiB and
 *   one more piece the stream ends with an error, also for a reader
 *   without a limit of its own.
 * - A body the application did not read to its end is read away after the
 *   answer, at most 1 MiB more, else the connection ends. Closing at once
 *   could lose the answer to a reset while the client still sends.
 * - When the client goes away, the signal of the request aborts, and a
 *   call ends as `network`.
 *
 * @packageDocumentation
 */
import { createServer } from 'node:http';

import { createHttpApp, type HttpAppOptions } from './app.js';
import { maxHttpBodyBytes } from './body.js';
import { parseAllowedHost } from './hosts.js';

/** The most bytes of the headers of a request, 16 KiB (ADR 0073). */
export const maxHttpHeaderBytes = 16 * 1024;

/** The times the bridge allows, in milliseconds (ADR 0073). */
export interface HttpLimits {
  /** Until the last header of a request has arrived. */
  readonly headersMs: number;
  /**
   * Until the whole request has arrived, its body included. The work after
   * that has deadlines of its own: the resolver of the tenant and every
   * request to ChurchTools.
   */
  readonly requestMs: number;
  /** How long an idle connection stays open for the next request. */
  readonly keepAliveMs: number;
  /** How often Node.js checks the first two; its default is 30 s. */
  readonly checkEveryMs: number;
  /** How long close waits for requests that still run. */
  readonly closeMs: number;
}

/** The limits of the bridge (ADR 0073). */
export const httpLimits: HttpLimits = Object.freeze({
  headersMs: 10_000,
  requestMs: 120_000,
  keepAliveMs: 5_000,
  checkEveryMs: 1_000,
  closeMs: 10_000,
});

/** What the server over HTTP is built and bound with. */
export interface HttpListenOptions extends HttpAppOptions {
  /**
   * The address to bind to, an IP address written out; `127.0.0.1` if left
   * out. Any address but `127.0.0.1` and `::1` needs `allowedHosts`.
   */
  readonly host?: string;
  /** The port, from 0 for one the system picks to 65535. */
  readonly port: number;
  /** Other limits, for tests; left out, {@link httpLimits}. */
  readonly limits?: Partial<HttpLimits>;
}

/** The server over HTTP while it listens. */
export interface HttpListener {
  /** The address it listens on. */
  readonly address: string;
  /** The port it listens on, also when the system picked it. */
  readonly port: number;
  /**
   * Takes no more connections, ends the idle ones at once and all others
   * after `closeMs`, then ends what the application still runs. It never
   * rejects, and a second call gives the same promise.
   */
  readonly close: () => Promise<void>;
}

/** Why the server over HTTP could not bind. */
export type HttpBindReason = 'address' | 'allowed-hosts' | 'port' | 'listen';

const bindSentences: Readonly<Record<HttpBindReason, string>> = Object.freeze({
  address: 'The server over HTTP binds only to an IP address written out.',
  'allowed-hosts':
    'The server over HTTP binds to an address other than loopback only with a list of allowed hosts.',
  port: 'The port of the server over HTTP lies outside 0 to 65535.',
  listen: 'The server over HTTP could not listen on its address and port.',
});

/**
 * The server over HTTP could not bind. The message is a fixed sentence;
 * the command maps the error to exit code 78, a fault of the
 * configuration.
 *
 * @example
 * ```ts
 * if (error instanceof HttpBindError && error.reason === 'allowed-hosts') {
 *   // tell the operator to set the allowed hosts
 * }
 * ```
 */
export class HttpBindError extends Error {
  /** Why it could not bind. */
  readonly reason: HttpBindReason;
  /** The code of the system for `listen`, such as `EADDRINUSE`. */
  readonly code: string | undefined;

  /**
   * Makes the error with the fixed sentence of its reason.
   *
   * @param reason - Why it could not bind.
   * @param code - The code of the system, for `listen` only.
   */
  constructor(reason: HttpBindReason, code?: string) {
    super(bindSentences[reason]);
    this.name = 'HttpBindError';
    this.reason = reason;
    this.code = code;
  }
}

/** What the bridge reads of a request of node:http. */
export interface IncomingRequest extends AsyncIterable<Uint8Array> {
  /** The method, as the client sent it. */
  readonly method?: string | undefined;
  /** The target of the request line. */
  readonly url?: string | undefined;
  /** The headers in their order, names and values taking turns. */
  readonly rawHeaders: readonly string[];
}

// The base of the URL of every request: never a value of the client.
const base = 'http://ingress.invalid';

const bodiless: readonly string[] = Object.freeze(['GET', 'HEAD']);

const loopbackAddresses: readonly string[] = Object.freeze([
  '127.0.0.1',
  '::1',
]);

// Headers of one connection, which the bridge sets itself or leaves out.
const hopByHop: readonly string[] = Object.freeze([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const digitsAndDots = /^[0-9.]+$/;

// What Node.js itself answers to a request it cannot parse; the bridge
// answers the same, after it wrote its own event.
const clientErrorAnswers: Readonly<Record<string, string>> = Object.freeze({
  HPE_HEADER_OVERFLOW:
    'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n',
  HPE_CHUNK_EXTENSIONS_OVERFLOW:
    'HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n',
  ERR_HTTP_REQUEST_TIMEOUT:
    'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n',
});
const badRequestAnswer =
  'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';

// A connection that ended under the client gives these codes; they are no
// fault of the request and write no line.
const goneCodes: readonly unknown[] = Object.freeze(['ECONNRESET', 'EPIPE']);

const malformedSentence =
  'This server takes only requests to a path, with headers it can read.';
const internalSentence =
  'The server failed. The log of the operator says more.';

// Whether an address to bind to is an IP address written out, IPv4 or
// IPv6 without brackets, in the form the allowed hosts use.
const isIpAddress = (host: string): boolean => {
  if (digitsAndDots.test(host)) {
    const entry = parseAllowedHost(host);
    return entry?.name === host && entry.port === undefined;
  }
  const entry = parseAllowedHost(`[${host}]`);
  return entry?.name === `[${host}]` && entry.port === undefined;
};

const isLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const limitsOf = (given: Partial<HttpLimits> | undefined): HttpLimits => {
  const limits = { ...httpLimits, ...given };
  if (
    !Object.values(limits).every(isLimit) ||
    limits.headersMs > limits.requestMs
  ) {
    throw new TypeError(
      'The limits of the server over HTTP are whole positive milliseconds.',
    );
  }
  return Object.freeze(limits);
};

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;

/**
 * A puller of the chunks of a body, made on the first pull, so that
 * nothing reads the request before someone wants its body.
 *
 * @param incoming - The request.
 * @returns A function that gives the next chunk, or `undefined` at the end.
 */
function pullerOf(
  incoming: AsyncIterable<Uint8Array>,
): () => Promise<Uint8Array | undefined> {
  let chunks: AsyncIterator<Uint8Array> | undefined;
  return async () => {
    chunks ??= incoming[Symbol.asyncIterator]();
    const step = await chunks.next();
    return step.done === true ? undefined : step.value;
  };
}

/**
 * The body of a request as a stream without a buffer. It pulls a chunk
 * only when a reader asks, and after more than `limit` bytes it ends with
 * an error instead of the next chunk: a reader that stops at the limit, as
 * the one of the SDK does, sees the chunk past it and no error.
 *
 * @param pull - Gives the next chunk, or `undefined` at the end.
 * @param limit - The most bytes before the error.
 * @returns The stream.
 * @example
 * ```ts
 * const body = bodyStreamOf(pullerOf(incoming), maxHttpBodyBytes);
 * ```
 */
export function bodyStreamOf(
  pull: () => Promise<Uint8Array | undefined>,
  limit: number,
): ReadableStream<Uint8Array> {
  let received = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        if (received > limit) {
          controller.error(new RangeError('The body is over its limit.'));
          return;
        }
        const chunk = await pull();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        received += chunk.byteLength;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Builds the `Request` the application takes: a fixed base with the path of
 * the client, the headers from `rawHeaders` in their order, and the body as
 * a stream for every method but `GET` and `HEAD`.
 *
 * @param incoming - The request of node:http.
 * @param body - The body, read only when the application reads it.
 * @param signal - Aborts when the client goes away.
 * @returns The request, or `undefined` for a target that is no path, a
 *   header or method that fetch refuses.
 * @example
 * ```ts
 * const request = requestOf(incoming, body, controller.signal);
 * ```
 */
export function requestOf(
  incoming: IncomingRequest,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Request | undefined {
  const target = incoming.url ?? '';
  const method = incoming.method ?? '';
  if (!target.startsWith('/')) return undefined;
  try {
    const headers = new Headers();
    const raw = incoming.rawHeaders;
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const name = raw[index];
      const value = raw[index + 1];
      if (name !== undefined && value !== undefined)
        headers.append(name, value);
    }
    return new Request(`${base}${target}`, {
      method,
      headers,
      signal,
      ...(bodiless.includes(method) ? {} : { body, duplex: 'half' }),
    });
  } catch {
    return undefined;
  }
}

/** An answer as the bridge writes it. */
export interface Answer {
  /** The status. */
  readonly status: number;
  /** The headers, names and values taking turns, with the length. */
  readonly headers: readonly string[];
  /** The whole body. */
  readonly body: Uint8Array;
}

/**
 * Reads an answer of the application to its end and gives it as the
 * bridge writes it: in one piece, with `Content-Length`, without the
 * headers of one connection.
 *
 * @param response - What the application answered.
 * @returns The answer to write.
 * @example
 * ```ts
 * const answer = await answerOf(Response.json({}));
 * ```
 */
export async function answerOf(response: Response): Promise<Answer> {
  const body = new Uint8Array(await response.arrayBuffer());
  const headers: string[] = [];
  response.headers.forEach((value, name) => {
    if (!hopByHop.includes(name)) headers.push(name, value);
  });
  headers.push('content-length', String(body.byteLength));
  return Object.freeze({
    status: response.status,
    headers: Object.freeze(headers),
    body,
  });
}

const refusalOf = (status: number, message: string): Response =>
  Response.json(
    { jsonrpc: '2.0', id: null, error: { code: -32000, message } },
    { status, headers: { 'cache-control': 'no-store' } },
  );

/**
 * Builds the server over HTTP and binds it: the application from the same
 * options, the server of node:http with the limits of ADR 0073, on
 * `127.0.0.1` unless an IP address is given. Any address but `127.0.0.1`
 * and `::1` needs a list of allowed hosts, so that the server never answers
 * for the names of loopback on a port others can reach.
 *
 * @param options - The options of the application, the address and port.
 * @returns The listening server, once it listens.
 * @throws {HttpBindError} For an address that is no IP address, another
 *   address than loopback without a list of hosts, a port outside 0 to
 *   65535, or when the system refuses to listen.
 * @throws {TypeError} For options the application refuses or limits that
 *   are no whole positive milliseconds.
 * @example
 * ```ts
 * const server = await listenHttp({ ...appOptions, port: 8787 });
 * await server.close();
 * ```
 */
export async function listenHttp(
  options: HttpListenOptions,
): Promise<HttpListener> {
  const { logger } = options;
  const host = options.host ?? '127.0.0.1';
  if (!isIpAddress(host)) throw new HttpBindError('address');
  if (!loopbackAddresses.includes(host) && options.allowedHosts === undefined) {
    throw new HttpBindError('allowed-hosts');
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new HttpBindError('port');
  }
  const limits = limitsOf(options.limits);
  const app = createHttpApp(options);

  // A failing logger never breaks an answer (ADR 0054).
  const warn = (
    event: 'http_request_malformed' | 'http_client_error',
  ): void => {
    try {
      logger.warn(event);
    } catch {
      // The answer does not depend on the log.
    }
  };
  const fail = (event: 'http_internal_error' | 'http_server_error'): void => {
    try {
      logger.error(event);
    } catch {
      // The answer does not depend on the log.
    }
  };

  const server = createServer({
    headersTimeout: limits.headersMs,
    requestTimeout: limits.requestMs,
    keepAliveTimeout: limits.keepAliveMs,
    connectionsCheckingInterval: limits.checkEveryMs,
    maxHeaderSize: maxHttpHeaderBytes,
    requireHostHeader: true,
    insecureHTTPParser: false,
  });

  // The connections on which an answer is being written. An error of the
  // client there must not write a second status line into the answer.
  const answering = new WeakSet<object>();

  server.on('request', (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.on('close', () => {
      if (!outgoing.writableFinished) controller.abort();
    });
    const pull = pullerOf(incoming);
    const { socket } = incoming;

    const answer = async (): Promise<Answer> => {
      const request = requestOf(
        incoming,
        bodyStreamOf(pull, maxHttpBodyBytes),
        controller.signal,
      );
      if (request === undefined) {
        warn('http_request_malformed');
        return answerOf(refusalOf(400, malformedSentence));
      }
      const response = await app.fetch(
        request,
        socket.localPort === undefined
          ? undefined
          : { localPort: socket.localPort },
      );
      try {
        return await answerOf(response);
      } catch {
        fail('http_internal_error');
        return answerOf(refusalOf(500, internalSentence));
      }
    };

    // Reads away what is left of a body after the answer, at most 1 MiB,
    // so that the client sees the answer and no reset; more ends the
    // connection.
    const drain = async (): Promise<void> => {
      let left = maxHttpBodyBytes;
      try {
        for (
          let chunk = await pull();
          chunk !== undefined;
          chunk = await pull()
        ) {
          left -= chunk.byteLength;
          if (left < 0) {
            socket.destroy();
            return;
          }
        }
      } catch {
        // The client went away.
      }
    };

    void answer().then(
      (written) => {
        if (outgoing.writableEnded || outgoing.destroyed) return;
        answering.add(socket);
        outgoing.once('finish', () => {
          answering.delete(socket);
        });
        outgoing.writeHead(written.status, [...written.headers]);
        outgoing.end(written.body);
        if (!incoming.complete) void drain();
      },
      () => {
        fail('http_internal_error');
        socket.destroy();
      },
    );
  });

  server.on('clientError', (error, socket) => {
    const code = codeOf(error);
    if (!goneCodes.includes(code)) warn('http_client_error');
    if (socket.writable && !answering.has(socket)) {
      socket.write(
        typeof code === 'string' && Object.hasOwn(clientErrorAnswers, code)
          ? clientErrorAnswers[code]
          : badRequestAnswer,
      );
    }
    socket.destroy();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => {
        server.off('listening', onListening);
        const code = codeOf(error);
        reject(
          new HttpBindError(
            'listen',
            typeof code === 'string' ? code : undefined,
          ),
        );
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host, port: options.port });
    });
  } catch (error) {
    await app.close();
    throw error;
  }

  // After the start, an error of the server writes a line and nothing
  // more; without a listener it would end the process.
  server.on('error', () => {
    fail('http_server_error');
  });

  const bound = server.address();
  const port =
    typeof bound === 'object' && bound !== null ? bound.port : options.port;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, limits.closeMs);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeIdleConnections();
    }).then(() => app.close());
    return closing;
  };

  return Object.freeze({ address: host, port, close });
}
