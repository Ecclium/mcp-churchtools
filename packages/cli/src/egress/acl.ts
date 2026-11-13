/**
 * The list of targets of the proxy for `ecclium init egress` (ADR 0035):
 * which origins the configuration reaches, and the lines `acl` for the
 * template of Squid in `deploy/selfhost/egress/squid.conf`. The template
 * holds every rule `http_access`; this list only adds pairs of a name and
 * a port to the two lists `ecclium_public` and `ecclium_lan` it declares,
 * and ends with a line that marks it complete. So a fault here cannot add
 * a rule; what the list decides is which targets it names.
 *
 * Why pairs: each target is one exact name (`dstdomain -n`, no subdomain
 * and no reverse lookup of an IP address) together with its port
 * (`all-of`), so a target in the local network opens its own port only.
 * The names of a pair come from a hash of its name and port, so that two
 * lists written into one file never pair the name of one target with the
 * port of another. Why the last line: a list cut short, such as on a full
 * disk, could end in the middle of a pair; without the mark the template
 * lets nothing through.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import type { EccliumConfig } from '@ecclium/mcp-churchtools-core';

/** One target of the proxy: an origin of the configuration. */
export interface EgressTarget {
  /** The name, in lower case with a dot, never an IP address. */
  readonly host: string;
  /** The port, always written out. */
  readonly port: string;
  /** Whether `ECCLIUM_EGRESS_ALLOW_LAN` names it. */
  readonly lan: boolean;
  /** What reaches it, such as ChurchTools or a provider, in German. */
  readonly roles: readonly string[];
}

/** The targets, or the roles of targets the template can never pass. */
export type EgressTargetsResult =
  | { readonly ok: true; readonly targets: readonly EgressTarget[] }
  | {
      readonly ok: false;
      /**
       * The roles of the targets with a port other than 443 outside the
       * local network, which the template refuses.
       */
      readonly roles: readonly string[];
    };

// A name as the configuration takes one: lower case, labels of letters,
// digits and hyphens, with a dot, and a last label that is no number, so
// never an IPv4 address. Checked again here, so that nothing but such a
// name reaches a line.
const namePattern =
  /^(?=.{1,253}$)(?!.*\.[0-9]+$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const portPattern = /^[1-9][0-9]{0,4}$/;

/** The only port the template lets through outside the local network. */
export const publicPort = '443';

const quote = (text: string): string => `‹${text}›`;

// The origin of a canonical https address: scheme, name and an optional
// port, without the path. The configuration checked the address.
const originOf = (address: string): string => {
  const slash = address.indexOf('/', 'https://'.length);
  return slash === -1 ? address : address.slice(0, slash);
};

// Splits a canonical https origin into name and port, the port written
// out; undefined for anything else.
const split = (
  origin: string,
): { readonly host: string; readonly port: string } | undefined => {
  if (!origin.startsWith('https://')) return undefined;
  const [host = '', port = publicPort, ...rest] = origin
    .slice('https://'.length)
    .split(':');
  if (rest.length > 0 || !namePattern.test(host)) return undefined;
  if (!portPattern.test(port) || Number(port) > 65535) return undefined;
  return { host, port };
};

/**
 * Collects the targets of the configuration: ChurchTools, each provider of
 * the file of the providers and the ping of the runner, in this order,
 * each origin once with all its roles.
 *
 * @param config - The configuration of the runner.
 * @returns The targets, or the roles of the targets with a port other
 *   than 443 that `ECCLIUM_EGRESS_ALLOW_LAN` does not name: the template
 *   would refuse them, so the list would only look complete.
 * @throws {TypeError} When an origin of the configuration is not one it
 *   could have checked.
 * @example
 * ```ts
 * const found = egressTargetsOf(config);
 * if (found.ok) renderEgressAcl(found.targets);
 * ```
 */
export function egressTargetsOf(
  config: Pick<
    EccliumConfig,
    'churchtoolsOrigin' | 'providers' | 'runnerPingOrigin' | 'egressAllowLan'
  >,
): EgressTargetsResult {
  const found: { origin: string; roles: string[] }[] = [];
  const add = (origin: string, role: string): void => {
    const known = found.find((entry) => entry.origin === origin);
    if (known === undefined) found.push({ origin, roles: [role] });
    else known.roles.push(role);
  };
  add(config.churchtoolsOrigin, 'ChurchTools');
  for (const provider of config.providers ?? []) {
    add(originOf(provider.endpoint), `Anbieter ${quote(provider.alias)}`);
  }
  if (config.runnerPingOrigin !== undefined) {
    add(config.runnerPingOrigin, 'Ping des Runners');
  }
  const targets: EgressTarget[] = [];
  const refused: string[] = [];
  for (const { origin, roles } of found) {
    const parts = split(origin);
    if (parts === undefined) {
      throw new TypeError('An origin of the configuration is unexpected.');
    }
    const lan = config.egressAllowLan.includes(origin);
    if (!lan && parts.port !== publicPort) refused.push(...roles);
    targets.push(Object.freeze({ ...parts, lan, roles: Object.freeze(roles) }));
  }
  if (refused.length > 0) {
    return Object.freeze({ ok: false, roles: Object.freeze(refused) });
  }
  return Object.freeze({ ok: true, targets: Object.freeze(targets) });
}

/** The first line of the list, so that nobody edits it by hand. */
export const aclHeader =
  '# Ziele von Ecclium für die Vorlage squid.conf, erzeugt mit ‹ecclium init egress›. Nicht von Hand ändern: Erzeugen Sie die Liste nach jeder Änderung der Konfiguration neu.';

/**
 * The last line of the list. The template lets nothing through unless the
 * list ends with it, so a list cut short fails closed.
 */
export const aclCompleteLine = 'acl ecclium_complete all-of ecclium_connect';

/**
 * The forms a line of the list may have, and nothing else: a comment, a
 * name, a port, a pair added to one of the two lists of the template, or
 * the mark of a complete list.
 */
export const aclLinePatterns: readonly RegExp[] = Object.freeze([
  /^# [^\p{Cc}\p{Zl}\p{Zp}]+$/u,
  /^acl ecclium_host_([0-9a-f]{16}) dstdomain -n [a-z0-9.-]+$/,
  /^acl ecclium_port_([0-9a-f]{16}) port [1-9][0-9]{0,4}$/,
  /^acl ecclium_(public|lan) all-of ecclium_host_([0-9a-f]{16}) ecclium_port_\2$/,
  /^acl ecclium_complete all-of ecclium_connect$/,
]);

// The suffix of the names of a pair: 64 bits of SHA-256 over name and
// port. Two targets with the same suffix stop the list.
const suffixOf = (host: string, port: string): string =>
  createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0, 16);

/**
 * Renders the lines `acl` for the targets: per target its name, its port
 * and the pair in `ecclium_lan` or `ecclium_public`, after a comment with
 * its roles, and {@link aclCompleteLine} at the end. Every line is checked
 * against {@link aclLinePatterns} before any is given back.
 *
 * @param targets - The targets of {@link egressTargetsOf}.
 * @returns The lines, without line breaks.
 * @throws {TypeError} When a line would not fit its form; then no line is
 *   given back.
 * @example
 * ```ts
 * renderEgressAcl([{ host: 'example.church.tools', port: '443', lan: false, roles: ['ChurchTools'] }]);
 * // ['# Ziele …', '# ChurchTools',
 * //  'acl ecclium_host_<hash> dstdomain -n example.church.tools',
 * //  'acl ecclium_port_<hash> port 443',
 * //  'acl ecclium_public all-of ecclium_host_<hash> ecclium_port_<hash>',
 * //  'acl ecclium_complete all-of ecclium_connect']
 * ```
 */
export function renderEgressAcl(
  targets: readonly EgressTarget[],
): readonly string[] {
  const lines = [aclHeader];
  const suffixes = new Set<string>();
  for (const target of targets) {
    if (
      !namePattern.test(target.host) ||
      !portPattern.test(target.port) ||
      Number(target.port) > 65535 ||
      (!target.lan && target.port !== publicPort)
    ) {
      throw new TypeError('A target of the list is unexpected.');
    }
    const suffix = suffixOf(target.host, target.port);
    if (suffixes.has(suffix)) {
      throw new TypeError('Two targets of the list share their names.');
    }
    suffixes.add(suffix);
    const list = target.lan ? 'ecclium_lan' : 'ecclium_public';
    lines.push(
      `# ${target.roles.join(', ')}${target.lan ? ', lokales Netz' : ''}`,
      `acl ecclium_host_${suffix} dstdomain -n ${target.host}`,
      `acl ecclium_port_${suffix} port ${target.port}`,
      `acl ${list} all-of ecclium_host_${suffix} ecclium_port_${suffix}`,
    );
  }
  lines.push(aclCompleteLine);
  for (const line of lines) {
    if (!aclLinePatterns.some((pattern) => pattern.test(line))) {
      throw new TypeError('A line of the list does not fit its form.');
    }
  }
  return Object.freeze(lines);
}
