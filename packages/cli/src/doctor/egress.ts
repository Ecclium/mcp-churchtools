/**
 * The part of `ecclium doctor` for the outbound path (ADR 0035). It asks
 * the proxy for a tunnel to each target of the configuration, makes a TLS
 * handshake inside it and closes it without a request, then asks for a
 * tunnel to a name outside every list, which must end with 403. Last it
 * tries a TCP connection straight to ChurchTools, which must fail where the
 * proxy is the only way out.
 *
 * What it cannot show: the template of Squid refuses a private address
 * already at the rule for names outside the list, so a tunnel to one would
 * prove the same rule again. The block of private ranges itself needs a
 * name of the list that resolves to a private address, which `doctor` can
 * offer only with a host of its own; the run of the template in Docker
 * shows it.
 *
 * Why it stops at a proxy it does not reach: every further tunnel would
 * fail the same way and say nothing new. A proxy that takes the connection
 * but gives no answer in time may only wait for one target, since Squid
 * waits longer for a target than the check for its answer, so the check
 * goes on with the others.
 *
 * @packageDocumentation
 */
import type { EccliumConfig } from '@ecclium/mcp-churchtools-core';
import {
  type DirectProbe,
  type DirectProbeOptions,
  type EgressTargetProbe,
  type EgressTargetProbeOptions,
  probeDirect,
  probeEgressTarget,
} from '@ecclium/mcp-churchtools-core/http';

import { type EgressTarget, egressTargetsOf } from '../egress/acl.js';

/** The checks of the outbound path, replaced in tests. */
export interface EgressProbes {
  /** A tunnel through the proxy, with TLS inside it or without. */
  readonly target: (
    options: EgressTargetProbeOptions,
  ) => Promise<EgressTargetProbe>;
  /** A TCP connection straight to a target. */
  readonly direct: (options: DirectProbeOptions) => Promise<DirectProbe>;
}

/** The checks of the core. */
export const egressProbes: EgressProbes = Object.freeze({
  target: (options: EgressTargetProbeOptions) => probeEgressTarget(options),
  direct: (options: DirectProbeOptions) => probeDirect(options),
});

/**
 * The name outside every list the check of the refusal asks for. The top
 * level `.invalid` never resolves (RFC 2606), so even a proxy that let it
 * through would reach no host.
 */
export const outsideTarget = Object.freeze({
  host: 'ecclium-doctor.invalid',
  port: 443,
});

/** A target of the list with what its check found. */
export interface CheckedTarget {
  readonly target: EgressTarget;
  /** What the check found, or undefined when it did not run. */
  readonly probe: EgressTargetProbe | undefined;
}

/** What the check of the outbound path found. */
export type EgressCheck =
  /** `ECCLIUM_EGRESS=off`: no proxy, nothing checked. */
  | { readonly kind: 'off' }
  /**
   * A target with a port other than 443 outside the local network, which
   * the template never lets through: nothing checked.
   */
  | { readonly kind: 'ports'; readonly roles: readonly string[] }
  | {
      readonly kind: 'checked';
      /** Each target of the list, in the order of `ecclium init egress`. */
      readonly targets: readonly CheckedTarget[];
      /** The tunnel to the name outside the list, if it ran. */
      readonly outside: EgressTargetProbe | undefined;
      /** The direct connection to ChurchTools. */
      readonly direct: DirectProbe;
    };

// Whether a check says nothing about the target because the proxy itself
// was not reached.
const proxyUnreachable = (probe: EgressTargetProbe): boolean =>
  !probe.ok && probe.reason === 'unreachable';

/**
 * Checks the outbound path of the configuration of the runner.
 *
 * @param config - The configuration of the runner, as the loader checked
 *   it.
 * @param probes - The checks, replaced in tests.
 * @returns What the checks found.
 * @throws {TypeError} When an origin of the configuration is not one the
 *   configuration could have checked.
 * @example
 * ```ts
 * const found = await checkEgress(config, egressProbes);
 * ```
 */
export async function checkEgress(
  config: Pick<
    EccliumConfig,
    | 'churchtoolsOrigin'
    | 'providers'
    | 'runnerPingOrigin'
    | 'egressAllowLan'
    | 'egressProxy'
    | 'egressOff'
  >,
  probes: EgressProbes,
): Promise<EgressCheck> {
  const proxy = config.egressProxy;
  if (config.egressOff || proxy === undefined) {
    return Object.freeze({ kind: 'off' });
  }
  const found = egressTargetsOf(config);
  if (!found.ok) return Object.freeze({ kind: 'ports', roles: found.roles });
  const targets: CheckedTarget[] = [];
  let stopped = false;
  for (const target of found.targets) {
    if (stopped) {
      targets.push(Object.freeze({ target, probe: undefined }));
      continue;
    }
    const probe = await probes.target({
      proxy,
      host: target.host,
      port: Number(target.port),
      tls: true,
    });
    targets.push(Object.freeze({ target, probe }));
    stopped = proxyUnreachable(probe);
  }
  const outside = stopped
    ? undefined
    : await probes.target({ proxy, ...outsideTarget, tls: false });
  // ChurchTools is always the first target of the list.
  const churchtools = found.targets[0];
  if (churchtools === undefined) {
    throw new TypeError('The list of the targets names no ChurchTools.');
  }
  const direct = await probes.direct({
    host: churchtools.host,
    port: Number(churchtools.port),
  });
  return Object.freeze({
    kind: 'checked',
    targets: Object.freeze(targets),
    outside,
    direct,
  });
}
