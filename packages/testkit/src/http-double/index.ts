/**
 * A test double for ChurchTools (ADR 0056): the real HTTP transport of core
 * on a MockAgent of undici, which answers from interceptors and connects
 * nowhere. Tests of the client and the tools use it, so their requests run
 * through the same checks as in production. A second double does the same
 * for the endpoint of a language model (ADR 0033), a third for the ping of
 * the runner (ADR 0009). This folder is the only code
 * outside the outbound path that may import the subpath `./http/testing`
 * of core.
 *
 * @packageDocumentation
 */
import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMockedHttpTransport,
  createMockedModelTransport,
  createMockedPingTransport,
  type MockedHttpTransport,
  type MockedHttpTransportOptions,
  type MockedModelTransport,
  type MockedPingTransport,
} from '@ecclium/mcp-churchtools-core/http/testing';

export type {
  InterceptOptions,
  MockedCall,
  MockedHttpTransport,
  MockedModelTransport,
  MockedPingTransport,
} from '@ecclium/mcp-churchtools-core/http/testing';

/** The placeholder instance of the project. */
export const doubleOrigin = 'https://example.church.tools';

/** The User-Agent of every double. */
export const doubleUserAgent = 'Ecclium/0.0.0-test';

/** What a double needs; everything but the token has a default. */
export interface ChurchToolsDoubleOptions {
  /** The token the transport sends, a Secret of core. */
  readonly token: MockedHttpTransportOptions['token'];
  /** The origin, by default the placeholder instance. */
  readonly origin?: string;
  /** The logger, by default one that drops every line. */
  readonly logger?: Logger;
  /** The clock, by default one that stands still. */
  readonly clock?: Clock;
}

const silentLogger: Logger = Object.freeze({
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
});

const stillClock: Clock = Object.freeze({ now: (): number => 0 });

/**
 * Builds a double for ChurchTools: a transport that answers from
 * interceptors and connects nowhere.
 *
 * @param options - The token and, if needed, origin, logger and clock.
 * @returns The transport and the means to steer and read it. Close it
 *   after the test.
 * @throws {TypeError} When the origin is not a canonical https origin or
 *   the token is not a Secret.
 * @example
 * ```ts
 * const double = createChurchToolsDouble({ token });
 * double.intercept({ path: '/api/whoami', method: 'GET' }).reply(200, '{}');
 * const answer = await double.transport.get(new URL(`${doubleOrigin}/api/whoami`), {
 *   maxResponseBytes: 64 * 1024,
 * });
 * ```
 */
export function createChurchToolsDouble(
  options: ChurchToolsDoubleOptions,
): MockedHttpTransport {
  return createMockedHttpTransport({
    origin: options.origin ?? doubleOrigin,
    token: options.token,
    userAgent: doubleUserAgent,
    logger: options.logger ?? silentLogger,
    clock: options.clock ?? stillClock,
  });
}

/**
 * Fails when a double saw any request but GET. Every request that does not
 * read counts as an error, so a test of a dry run shows that nothing was
 * written (ADR 0072): a write that slips through fails the test, whatever
 * it would have changed. The message names method and path of each, never
 * a header, so it holds no token.
 *
 * @param double - The double, or anything that lists its calls.
 * @throws {Error} When a request other than GET was sent.
 * @example
 * ```ts
 * await runDryPlan(double.transport);
 * assertOnlyReads(double);
 * ```
 */
export function assertOnlyReads(
  double: Pick<MockedHttpTransport, 'calls'>,
): void {
  const writes = double.calls().filter((call) => call.method !== 'GET');
  if (writes.length === 0) return;
  throw new Error(
    `Expected only reads, but ${String(writes.length)} request(s) would write: ${writes
      .map((call) => `${call.method} ${call.path}`)
      .join(', ')}`,
  );
}

/** The placeholder endpoint of a model of the project (RFC 2606). */
export const doubleModelEndpoint =
  'https://model.example.org/v1/chat/completions';

/** What a double of a model needs; everything but the key has a default. */
export interface ModelEndpointDoubleOptions {
  /** The key the transport sends, a Secret of core. */
  readonly key: MockedHttpTransportOptions['token'];
  /** The endpoint, by default the placeholder endpoint. */
  readonly endpoint?: string;
  /** The logger, by default one that drops every line. */
  readonly logger?: Logger;
  /** The clock, by default one that stands still. */
  readonly clock?: Clock;
}

/**
 * Builds a double for the endpoint of a language model: the transport to
 * a model of core, which answers from interceptors and connects nowhere
 * (ADR 0033).
 *
 * @param options - The key and, if needed, endpoint, logger and clock.
 * @returns The transport and the means to steer and read it. Close it
 *   after the test.
 * @throws {TypeError} When the endpoint is not a canonical https address
 *   with a path or the key is not a Secret.
 * @example
 * ```ts
 * const double = createModelEndpointDouble({ key });
 * double
 *   .intercept({ path: '/v1/chat/completions', method: 'POST' })
 *   .reply(200, chatCompletion({ content: '{}' }), { headers: jsonHeaders });
 * ```
 */
export function createModelEndpointDouble(
  options: ModelEndpointDoubleOptions,
): MockedModelTransport {
  return createMockedModelTransport({
    endpoint: options.endpoint ?? doubleModelEndpoint,
    key: options.key,
    userAgent: doubleUserAgent,
    logger: options.logger ?? silentLogger,
    clock: options.clock ?? stillClock,
  });
}

/** What a double of the ping needs; everything but the address has a default. */
export interface PingDoubleOptions {
  /** The address of the ping, a Secret of core. */
  readonly url: MockedHttpTransportOptions['token'];
  /** The logger, by default one that drops every line. */
  readonly logger?: Logger;
  /** The clock, by default one that stands still. */
  readonly clock?: Clock;
}

/**
 * Builds a double for the ping of the runner: the transport to the ping of
 * core, which answers from interceptors and connects nowhere (ADR 0009).
 *
 * @param options - The address and, if needed, logger and clock.
 * @returns The transport and the means to steer and read it. Close it
 *   after the test.
 * @throws {TypeError} When the address is not a Secret or not a canonical
 *   https address with a path.
 * @example
 * ```ts
 * const double = createPingDouble({ url });
 * double.intercept({ path: '/ping/check', method: 'POST' }).reply(200, 'OK');
 * ```
 */
export function createPingDouble(
  options: PingDoubleOptions,
): MockedPingTransport {
  return createMockedPingTransport({
    url: options.url,
    userAgent: doubleUserAgent,
    logger: options.logger ?? silentLogger,
    clock: options.clock ?? stillClock,
  });
}
