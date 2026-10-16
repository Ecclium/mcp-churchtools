/**
 * Builds the HTTP transport on a MockAgent of undici, for tests (ADR 0056).
 * This is the entry point of the subpath `./http/testing` of core, and only
 * the test double in testkit imports it. The transport is the same as in
 * production, with the same checks, headers and failures; only the
 * dispatcher answers from interceptors instead of a server. The MockAgent
 * is built here, refuses every connection to the network and never leaves
 * this module, so no caller can switch the network back on.
 *
 * @packageDocumentation
 */
import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';
import { MockAgent, type MockCallHistory, type MockPool } from 'undici';

import { parseChurchToolsOrigin } from './origin.js';
import { revealSecret, type Secret } from './secret.js';
import {
  createTransport,
  type HttpTransport,
  isUserAgent,
  transportLimits,
} from './transport.js';

export type {
  HttpRequestOptions,
  HttpResponse,
  HttpTransport,
} from './transport.js';

/** What a mocked transport is built from. */
export interface MockedHttpTransportOptions {
  /** The origin the transport and its interceptors serve. */
  readonly origin: string;
  /** The token the transport sends. */
  readonly token: Secret;
  /** The User-Agent the transport sends. */
  readonly userAgent: string;
  /** The logger of the transport. */
  readonly logger: Logger;
  /** The clock for the duration in the log. */
  readonly clock: Clock;
}

/** What the transport sent, as the MockAgent saw it. */
export interface MockedCall {
  /** Always GET. */
  readonly method: string;
  /** The path without the query. */
  readonly path: string;
  /** The parameters of the query. */
  readonly searchParams: Readonly<Record<string, string>>;
  /**
   * The headers of the request, the Authorization header with the token
   * included, so that a test can check what was sent. Only tests reach it.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/** What an interceptor matches, as undici takes it. */
export type InterceptOptions = Parameters<MockPool['intercept']>[0];

/** An interceptor, to give its reply. */
export type Interceptor = ReturnType<MockPool['intercept']>;

/** A transport on a MockAgent and the means to steer and read it. */
export interface MockedHttpTransport {
  /** The transport, as the code under test gets it. */
  readonly transport: HttpTransport;
  /**
   * Answers one request to the origin. Every request without an
   * interceptor fails, because the MockAgent connects nowhere.
   */
  intercept(options: InterceptOptions): Interceptor;
  /** Every request the transport sent so far, oldest first. */
  calls(): readonly MockedCall[];
  /** Throws when an interceptor was never used. */
  assertNoPendingInterceptors(): void;
  /** Closes the MockAgent. */
  close(): Promise<void>;
}

// The transport sends only strings, and the query of the call history
// holds strings as well.
const frozenCopy = (value: unknown): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.assign(Object.create(null) as Record<string, string>, value),
  );

/**
 * Builds a transport on a MockAgent that refuses every connection to the
 * network, with the limits of production.
 *
 * @param options - Origin, token, User-Agent, logger and clock.
 * @returns The transport and the means to steer and read its MockAgent.
 * @throws {TypeError} When the origin is not a canonical https origin, the
 *   token is not a Secret or the User-Agent is not printable ASCII.
 * @example
 * ```ts
 * const mocked = createMockedHttpTransport({
 *   origin,
 *   token,
 *   userAgent: 'Ecclium/0.0.0-test',
 *   logger,
 *   clock,
 * });
 * mocked.intercept({ path: '/api/whoami', method: 'GET' }).reply(200, '{}');
 * ```
 */
export function createMockedHttpTransport(
  options: MockedHttpTransportOptions,
): MockedHttpTransport {
  const { origin, token, userAgent, logger, clock } = options;
  const checked = parseChurchToolsOrigin(origin);
  if (!checked.ok || checked.origin !== origin) {
    throw new TypeError('The origin of a transport must be canonical.');
  }
  revealSecret(token);
  if (!isUserAgent(userAgent)) {
    throw new TypeError('The User-Agent of a transport must be printable.');
  }
  const agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  const pool = agent.get(origin);
  // The agent keeps the history, because it was built with it.
  const history = agent.getCallHistory() as MockCallHistory;
  const transport = createTransport(agent, {
    origin,
    token,
    userAgent,
    logger,
    clock,
    limits: transportLimits,
  });
  return Object.freeze({
    transport,
    intercept: (intercept: InterceptOptions): Interceptor =>
      pool.intercept(intercept),
    calls: (): readonly MockedCall[] =>
      Object.freeze(
        history.calls().map((call) =>
          Object.freeze({
            method: call.method,
            path: call.path,
            searchParams: frozenCopy(call.searchParams),
            headers: frozenCopy(call.headers),
          }),
        ),
      ),
    assertNoPendingInterceptors: (): void => {
      agent.assertNoPendingInterceptors();
    },
    close: async (): Promise<void> => {
      await agent.close();
    },
  });
}
