/**
 * A test double for ChurchTools (ADR 0056): the real HTTP transport of core
 * on a MockAgent of undici, which answers from interceptors and connects
 * nowhere. Tests of the client and the tools use it, so their requests run
 * through the same checks as in production. This folder is the only code
 * outside the outbound path that may import the subpath `./http/testing`
 * of core.
 *
 * @packageDocumentation
 */
import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMockedHttpTransport,
  type MockedHttpTransport,
  type MockedHttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http/testing';

export type {
  InterceptOptions,
  MockedCall,
  MockedHttpTransport,
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
