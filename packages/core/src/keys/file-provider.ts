/**
 * The provider of keys of the free core (ADR 0069). It holds the secret
 * from the key file of the operator and, while the operator changes it,
 * the previous one, and derives from them with HKDF the key of one
 * tenant, one ChurchTools instance, one actor and one UTC day. Nothing derived is kept: each call
 * derives anew, so the provider holds no state beyond the secrets it was
 * given at the start (ADR 0051).
 *
 * @packageDocumentation
 */
import { hkdfSync } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  dataKeyLength,
  isIsoDate,
  type IsoDate,
  type KeyProvider,
  type KeyPurpose,
  keyPurposes,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import { actorKinds, isActorId } from '../audit/schema.js';
import { parseChurchToolsOrigin } from '../http/index.js';
import { isTenantId } from '../logger/index.js';
import { KeyMaterial, revealKeyMaterial } from './key-material.js';

/** The secrets a provider derives from. */
export interface FileKeys {
  /** The current secret, from `ECCLIUM_PSEUDONYM_KEY_FILE`. */
  readonly current: KeyMaterial;
  /**
   * The previous secret while the operator changes it, from
   * `ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE`.
   */
  readonly previous?: KeyMaterial | undefined;
}

// The first part of every info: the version of the derivation. The
// purpose follows as a part of its own, so that keys for two purposes
// never meet.
const label = 'ecclium/key/v1';

const encoder = new TextEncoder();

// The parts of the info, each after its length in two bytes, big-endian,
// so that no two different lists of parts give the same info. The
// instance is a part of its own because over stdio every tenant is
// `default`: two servers for two instances with the same key file and
// subject would otherwise share keys, and a pseudonym of one would open in
// the other as another person.
const infoOf = (parts: readonly string[]): Uint8Array => {
  const encoded = parts.map((part) => encoder.encode(part));
  const info = new Uint8Array(
    encoded.reduce((sum, part) => sum + 2 + part.length, 0),
  );
  let offset = 0;
  for (const part of encoded) {
    info[offset] = part.length >> 8;
    info[offset + 1] = part.length & 0xff;
    info.set(part, offset + 2);
    offset += 2 + part.length;
  }
  return info;
};

// An own data property of a plain object, never through a getter or a
// proxy, which could give another value on every read.
const ownData = (target: unknown, key: string): unknown => {
  if (typeof target !== 'object' || target === null || isProxy(target)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

const derive = (secret: KeyMaterial, info: Uint8Array): Uint8Array => {
  const ikm = revealKeyMaterial(secret);
  try {
    // An empty salt is the salt of zeros RFC 5869 names for HKDF without
    // one; the parts that set the key apart stand in the info.
    return new Uint8Array(
      hkdfSync('sha256', ikm, new Uint8Array(), info, dataKeyLength),
    );
  } finally {
    ikm.fill(0);
  }
};

/**
 * Makes the provider of keys from the key files. For the purpose
 * `pseudonym` it derives each key with HKDF and SHA-256 from the secret,
 * over the tenant, the origin of the instance, the kind and the ID of the
 * actor and the UTC day of the call, taken from the context, never from a
 * tool. The actor is the
 * principal of the call: over stdio `stdio:<subject>`, never the service
 * account, so two persons never see the same pseudonym. With a previous
 * secret it gives its key second.
 *
 * @param keys - The current secret and, while it changes, the previous one.
 * @returns The provider, frozen. It keeps no state but the secrets.
 * @throws {TypeError} When a secret is no KeyMaterial, or both hold the
 *   same bytes.
 * @example
 * ```ts
 * const keys = createFileKeyProvider({ current: new KeyMaterial(hexFromTheKeyFile) });
 * const [today] = await keys.dataKeys(ctx, 'pseudonym', '2026-10-31' as IsoDate);
 * ```
 */
export function createFileKeyProvider(keys: FileKeys): KeyProvider {
  const current = ownData(keys, 'current');
  const previous = ownData(keys, 'previous');
  if (!(current instanceof KeyMaterial)) {
    throw new TypeError('The current key is no key.');
  }
  if (previous !== undefined && !(previous instanceof KeyMaterial)) {
    throw new TypeError('The previous key is no key.');
  }
  if (previous?.sameAs(current) === true) {
    throw new TypeError('The previous key is the current one.');
  }
  const secrets: readonly KeyMaterial[] =
    previous === undefined ? [current] : [current, previous];

  const keysFor = (
    ctx: TenantContext,
    purpose: KeyPurpose,
    day: IsoDate,
  ): readonly Uint8Array[] => {
    const tenantId = ownData(ctx, 'tenantId');
    const instance = ownData(ctx, 'instance');
    const actor = ownData(ctx, 'actor');
    const kind = ownData(actor, 'kind');
    const id = ownData(actor, 'id');
    if (!isTenantId(tenantId)) throw new TypeError('The tenant is invalid.');
    const origin =
      typeof instance === 'string'
        ? parseChurchToolsOrigin(instance)
        : undefined;
    if (origin?.ok !== true || origin.origin !== instance) {
      throw new TypeError('The instance is invalid.');
    }
    if (!(actorKinds as readonly unknown[]).includes(kind) || !isActorId(id)) {
      throw new TypeError('The actor is invalid.');
    }
    if (!(keyPurposes as readonly unknown[]).includes(purpose)) {
      throw new TypeError('The purpose is unknown.');
    }
    if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
    const info = infoOf([
      label,
      purpose,
      tenantId,
      instance,
      String(kind),
      id,
      day,
    ]);
    return Object.freeze(secrets.map((secret) => derive(secret, info)));
  };

  return Object.freeze({
    __proto__: null,
    // Every refusal is a rejected promise, as for a provider that derives
    // elsewhere: what the executor throws rejects the promise.
    dataKeys: (
      ctx: TenantContext,
      purpose: KeyPurpose,
      day: IsoDate,
    ): Promise<readonly Uint8Array[]> =>
      new Promise((resolve) => {
        resolve(keysFor(ctx, purpose, day));
      }),
  });
}
