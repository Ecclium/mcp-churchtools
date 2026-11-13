/**
 * Builds the HTTP transport to a ChurchTools instance (ADR 0056). This is
 * the entry point of the subpath `./http` of core, and only the composition
 * root imports it: a rule of dependency-cruiser refuses every other
 * importer, so that no tool builds a transport with an origin of its own.
 * The factory takes no dispatcher, no socket, no limits and no header
 * besides the fixed User-Agent. The same holds for the factory of the
 * transport to the endpoint of a language model (ADR 0033) and for the
 * transport to the ping of the runner (ADR 0009). Of a proxy, all three
 * take only the address the configuration checked and build the agent
 * through it themselves; the check of the proxy at the start comes from
 * here as well (ADR 0035).
 *
 * @packageDocumentation
 */
import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';

import {
  parseChurchToolsOrigin,
  parseEgressProxy,
  parseModelEndpoint,
  parsePingUrl,
} from './origin.js';
import { revealSecret, type Secret } from './secret.js';
import {
  createAgent,
  createModelTransport,
  createPingTransport,
  createProxyAgent,
  createTransport,
  type HttpTransport,
  isUserAgent,
  modelTransportLimits,
  type ModelTransport,
  pingTransportLimits,
  type PingTransport,
  type TransportLimits,
  transportLimits,
} from './transport.js';

export {
  probeEgressProxy,
  type ProxyProbe,
  type ProxyProbeOptions,
} from './proxy-probe.js';
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
  /**
   * The proxy of the configuration, `http://host:port`, or undefined to
   * connect directly (ADR 0035).
   */
  readonly proxy?: string | undefined;
}

// The agent of a transport: direct, or through the checked proxy. A proxy
// that did not pass its check is refused before a pool exists.
const agentFor = (limits: TransportLimits, proxy: string | undefined) => {
  if (proxy === undefined) return createAgent(limits);
  const checked = parseEgressProxy(proxy);
  if (!checked.ok || checked.proxy !== proxy) {
    throw new TypeError('The proxy of a transport must be canonical.');
  }
  return createProxyAgent(limits, proxy);
};

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
  const { origin, token, userAgent, logger, clock, proxy } = options;
  const checked = parseChurchToolsOrigin(origin);
  if (!checked.ok || checked.origin !== origin) {
    throw new TypeError('The origin of a transport must be canonical.');
  }
  // Throws for anything but a Secret of this module, before a pool exists.
  revealSecret(token);
  if (!isUserAgent(userAgent)) {
    throw new TypeError('The User-Agent of a transport must be printable.');
  }
  return createTransport(agentFor(transportLimits, proxy), {
    origin,
    token,
    userAgent,
    logger,
    clock,
    limits: transportLimits,
  });
}

/** What the composition root gives a transport to a model (ADR 0033). */
export interface ModelHttpTransportOptions {
  /**
   * The address of the endpoint, as the configuration of the providers
   * checked it, such as `https://model.example.org/v1/chat/completions`.
   */
  readonly endpoint: string;
  /** The key of the provider, read from its file. */
  readonly key: Secret;
  /** The User-Agent of every request, as for ChurchTools. */
  readonly userAgent: string;
  /** The logger, bound to the tenant. */
  readonly logger: Logger;
  /** The clock for the duration in the log. */
  readonly clock: Clock;
  /** The proxy of the configuration, as for ChurchTools (ADR 0035). */
  readonly proxy?: string | undefined;
}

/**
 * Builds the transport to the endpoint of one model, with its own pool of
 * connections and the fixed limits of a model (ADR 0033). It sends only a
 * POST with JSON to the path of the endpoint, with the key as a bearer
 * token.
 *
 * @param options - Endpoint, key, User-Agent, logger and clock.
 * @returns The transport. Close it with `close()` when the run ends.
 * @throws {TypeError} When the endpoint is not a canonical https address
 *   with a path, the key is not a Secret or the User-Agent is not
 *   printable ASCII.
 * @example
 * ```ts
 * const transport = createModelHttpTransport({
 *   endpoint: provider.endpoint,
 *   key,
 *   userAgent: 'Ecclium/1.0.0',
 *   logger,
 *   clock: systemClock,
 * });
 * ```
 */
export function createModelHttpTransport(
  options: ModelHttpTransportOptions,
): ModelTransport {
  const { endpoint, key, userAgent, logger, clock, proxy } = options;
  const checked = parseModelEndpoint(endpoint);
  if (!checked.ok) {
    throw new TypeError('The endpoint of a transport must be canonical.');
  }
  // Throws for anything but a Secret of this module, before a pool exists.
  revealSecret(key);
  if (!isUserAgent(userAgent)) {
    throw new TypeError('The User-Agent of a transport must be printable.');
  }
  return createModelTransport(agentFor(modelTransportLimits, proxy), {
    origin: checked.origin,
    path: checked.path,
    token: key,
    userAgent,
    logger,
    clock,
    limits: modelTransportLimits,
  });
}

/** What the composition root gives the transport to the ping (ADR 0009). */
export interface PingHttpTransportOptions {
  /**
   * The address of the ping, as the configuration read it from its file,
   * such as `https://hc-ping.com/<uuid>`. A secret, because whoever knows
   * the path can report to the check.
   */
  readonly url: Secret;
  /** The User-Agent of every request, as for ChurchTools. */
  readonly userAgent: string;
  /** The logger of the runner. */
  readonly logger: Logger;
  /** The clock for the duration in the log. */
  readonly clock: Clock;
  /** The proxy of the configuration, as for ChurchTools (ADR 0035). */
  readonly proxy?: string | undefined;
}

/**
 * Builds the transport to the ping of the runner, with one connection of
 * its own and the short limits of a ping (ADR 0009). It sends only a POST
 * without body and without Authorization header to the path of the
 * address, for a failure to that path with `/fail`. The address is opened
 * here and held only in the closures of the transport.
 *
 * @param options - Address, User-Agent, logger, clock and proxy.
 * @returns The transport. Destroy it after the ping, so that no
 *   connection keeps the process open.
 * @throws {TypeError} When the address is not a Secret or not a canonical
 *   https address with a path, or the User-Agent is not printable ASCII.
 *   The message never shows the address.
 * @example
 * ```ts
 * const transport = createPingHttpTransport({
 *   url: config.runnerPingUrl,
 *   userAgent: 'Ecclium/1.0.0',
 *   logger,
 *   clock: systemClock,
 * });
 * ```
 */
export function createPingHttpTransport(
  options: PingHttpTransportOptions,
): PingTransport {
  const { url, userAgent, logger, clock, proxy } = options;
  // Throws for anything but a Secret of this module, before a pool exists.
  const checked = parsePingUrl(revealSecret(url));
  if (!checked.ok) {
    throw new TypeError('The address of a ping must be canonical.');
  }
  if (!isUserAgent(userAgent)) {
    throw new TypeError('The User-Agent of a transport must be printable.');
  }
  return createPingTransport(agentFor(pingTransportLimits, proxy), {
    origin: checked.origin,
    path: checked.path,
    userAgent,
    logger,
    clock,
    limits: pingTransportLimits,
  });
}
