/**
 * The identity and the tenant of a start over stdio (ADR 0037, ADR 0055).
 * The configuration names a neutral subject; this module is the one place
 * that turns it into an {@link Identity}, and its resolver the one place
 * that derives tenant and actor from such an identity.
 *
 * @packageDocumentation
 */
import { types } from 'node:util';

import type {
  Identity,
  Scope,
  TenantAssignment,
  TenantResolver,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { EccliumConfig } from '../config/index.js';
import {
  reservedStdioSubjects,
  stdioSubjectPattern,
} from '../config/variables.js';
import { defaultTenantId, toTenantId } from '../tenant/tenant-id.js';

const readScopes: readonly Scope[] = Object.freeze(['read']);
const writeScopes: readonly Scope[] = Object.freeze(['read', 'write']);

// An own data property of a plain object, never through a getter or a
// proxy, which could give another value on every read.
const ownData = (object: unknown, key: string): unknown => {
  if (typeof object !== 'object' || object === null || types.isProxy(object)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && 'value' in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

// The pattern, anchored and bounded, and never the placeholder of the
// audit. Every subject that fits gives an actor that the audit accepts.
const isSubject = (value: unknown): value is string =>
  typeof value === 'string' &&
  stdioSubjectPattern.test(value) &&
  !(reservedStdioSubjects as readonly string[]).includes(value);

/**
 * Makes the identity of a start over stdio. Its scopes follow the
 * configuration: only `read`, and `write` as well only when read-only is
 * explicitly false, so the identity never claims more than the
 * configuration allows.
 *
 * @param config - The subject and the read-only flag of the configuration.
 * @returns The identity, frozen, without a prototype.
 * @throws {TypeError} When the subject breaks its pattern or is reserved,
 *   or the read-only flag is no boolean. The message never holds a value.
 * @example
 * ```ts
 * const identity = createStdioIdentity({ stdioSubject: 'local-stdio', readOnly: true });
 * // { source: 'stdio', subject: 'local-stdio', scopes: ['read'] }
 * ```
 */
export function createStdioIdentity(
  config: Pick<EccliumConfig, 'stdioSubject' | 'readOnly'>,
): Identity {
  const subject = ownData(config, 'stdioSubject');
  const readOnly = ownData(config, 'readOnly');
  if (!isSubject(subject)) {
    throw new TypeError('The stdio subject is invalid.');
  }
  if (typeof readOnly !== 'boolean') {
    throw new TypeError('The read-only flag is not a boolean.');
  }
  return Object.freeze({
    __proto__: null,
    source: 'stdio',
    subject,
    scopes: readOnly ? readScopes : writeScopes,
  });
}

// The assignment for an identity over stdio, or undefined. It reads only
// own data of an object that is no proxy, so it runs no code of the caller
// and never throws.
const assign = (identity: unknown): TenantAssignment | undefined => {
  if (ownData(identity, 'source') !== 'stdio') return undefined;
  const subject = ownData(identity, 'subject');
  const tenantId = toTenantId(defaultTenantId);
  if (!isSubject(subject) || tenantId === undefined) return undefined;
  return Object.freeze({
    __proto__: null,
    tenantId,
    actor: Object.freeze({
      __proto__: null,
      kind: 'user',
      id: `stdio:${subject}`,
    }),
  });
};

/**
 * Makes the resolver for stdio. It gives every identity over stdio the
 * tenant `default` and the actor `stdio:<subject>` of kind `user`: a person
 * calls through a local assistant, and the subject stays neutral because
 * the person is not known. Source and subject make the actor, as over HTTP,
 * so an actor over stdio and one with a bearer token never mix. The tenant
 * never comes from the identity, and its scopes play no part.
 *
 * @returns The resolver, frozen. It keeps no state.
 * @example
 * ```ts
 * const assignment = await createStdioTenantResolver().resolve(identity);
 * // { tenantId: 'default', actor: { kind: 'user', id: 'stdio:local-stdio' } }
 * ```
 */
export function createStdioTenantResolver(): TenantResolver {
  return Object.freeze({
    __proto__: null,
    resolve: (identity: Identity) => Promise.resolve(assign(identity)),
  });
}
