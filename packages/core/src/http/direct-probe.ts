/**
 * The check of the direct path for `ecclium doctor` (ADR 0035): a TCP
 * connection straight to the host and port of a target, without the
 * proxy, without TLS and without a byte of data, closed as soon as it
 * stands. Where the runner may only go out through the proxy, it must
 * fail.
 *
 * Why only TCP: a connection that stands is all it takes to show that the
 * network lets the process out past the proxy, and anything more would
 * talk to the target. A name that does not resolve counts apart, because
 * then the check does not show whether an IP address would get through.
 *
 * @packageDocumentation
 */
import { buildConnector } from 'undici';

import { codeOf } from './failure.js';
import { isProbeTarget, type ProxyProbeLimits } from './proxy-probe.js';
import { transportLimits } from './transport.js';

/**
 * What the check found: a connection that stood, or none. `dns`: the name
 * did not resolve. `timeout`: nothing came about within the connect limit,
 * which counts the lookup of the name as well, so it does not show whether
 * the name resolved. `no_connection`: the connection was refused or had no
 * route, or the failure did not say.
 */
export type DirectProbe =
  | { readonly connected: true }
  | {
      readonly connected: false;
      readonly reason: 'dns' | 'timeout' | 'no_connection';
    };

/** What the check is made with. */
export interface DirectProbeOptions {
  /**
   * The name of the target as an origin of the configuration holds it: in
   * lower case with a dot, never an IP address.
   */
  readonly host: string;
  /** The port of the target. */
  readonly port: number;
}

// Codes of the connect limit, which undici and Node.js report.
const timeoutCodes: readonly string[] = Object.freeze([
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
]);

// Codes of a name that does not resolve, as Node.js reports them.
const dnsCodes: readonly string[] = Object.freeze([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NODATA',
  'EAI_NONAME',
]);

/**
 * Opens a TCP connection straight to the target and closes it at once,
 * with the connector of undici and the connect limit.
 *
 * @param options - The target.
 * @param limits - The connect limit of the transport (ADR 0056), for
 *   tests.
 * @returns Whether a connection stood, else why not. It never throws for a
 *   failure of the network.
 * @throws {TypeError} When the target is no name the checks take, before a
 *   socket opens.
 * @example
 * ```ts
 * const direct = await probeDirect({ host: 'example.church.tools', port: 443 });
 * if (direct.connected) report('the network lets the runner past the proxy');
 * ```
 */
export function probeDirect(
  options: DirectProbeOptions,
  limits: Pick<ProxyProbeLimits, 'connectMs'> = {
    connectMs: transportLimits.connectMs,
  },
): Promise<DirectProbe> {
  return probeDirectWith(
    options,
    buildConnector({ timeout: limits.connectMs, keepAlive: false }),
  );
}

/**
 * {@link probeDirect} with a connector the caller gives, for tests, whose
 * network guard refuses every name resolution.
 *
 * @param options - The target.
 * @param connect - Opens the connection.
 * @returns Whether a connection stood, else why not.
 * @throws {TypeError} When the target is no name the checks take, before a
 *   socket opens.
 * @example
 * ```ts
 * await probeDirectWith({ host: 'demo.example', port: 443 }, (_, callback) => callback(new Error('x'), null));
 * ```
 */
export async function probeDirectWith(
  options: DirectProbeOptions,
  connect: buildConnector.connector,
): Promise<DirectProbe> {
  const { host, port } = options;
  if (!isProbeTarget(host, port)) {
    throw new TypeError('The target must be checked.');
  }
  const failed = (error: unknown): DirectProbe => {
    const code = codeOf(error) ?? '';
    return Object.freeze({
      connected: false,
      reason: dnsCodes.includes(code)
        ? 'dns'
        : timeoutCodes.includes(code)
          ? 'timeout'
          : 'no_connection',
    });
  };
  return new Promise((resolve) => {
    try {
      connect(
        { hostname: host, protocol: 'http:', port: String(port) },
        (error, socket) => {
          if (error === null) {
            // Destroyed right away and without a reason, so it emits no
            // error and sends nothing.
            socket.destroy();
            resolve(Object.freeze({ connected: true }));
          } else {
            resolve(failed(error));
          }
        },
      );
    } catch (error) {
      resolve(failed(error));
    }
  });
}
