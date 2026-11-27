/**
 * The tenant of a sign-in with a static bearer token over HTTP (ADR 0074).
 * The sign-in names the name of the token as its subject; this resolver is
 * the one place that derives tenant and actor from such an identity.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import type {
  Identity,
  TenantAssignment,
  TenantResolver,
} from '@ecclium/mcp-churchtools-plugin-api';

import { isBearerTokenName } from '../bearer/token.js';
import { defaultTenantId, toTenantId } from '../tenant/tenant-id.js';

// An own data property of a plain object, never through a getter or a
// proxy, which could give another value on every read.
const ownData = (object: unknown, key: string): unknown => {
  if (typeof object !== 'object' || object === null || isProxy(object)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && 'value' in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

// The assignment for an identity of a bearer token, or undefined. It reads
// only own data of an object that is no proxy, so it runs no code of the
// caller and never throws.
const assign = (identity: unknown): TenantAssignment | undefined => {
  if (ownData(identity, 'source') !== 'bearer') return undefined;
  const subject = ownData(identity, 'subject');
  const tenantId = toTenantId(defaultTenantId);
  if (!isBearerTokenName(subject) || tenantId === undefined) return undefined;
  return Object.freeze({
    __proto__: null,
    tenantId,
    actor: Object.freeze({
      __proto__: null,
      kind: 'user',
      id: `bearer:${subject}`,
    }),
  });
};

/**
 * Makes the resolver for the static bearer tokens. It gives every identity
 * of a bearer token the tenant `default`, the one tenant of the free core,
 * and the actor `bearer:<name>` of kind `user`: a person calls through an
 * assistant that holds the token, and the name of the token stays neutral
 * because the person is not known. Source and subject make the actor, so
 * a token and a subject of another source with the same text never give
 * the same actor (ADR 0074). The tenant never comes from the identity,
 * and its scopes play no part. Any other identity gets no tenant, so that
 * the pipeline ends its call with `auth`.
 *
 * @returns The resolver, frozen. It keeps no state.
 * @example
 * ```ts
 * const assignment = await createBearerTenantResolver().resolve(identity);
 * // { tenantId: 'default', actor: { kind: 'user', id: 'bearer:claude-code-office' } }
 * ```
 */
export function createBearerTenantResolver(): TenantResolver {
  return Object.freeze({
    __proto__: null,
    resolve: (identity: Identity) => Promise.resolve(assign(identity)),
  });
}
