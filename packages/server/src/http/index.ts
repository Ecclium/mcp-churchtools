/**
 * MCP over HTTP: the place ingress of the server (ADR 0073). It is the only
 * code that imports hono and the Hono adapter of the MCP SDK, and the only
 * code that will listen on a port. Every request it takes runs, in this
 * order, through the checks of `Host` and `Origin`, the sign-in, the checks
 * of the body and only then the handler of the SDK, which builds one
 * instance of the mount for the request.
 *
 * There is no way in without a sign-in: the application cannot be built
 * without a function that checks one (ADR 0037). Older clients are served
 * without a session (`legacy: 'stateless'`), `subscriptions/listen` is
 * refused before the handler, and a stream of one message goes to the
 * client as JSON, so that no answer stays open.
 *
 * This entry hands out only its own functions and types, never the mount,
 * the handler or an object of the SDK or of Hono.
 *
 * @packageDocumentation
 */
import type { ToolCatalog, ToolPipeline } from '@ecclium/mcp-churchtools-core';
import { createMcpMount } from '@ecclium/mcp-churchtools-core/mcp';
import type {
  Identity,
  Logger,
  Mode,
  RedactionLevel,
  TenantId,
  TenantResolver,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  hostHeaderValidation,
  originValidation,
} from '@modelcontextprotocol/hono';
import {
  type AuthInfo,
  createMcpHandler,
  isJsonContentType,
  localhostAllowedHostnames,
  type McpRequestContext,
  readRequestBody,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';

import {
  asksToListen,
  maxHttpBodyBytes,
  nestsTooDeep,
  requestIdOf,
} from './body.js';
import { asJsonWhenSingle } from './stream.js';

export { maxHttpBodyBytes, maxHttpBodyDepth } from './body.js';

/** The path of MCP. Every other path ends with 404. */
export const mcpPath = '/mcp';

/** What the composition root builds the server over HTTP from. */
export interface HttpAppOptions {
  /** The frozen catalog of tools, the same the pipeline runs. */
  readonly catalog: ToolCatalog;
  /** The pipeline every call runs through. */
  readonly pipeline: ToolPipeline;
  /**
   * Checks the sign-in of one request and gives its identity, or
   * `undefined` to refuse it with 401. A rejection counts as a refusal.
   * There is no default: without a sign-in there is no server over HTTP
   * (ADR 0037).
   */
  readonly authenticate: (request: Request) => Promise<Identity | undefined>;
  /** Assigns tenant and actor to the identity of a request, once per call. */
  readonly resolver: TenantResolver;
  /** How calls run, set by the composition root only. */
  readonly mode: Mode;
  /** The level of redaction of every call. */
  readonly redaction: RedactionLevel;
  /** Whether the server only reads. */
  readonly readOnly: boolean;
  /** Receives fixed events of the server, never a message of the SDK. */
  readonly logger: Logger;
  /**
   * Builds the logger of the lines of a prompt with the tenant bound to
   * it, so that such a line names the tenant (ADR 0065).
   */
  readonly promptLoggerFor?: (tenantId: TenantId) => Logger;
  /**
   * The version of the server, which the client reads in `serverInfo`: 1
   * to 32 printable ASCII characters without spaces.
   */
  readonly version: string;
  /**
   * The key that signs the `requestState` of a question before a write, 32
   * random bytes new for every process (ADR 0029, ADR 0073).
   */
  readonly requestStateKey?: Uint8Array;
  /**
   * The host names a request may name in `Host` and `Origin`, without a
   * port; the names for loopback if left out.
   */
  readonly allowedHostnames?: readonly string[];
}

/** The server over HTTP, as a function from a request to an answer. */
export interface HttpApp {
  /** Answers one request. It never rejects. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Ends what the handler of the SDK still runs. It never rejects. */
  readonly close: () => Promise<void>;
}

// The key under which the checked identity of a request travels in the
// authInfo of the SDK to the factory of the mount, the way the SDK foresees
// for servers with many principals. The token itself never goes there.
const identityKey = 'ecclium.identity';

// What the authInfo of the SDK holds in place of a token: a fixed word,
// never a value of the request.
const noToken = 'checked-by-ecclium';

// Events of the place ingress. They carry no field: a request is foreign
// input, and the SDK puts parts of it into the message of an error.
const authRefusedEvent = 'http_auth_refused';
const notJsonEvent = 'http_body_not_json';
const unreadableEvent = 'http_body_unreadable';
const tooLargeEvent = 'http_body_too_large';
const unparsableEvent = 'http_body_unparsable';
const tooDeepEvent = 'http_body_too_deep';
const listenRefusedEvent = 'http_listen_refused';
const handlerErrorEvent = 'mcp_http_error';
const internalErrorEvent = 'http_internal_error';

type WarnEvent =
  | typeof authRefusedEvent
  | typeof notJsonEvent
  | typeof unreadableEvent
  | typeof tooLargeEvent
  | typeof unparsableEvent
  | typeof tooDeepEvent
  | typeof listenRefusedEvent;
type ErrorEvent = typeof handlerErrorEvent | typeof internalErrorEvent;

// The answers the place ingress gives itself, each with a fixed sentence.
const sentences = Object.freeze({
  auth: 'This server needs a valid sign-in.',
  notJson: 'The body must be JSON, with the content type application/json.',
  unreadable: 'The body of the request could not be read.',
  tooLarge: `The body of the request is larger than ${String(maxHttpBodyBytes)} bytes.`,
  unparsable: 'The body of the request is no valid JSON.',
  tooDeep: 'The body of the request nests too deep.',
  listen:
    'This server offers no subscriptions: the lists of tools and prompts do not change while it runs.',
  internal: 'The server failed. The log of the operator says more.',
});

const noStore = Object.freeze({ 'cache-control': 'no-store' });

const refusal = (
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
): Response =>
  Response.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status, headers: noStore },
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Builds the server over HTTP: a Hono application with the first checks of
 * the adapter, the sign-in, the checks of the body and the handler of the
 * SDK. The mount comes from the same factory as over stdio, with the same
 * guards (ADR 0059), and reads the identity of each request.
 *
 * The answers of the place ingress itself:
 *
 * - 403 for a `Host` or `Origin` that is not allowed, from the adapter;
 * - 401 without a sign-in, before the body is read;
 * - 415 for a `POST` without JSON as its content type, 413 for a body over
 *   1 MiB, 400 for one that is no JSON or nests deeper than 64 levels;
 * - an error of JSON-RPC for `subscriptions/listen`, before the handler;
 * - 404 for any other path, 500 with a fixed sentence when the application
 *   itself fails.
 *
 * Each refusal writes one fixed event without fields. Everything else the
 * handler of the SDK answers, `GET` and `DELETE` with 405.
 *
 * @param options - What the mount needs, the check of the sign-in and the
 *   allowed host names.
 * @returns The server, frozen: `fetch` and `close`.
 * @throws {TypeError} When the version breaks its form; the message never
 *   holds the value.
 * @example
 * ```ts
 * const app = createHttpApp({ catalog, pipeline, authenticate, resolver,
 *   mode: 'interactive', redaction: 'standard', readOnly: true, logger,
 *   version: '0.1.0' });
 * const answer = await app.fetch(request);
 * ```
 */
export function createHttpApp(options: HttpAppOptions): HttpApp {
  const { logger, authenticate } = options;
  if (typeof authenticate !== 'function') {
    throw new TypeError('The server over HTTP needs a check of the sign-in.');
  }
  const hostnames = [
    ...(options.allowedHostnames ?? localhostAllowedHostnames()),
  ];

  // A failing logger never breaks an answer. Each event has its level, so
  // that the check of the log lines sees which line is written where (ADR
  // 0054).
  const warn = (event: WarnEvent): void => {
    try {
      logger.warn(event);
    } catch {
      // The answer does not depend on the log.
    }
  };
  const fail = (event: ErrorEvent): void => {
    try {
      logger.error(event);
    } catch {
      // The answer does not depend on the log.
    }
  };

  const identityOf = (context: McpRequestContext): Identity | undefined => {
    const extra = context.authInfo?.extra;
    const identity = isRecord(extra) ? extra[identityKey] : undefined;
    return isRecord(identity) ? (identity as unknown as Identity) : undefined;
  };

  const mount = createMcpMount({
    catalog: options.catalog,
    pipeline: options.pipeline,
    identityOf,
    resolver: options.resolver,
    mode: options.mode,
    redaction: options.redaction,
    readOnly: options.readOnly,
    logger,
    version: options.version,
    ...(options.promptLoggerFor === undefined
      ? {}
      : { promptLoggerFor: options.promptLoggerFor }),
    ...(options.requestStateKey === undefined
      ? {}
      : { requestStateKey: options.requestStateKey }),
  });

  // One handler for the application, one instance of the mount per
  // request. 'auto' and not 'json': the mount sends nothing before a
  // result, so every answer of the 2026 era is JSON all the same, and
  // 'json' writes a fixed warning past the logger each time a handler is
  // built (ADR 0073).
  const handler = createMcpHandler(mount.factory, {
    legacy: 'stateless',
    responseMode: 'auto',
    maxRequestBodySize: maxHttpBodyBytes,
    onerror: () => {
      fail(handlerErrorEvent);
    },
  });

  const authInfoOf = (identity: Identity): AuthInfo =>
    Object.freeze({
      token: noToken,
      clientId: '',
      scopes: [...identity.scopes],
      extra: Object.freeze({ [identityKey]: identity }),
    });

  const serve = async (request: Request): Promise<Response> => {
    let identity: Identity | undefined;
    try {
      identity = await authenticate(request);
    } catch {
      identity = undefined;
    }
    if (identity === undefined) {
      warn(authRefusedEvent);
      return refusal(401, -32000, sentences.auth);
    }
    const authInfo = authInfoOf(identity);
    if (request.method !== 'POST') {
      return asJsonWhenSingle(await handler.fetch(request, { authInfo }));
    }
    if (!isJsonContentType(request.headers.get('content-type'))) {
      warn(notJsonEvent);
      return refusal(415, -32000, sentences.notJson);
    }
    // Read from a copy, with the reader of the SDK, so that the checks
    // below and the SDK see the same message (ADR 0073).
    let body: Awaited<ReturnType<typeof readRequestBody>>;
    try {
      body = await readRequestBody(request.clone(), maxHttpBodyBytes);
    } catch {
      warn(unreadableEvent);
      return refusal(400, -32000, sentences.unreadable);
    }
    if (body.tooLarge) {
      warn(tooLargeEvent);
      return refusal(413, -32000, sentences.tooLarge);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      warn(unparsableEvent);
      return refusal(400, -32700, sentences.unparsable);
    }
    if (nestsTooDeep(parsed)) {
      warn(tooDeepEvent);
      return refusal(400, -32600, sentences.tooDeep);
    }
    if (asksToListen(parsed)) {
      warn(listenRefusedEvent);
      return refusal(200, -32601, sentences.listen, requestIdOf(parsed));
    }
    return asJsonWhenSingle(
      await handler.fetch(request, { authInfo, parsedBody: parsed }),
    );
  };

  const app = new Hono();
  // The first layer of the checks against DNS rebinding, from the adapter:
  // host names only, without port and scheme (ADR 0073).
  app.use('*', hostHeaderValidation(hostnames));
  app.use('*', originValidation(hostnames));
  app.all(mcpPath, (context) => serve(context.req.raw));
  app.notFound(() => new Response(null, { status: 404, headers: noStore }));
  app.onError(() => {
    fail(internalErrorEvent);
    return refusal(500, -32603, sentences.internal);
  });

  return Object.freeze({
    __proto__: null,
    fetch: async (request: Request): Promise<Response> => {
      try {
        return await app.fetch(request);
      } catch {
        fail(internalErrorEvent);
        return refusal(500, -32603, sentences.internal);
      }
    },
    close: async (): Promise<void> => {
      try {
        await handler.close();
      } catch {
        // Nothing is left to end.
      }
    },
  });
}
