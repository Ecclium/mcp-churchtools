/**
 * The checks of the proxy on the outbound path (ADR 0035). Each asks the
 * proxy with a client of its own for a tunnel with CONNECT and never sends
 * a request or a token through it.
 *
 * At the start of the server over stdio and of the runner, the tunnel goes
 * to the host and port of the origin of ChurchTools and closes as soon as
 * the answer is in, without TLS. So the start learns that the proxy
 * answers and lets ChurchTools through, at no cost to the rate limit of
 * the instance.
 *
 * `ecclium doctor` asks for a tunnel to each target of the list of the
 * proxy and makes a TLS handshake inside it, with certificate and name
 * checked as a transport checks them, then closes it. So it learns that
 * the target answers with a certificate the process trusts, not only that
 * the proxy lets the name through. A tunnel to a name outside the list,
 * without TLS, shows the status the proxy refuses it with.
 *
 * @packageDocumentation
 */
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

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
 * What the check of one target found. As {@link ProxyProbe}, with the
 * status of a refusal, so that 403 for a name outside the list tells apart
 * from 5xx, which a proxy gives once it asked DNS or tried the target.
 * `tls`: the proxy gave the tunnel, but the TLS handshake inside it
 * failed: a certificate the process does not trust or one for another
 * name, a target without TLS, or one that closed or stayed silent.
 */
export type EgressTargetProbe =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'unreachable' | 'no_answer' | 'tls';
    }
  | {
      readonly ok: false;
      readonly reason: 'refused';
      /** The status of the answer to CONNECT. */
      readonly status: number;
    };

/** What the check of one target is made with. */
export interface EgressTargetProbeOptions {
  /** The address of the proxy, as `parseEgressProxy` checked it. */
  readonly proxy: string;
  /**
   * The name of the target as an origin of the configuration holds it: in
   * lower case with a dot, never an IP address.
   */
  readonly host: string;
  /** The port of the target. */
  readonly port: number;
  /** Whether to make a TLS handshake inside the tunnel. */
  readonly tls: boolean;
}

/**
 * Whether a target fits a check: a name and a port that would make a
 * canonical origin of the configuration, so never an IP address, a user,
 * a path or a name in capitals.
 *
 * @param host - The name of the target.
 * @param port - The port of the target.
 * @returns Whether the checks take it.
 * @example
 * ```ts
 * isProbeTarget('example.church.tools', 443); // true
 * isProbeTarget('192.0.2.1', 443); // false
 * ```
 */
export function isProbeTarget(host: unknown, port: unknown): boolean {
  if (typeof host !== 'string' || !Number.isInteger(port)) return false;
  const origin =
    port === 443 ? `https://${host}` : `https://${host}:${String(port)}`;
  const checked = parseChurchToolsOrigin(origin);
  return checked.ok && checked.origin === origin;
}

/** The answer of the proxy, or why there is none. */
type Tunnel =
  | {
      readonly kind: 'answered';
      readonly status: number;
      readonly socket: Duplex;
    }
  | { readonly kind: 'failed'; readonly reason: 'unreachable' | 'no_answer' };

// Asks the proxy for a tunnel to the target, hands the answer to use and
// closes the client of the proxy afterwards, whatever use did. A failure
// after the connection to the proxy stood, the limit for the answer, a
// connection the proxy closed or reset, means the proxy gave no answer; a
// failure before it, that it was not reached.
const withTunnel = async <T>(
  proxy: { readonly url: string; readonly host: string },
  target: { readonly host: string; readonly port: string },
  limits: ProxyProbeLimits,
  use: (tunnel: Tunnel) => T | Promise<T>,
): Promise<T> => {
  const state = { connected: false };
  const client = new Client(proxy.url, {
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
    path: `${target.host}:${target.port}`,
    headers: {
      host:
        target.port === '443' ? target.host : `${target.host}:${target.port}`,
    },
    servername: proxy.host,
  };
  try {
    let tunnel: Tunnel;
    try {
      const { statusCode, socket } = await client.connect(connectOptions);
      tunnel = { kind: 'answered', status: statusCode, socket };
    } catch {
      tunnel = {
        kind: 'failed',
        reason: state.connected ? 'no_answer' : 'unreachable',
      };
    }
    return await use(tunnel);
  } finally {
    // A client that fails to close leaves the result as it is.
    await Promise.allSettled([client.destroy()]);
  }
};

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
  return withTunnel(
    { url: proxy, host: checkedProxy.host },
    { host: url.hostname, port: url.port === '' ? '443' : url.port },
    limits,
    (tunnel): ProxyProbe => {
      if (tunnel.kind === 'failed') {
        return Object.freeze({ ok: false, reason: tunnel.reason });
      }
      // Destroyed right away and without a reason, so it emits no error.
      tunnel.socket.destroy();
      return tunnel.status === 200
        ? Object.freeze({ ok: true })
        : Object.freeze({ ok: false, reason: 'refused' });
    },
  );
}

// The TLS handshake inside a tunnel, as the ProxyAgent of a transport makes
// it, and true once it passed. The socket is closed either way.
const handshake = (
  connect: buildConnector.connector,
  target: { readonly host: string; readonly port: string },
  socket: Duplex,
): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      connect(
        {
          hostname: target.host,
          protocol: 'https:',
          port: target.port,
          servername: target.host,
          httpSocket: socket as Socket,
        },
        (error, secured) => {
          if (error === null) secured.destroy();
          else socket.destroy();
          resolve(error === null);
        },
      );
    } catch {
      socket.destroy();
      resolve(false);
    }
  });

/**
 * Asks the proxy for a tunnel to one target and, with `tls`, makes a TLS
 * handshake inside it: certificates checked explicitly, whatever
 * `NODE_TLS_REJECT_UNAUTHORIZED` says, the name of the target as the name
 * of the server, no HTTP/2 and the connect limit. Then it closes the
 * tunnel without a request.
 *
 * @param options - The checked proxy, the target and whether to make the
 *   handshake.
 * @param limits - The limits, for tests.
 * @param connector - For tests only: makes the handshake on the socket of
 *   the tunnel in place of the connector of undici.
 * @returns Whether the tunnel and the handshake passed, else why not. It
 *   never throws for an answer or a failure of the network.
 * @throws {TypeError} When the proxy did not pass its check or the target
 *   is no name {@link isProbeTarget} takes, before a socket opens.
 * @example
 * ```ts
 * const probe = await probeEgressTarget({
 *   proxy: 'http://egress:3128',
 *   host: 'example.church.tools',
 *   port: 443,
 *   tls: true,
 * });
 * ```
 */
export async function probeEgressTarget(
  options: EgressTargetProbeOptions,
  limits: ProxyProbeLimits = proxyProbeLimits,
  connector?: buildConnector.connector,
): Promise<EgressTargetProbe> {
  const { proxy, host, port, tls } = options;
  const checkedProxy = parseEgressProxy(proxy);
  if (
    !checkedProxy.ok ||
    checkedProxy.proxy !== proxy ||
    !isProbeTarget(host, port) ||
    typeof tls !== 'boolean'
  ) {
    throw new TypeError('The proxy and the target must be checked.');
  }
  const target = { host, port: String(port) };
  const connect =
    connector ??
    buildConnector({
      rejectUnauthorized: true,
      allowH2: false,
      maxCachedSessions: 0,
      timeout: limits.connectMs,
    });
  return withTunnel(
    { url: proxy, host: checkedProxy.host },
    target,
    limits,
    async (tunnel): Promise<EgressTargetProbe> => {
      if (tunnel.kind === 'failed') {
        return Object.freeze({ ok: false, reason: tunnel.reason });
      }
      const { status, socket } = tunnel;
      if (status !== 200) {
        socket.destroy();
        return Object.freeze({ ok: false, reason: 'refused', status });
      }
      if (!tls) {
        socket.destroy();
        return Object.freeze({ ok: true });
      }
      return (await handshake(connect, target, socket))
        ? Object.freeze({ ok: true })
        : Object.freeze({ ok: false, reason: 'tls' });
    },
  );
}
