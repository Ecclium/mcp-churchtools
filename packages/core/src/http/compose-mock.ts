/**
 * Builds the HTTP transport on a MockAgent of undici, for tests (ADR 0056).
 * This is the entry point of the subpath `./http/testing` of core, and only
 * the test double in testkit imports it. The transport is the same as in
 * production, with the same checks, headers and failures; only the
 * dispatcher answers from interceptors instead of a server. The MockAgent
 * is built here, refuses every connection to the network and never leaves
 * this module, so no caller can switch the network back on. The same holds
 * for the transport to the endpoint of a model (ADR 0033) and for the
 * transport to the ping of the runner (ADR 0009).
 *
 * @packageDocumentation
 */
import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';
import { MockAgent, type MockCallHistory, type MockPool } from 'undici';

import {
  parseChurchToolsOrigin,
  parseModelEndpoint,
  parsePingUrl,
} from './origin.js';
import { revealSecret, type Secret } from './secret.js';
import {
  createModelTransport,
  createPingTransport,
  createTransport,
  type HttpTransport,
  isUserAgent,
  modelTransportLimits,
  type ModelTransport,
  pingTransportLimits,
  type PingTransport,
  transportLimits,
} from './transport.js';

export type {
  HttpRequestOptions,
  HttpResponse,
  HttpTransport,
  HttpWriteOptions,
  ModelTransport,
  PingKind,
  PingOptions,
  PingTransport,
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
  /** The method: GET, POST, PUT, PATCH or DELETE. */
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
  /**
   * The body of a write as text in UTF-8, so that a test can compare the
   * JSON that was sent; undefined for a request without body.
   */
  readonly body: string | undefined;
}

// The transport sends a body only as a Uint8Array of JSON in UTF-8.
const bodyText = (body: unknown): string | undefined =>
  body instanceof Uint8Array ? new TextDecoder().decode(body) : undefined;

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

// A MockAgent for one origin that refuses every connection to the network
// and keeps a history of the calls, and the means to steer and read it.
// The agent never leaves this module but as the dispatcher of a transport.
const mockAgentFor = (origin: string) => {
  const agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  const pool = agent.get(origin);
  // The agent keeps the history, because it was built with it.
  const history = agent.getCallHistory() as MockCallHistory;
  return {
    agent,
    steering: {
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
              body: bodyText(call.body),
            }),
          ),
        ),
      assertNoPendingInterceptors: (): void => {
        agent.assertNoPendingInterceptors();
      },
      close: async (): Promise<void> => {
        await agent.close();
      },
    },
  };
};

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
  const mock = mockAgentFor(origin);
  return Object.freeze({
    transport: createTransport(mock.agent, {
      origin,
      token,
      userAgent,
      logger,
      clock,
      limits: transportLimits,
    }),
    ...mock.steering,
  });
}

/** What a mocked transport to a model is built from (ADR 0033). */
export interface MockedModelTransportOptions {
  /** The address of the endpoint the transport and its interceptors serve. */
  readonly endpoint: string;
  /** The key the transport sends. */
  readonly key: Secret;
  /** The User-Agent the transport sends. */
  readonly userAgent: string;
  /** The logger of the transport. */
  readonly logger: Logger;
  /** The clock for the duration in the log. */
  readonly clock: Clock;
}

/** A transport to a model on a MockAgent and the means to steer and read it. */
export interface MockedModelTransport extends Omit<
  MockedHttpTransport,
  'transport'
> {
  /** The transport, as the code under test gets it. */
  readonly transport: ModelTransport;
}

/**
 * Builds a transport to a model on a MockAgent that refuses every
 * connection to the network, with the limits of a model.
 *
 * @param options - Endpoint, key, User-Agent, logger and clock.
 * @returns The transport and the means to steer and read its MockAgent.
 * @throws {TypeError} When the endpoint is not a canonical https address
 *   with a path, the key is not a Secret or the User-Agent is not
 *   printable ASCII.
 * @example
 * ```ts
 * const mocked = createMockedModelTransport({
 *   endpoint: 'https://model.example.org/v1/chat/completions',
 *   key,
 *   userAgent: 'Ecclium/0.0.0-test',
 *   logger,
 *   clock,
 * });
 * mocked
 *   .intercept({ path: '/v1/chat/completions', method: 'POST' })
 *   .reply(200, '{}');
 * ```
 */
export function createMockedModelTransport(
  options: MockedModelTransportOptions,
): MockedModelTransport {
  const { endpoint, key, userAgent, logger, clock } = options;
  const checked = parseModelEndpoint(endpoint);
  if (!checked.ok) {
    throw new TypeError('The endpoint of a transport must be canonical.');
  }
  revealSecret(key);
  if (!isUserAgent(userAgent)) {
    throw new TypeError('The User-Agent of a transport must be printable.');
  }
  const mock = mockAgentFor(checked.origin);
  return Object.freeze({
    transport: createModelTransport(mock.agent, {
      origin: checked.origin,
      path: checked.path,
      token: key,
      userAgent,
      logger,
      clock,
      limits: modelTransportLimits,
    }),
    ...mock.steering,
  });
}

/** What a mocked transport to the ping is built from (ADR 0009). */
export interface MockedPingTransportOptions {
  /** The address of the ping, a Secret as the configuration holds it. */
  readonly url: Secret;
  /** The User-Agent the transport sends. */
  readonly userAgent: string;
  /** The logger of the transport. */
  readonly logger: Logger;
  /** The clock for the duration in the log. */
  readonly clock: Clock;
}

/** A transport to the ping on a MockAgent and the means to steer and read it. */
export interface MockedPingTransport extends Omit<
  MockedHttpTransport,
  'transport'
> {
  /** The transport, as the code under test gets it. */
  readonly transport: PingTransport;
}

/**
 * Builds a transport to the ping of the runner on a MockAgent that
 * refuses every connection to the network, with the limits of a ping.
 *
 * @param options - Address, User-Agent, logger and clock.
 * @returns The transport and the means to steer and read its MockAgent.
 * @throws {TypeError} When the address is not a Secret or not a canonical
 *   https address with a path, or the User-Agent is not printable ASCII.
 * @example
 * ```ts
 * const mocked = createMockedPingTransport({
 *   url,
 *   userAgent: 'Ecclium/0.0.0-test',
 *   logger,
 *   clock,
 * });
 * mocked.intercept({ path: '/ping/check', method: 'POST' }).reply(200, 'OK');
 * ```
 */
export function createMockedPingTransport(
  options: MockedPingTransportOptions,
): MockedPingTransport {
  const { url, userAgent, logger, clock } = options;
  const checked = parsePingUrl(revealSecret(url));
  if (!checked.ok) {
    throw new TypeError('The address of a ping must be canonical.');
  }
  if (!isUserAgent(userAgent)) {
    throw new TypeError('The User-Agent of a transport must be printable.');
  }
  const mock = mockAgentFor(checked.origin);
  return Object.freeze({
    transport: createPingTransport(mock.agent, {
      origin: checked.origin,
      path: checked.path,
      userAgent,
      logger,
      clock,
      limits: pingTransportLimits,
    }),
    ...mock.steering,
  });
}
