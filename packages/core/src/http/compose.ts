/**
 * Builds the HTTP transport to a ChurchTools instance (ADR 0056). This is
 * the entry point of the subpath `./http` of core, and only the composition
 * root imports it: a rule of dependency-cruiser refuses every other
 * importer, so that no tool builds a transport with an origin of its own.
 * The factory takes no dispatcher, no socket, no limits and no header
 * besides the fixed User-Agent.
 *
 * @packageDocumentation
 */
import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';

import { parseChurchToolsOrigin } from './origin.js';
import { revealSecret, type Secret } from './secret.js';
import {
  createAgent,
  createTransport,
  type HttpTransport,
  isUserAgent,
  transportLimits,
} from './transport.js';

export type {
  HttpRequestOptions,
  HttpResponse,
  HttpTransport,
  HttpWriteOptions,
} from './transport.js';

/** What the composition root gives a transport. */
export interface HttpTransportOptions {
  /** The origin of the instance, as the configuration checked it. */
  readonly origin: string;
  /** The token of the service account. */
  readonly token: Secret;
  /**
   * The User-Agent of every request, fixed for the process, such as
   * Ecclium with its version: 1 to 256 characters of printable ASCII.
   */
  readonly userAgent: string;
  /** The logger, bound to the tenant. */
  readonly logger: Logger;
  /** The clock for the duration in the log. */
  readonly clock: Clock;
}

/**
 * Builds the transport to one ChurchTools instance, with its own pool of
 * connections, the fixed limits and the checks of ADR 0056.
 *
 * @param options - Origin, token, User-Agent, logger and clock.
 * @returns The transport. Close it with `close()` when the process ends.
 * @throws {TypeError} When the origin is not a canonical https origin, the
 *   token is not a Secret or the User-Agent is not printable ASCII.
 * @example
 * ```ts
 * const transport = createHttpTransport({
 *   origin: config.churchtoolsOrigin,
 *   token: config.churchtoolsToken,
 *   userAgent: 'Ecclium/1.0.0',
 *   logger,
 *   clock: systemClock,
 * });
 * ```
 */
export function createHttpTransport(
  options: HttpTransportOptions,
): HttpTransport {
  const { origin, token, userAgent, logger, clock } = options;
  const checked = parseChurchToolsOrigin(origin);
  if (!checked.ok || checked.origin !== origin) {
    throw new TypeError('The origin of a transport must be canonical.');
  }
  // Throws for anything but a Secret of this module, before a pool exists.
  revealSecret(token);
  if (!isUserAgent(userAgent)) {
    throw new TypeError('The User-Agent of a transport must be printable.');
  }
  return createTransport(createAgent(transportLimits), {
    origin,
    token,
    userAgent,
    logger,
    clock,
    limits: transportLimits,
  });
}
