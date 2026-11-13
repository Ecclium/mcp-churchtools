/**
 * The check of the proxy at the start of the server over stdio and of the
 * runner (ADR 0035). A client of its own asks the proxy for a tunnel with
 * CONNECT to the host and port of the origin of ChurchTools and closes the
 * socket as soon as the answer is in: no TLS, no request to ChurchTools,
 * no token. So the start learns that the proxy answers and lets
 * ChurchTools through, at no cost to the rate limit of the instance.
 *
 * @packageDocumentation
 */
import { buildConnector, Client } from 'undici';

import { parseChurchToolsOrigin, parseEgressProxy } from './origin.js';
import { transportLimits } from './transport.js';

/**
 * What the check found. `unreachable`: no connection to the proxy, such as
 * a name it cannot resolve or a port nobody listens on. `no_answer`: the
 * proxy took the connection but gave no answer in time or closed it.
 * `refused`: it answered CONNECT with a status other than 200, such as 403
 * for a target its list does not hold.
 */
export type ProxyProbe =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'unreachable' | 'no_answer' | 'refused';
    };

/** What the check is made with. */
export interface ProxyProbeOptions {
  /** The address of the proxy, as `parseEgressProxy` checked it. */
  readonly proxy: string;
  /** The origin of ChurchTools, as the configuration checked it. */
  readonly origin: string;
}

/** The limits of the check, for tests. */
export interface ProxyProbeLimits {
  /** How long the connection to the proxy may take. */
  readonly connectMs: number;
  /** How long the answer to CONNECT may take once connected. */
  readonly answerMs: number;
}

/**
 * The limits of the check: the connect limit of the transport (ADR 0056)
 * for the connection and again for the answer to CONNECT, as a tunnel of
 * the transport gets them. undici holds both, also against a proxy that
 * sends its answer a byte at a time.
 */
export const proxyProbeLimits: ProxyProbeLimits = Object.freeze({
  connectMs: transportLimits.connectMs,
  answerMs: transportLimits.connectMs,
});

/**
 * Asks the proxy for a tunnel to the origin of ChurchTools and closes it
 * again.
 *
 * @param options - The proxy and the origin, both checked.
 * @param limits - The limits, for tests.
 * @returns Whether the proxy gave the tunnel, else why not. It never
 *   throws for an answer or a failure of the network.
 * @throws {TypeError} When the proxy or the origin did not pass their
 *   checks, before a socket opens.
 * @example
 * ```ts
 * const probe = await probeEgressProxy({
 *   proxy: 'http://egress:3128',
 *   origin: 'https://example.church.tools',
 * });
 * if (!probe.ok) report(probe.reason);
 * ```
 */
export async function probeEgressProxy(
  options: ProxyProbeOptions,
  limits: ProxyProbeLimits = proxyProbeLimits,
): Promise<ProxyProbe> {
  const { proxy, origin } = options;
  const checkedProxy = parseEgressProxy(proxy);
  const checkedOrigin = parseChurchToolsOrigin(origin);
  if (
    !checkedProxy.ok ||
    checkedProxy.proxy !== proxy ||
    !checkedOrigin.ok ||
    checkedOrigin.origin !== origin
  ) {
    throw new TypeError('The proxy and the origin must be checked.');
  }
  // The origin holds no user, path or IPv6 address, so its host and port
  // make the target of CONNECT; without a port it is 443.
  const url = new URL(origin);
  const authority = `${url.hostname}:${url.port === '' ? '443' : url.port}`;
  // Whether the connection to the proxy came about. A failure after it,
  // the limit for the answer, a connection the proxy closed or reset, means
  // the proxy gave no answer; a failure before it, that it was not reached.
  const state = { connected: false };
  const client = new Client(proxy, {
    connect: buildConnector({ timeout: limits.connectMs }),
    allowH2: false,
    useMilo: false,
    pipelining: 1,
    headersTimeout: limits.answerMs,
    bodyTimeout: limits.answerMs,
    maxHeaderSize: transportLimits.maxHeaderBytes,
  });
  client.once('connect', () => {
    state.connected = true;
  });
  // As the ProxyAgent of undici asks: the target as the host and the name
  // of the proxy as the name of the server. Without that name undici takes
  // the host header and opens the connection to the address of the proxy
  // under the name of the target.
  const connectOptions = {
    path: authority,
    headers: { host: url.host },
    servername: checkedProxy.host,
  };
  try {
    const { statusCode, socket } = await client.connect(connectOptions);
    // Destroyed right away and without a reason, so it emits no error.
    socket.destroy();
    return statusCode === 200
      ? Object.freeze({ ok: true })
      : Object.freeze({ ok: false, reason: 'refused' });
  } catch {
    return Object.freeze({
      ok: false,
      reason: state.connected ? 'no_answer' : 'unreachable',
    });
  } finally {
    // A client that fails to close leaves the result as it is.
    await Promise.allSettled([client.destroy()]);
  }
}
