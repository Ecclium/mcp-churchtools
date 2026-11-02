/**
 * The provider of keys of the free core (ADR 0069, ADR 0031). For the
 * pseudonyms it holds the secret from the key file of the operator and,
 * while the operator changes it, the previous one, and derives from them
 * with HKDF the key of one tenant, one ChurchTools instance, one actor and
 * one UTC day. Nothing derived is kept: each call derives anew, so the
 * provider holds no state beyond the secrets it was given at the start
 * (ADR 0051). For snapshots and the queue it hands every call on to the
 * day keys in the folder of keys (day-keys.ts), which hold no key in
 * memory either.
 *
 * @packageDocumentation
 */
import { hkdfSync } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  dataKeyLength,
  type DayKeyPurpose,
  isIsoDate,
  type IsoDate,
  type KeyProvider,
  type KeyPurpose,
  keyPurposes,
  type TenantContext,
  type WrappedKey,
} from '@ecclium/mcp-churchtools-plugin-api';

import { actorKinds, isActorId } from '../audit/schema.js';
import { parseChurchToolsOrigin } from '../http/index.js';
import { isTenantId } from '../logger/index.js';
import type { DayKeys } from './day-keys.js';
import { infoOf } from './info.js';
import { KeyMaterial, revealKeyMaterial } from './key-material.js';

/**
 * What a provider is built from: the secrets of the pseudonyms, the day
 * keys, or both. Without the secrets, `dataKeys` rejects; without the day
 * keys, `wrap`, `unwrap` and `destroyBefore` reject.
 */
export interface FileKeys {
  /**
   * The current secret, from `ECCLIUM_PSEUDONYM_KEY_FILE`, for the level
   * `strict`.
   */
  readonly current?: KeyMaterial | undefined;
  /**
   * The previous secret while the operator changes it, from
   * `ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE`.
   */
  readonly previous?: KeyMaterial | undefined;
  /**
   * The day keys in the folder of `ECCLIUM_KEYS_DIR`, for writing
   * (ADR 0031).
   */
  readonly dayKeys?: DayKeys | undefined;
}

// The first part of every info: the version of the derivation. The
// purpose follows as a part of its own, so that keys for two purposes
// never meet.
const label = 'ecclium/key/v1';

// The instance is a part of the info of its own because over stdio every
// tenant is `default`: two servers for two instances with the same key
// file and subject would otherwise share keys, and a pseudonym of one would
// open in the other as another person. Every part goes in after its length
// (info.ts), so that no two different lists of parts give the same info.

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

// The three methods of the day keys, taken once as own data properties,
// so that a later change of the object reaches nothing here.
const checkDayKeys = (dayKeys: unknown): DayKeys => {
  const wrap = ownData(dayKeys, 'wrap');
  const unwrap = ownData(dayKeys, 'unwrap');
  const destroyBefore = ownData(dayKeys, 'destroyBefore');
  if (
    typeof wrap !== 'function' ||
    typeof unwrap !== 'function' ||
    typeof destroyBefore !== 'function'
  ) {
    throw new TypeError('The day keys are no day keys.');
  }
  return Object.freeze({
    wrap: wrap as DayKeys['wrap'],
    unwrap: unwrap as DayKeys['unwrap'],
    destroyBefore: destroyBefore as DayKeys['destroyBefore'],
  });
};

const noDayKeys = (): Promise<never> =>
  Promise.reject(new TypeError('This provider has no day keys.'));

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
 * Day keys it takes as they come, from {@link createFileDayKeys} in the
 * free core.
 *
 * @param keys - The current secret and, while it changes, the previous
 *   one, and the day keys, at least one of the secret and the day keys.
 * @returns The provider, frozen. It keeps no state but the secrets.
 * @throws {TypeError} When a secret is no KeyMaterial, both hold the same
 *   bytes, a previous secret comes without a current one, the day keys
 *   lack a method, or neither a secret nor day keys are given.
 * @example
 * ```ts
 * const keys = createFileKeyProvider({ current: new KeyMaterial(hexFromTheKeyFile) });
 * const [today] = await keys.dataKeys(ctx, 'pseudonym', '2026-10-31' as IsoDate);
 * ```
 */
export function createFileKeyProvider(keys: FileKeys): KeyProvider {
  const current = ownData(keys, 'current');
  const previous = ownData(keys, 'previous');
  const dayKeys = ownData(keys, 'dayKeys');
  if (current !== undefined && !(current instanceof KeyMaterial)) {
    throw new TypeError('The current key is no key.');
  }
  if (previous !== undefined && !(previous instanceof KeyMaterial)) {
    throw new TypeError('The previous key is no key.');
  }
  if (previous !== undefined && current === undefined) {
    throw new TypeError('A previous key needs a current one.');
  }
  if (current !== undefined && previous?.sameAs(current) === true) {
    throw new TypeError('The previous key is the current one.');
  }
  const days = dayKeys === undefined ? undefined : checkDayKeys(dayKeys);
  if (current === undefined && days === undefined) {
    throw new TypeError('A provider of keys needs a secret or day keys.');
  }
  const secrets: readonly KeyMaterial[] =
    current === undefined
      ? []
      : previous === undefined
        ? [current]
        : [current, previous];

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
    if (secrets.length === 0) {
      throw new TypeError('This provider has no secret for pseudonyms.');
    }
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
    wrap: (
      ctx: TenantContext,
      purpose: DayKeyPurpose,
      day: IsoDate,
      key: Uint8Array,
    ): Promise<WrappedKey> =>
      days === undefined ? noDayKeys() : days.wrap(ctx, purpose, day, key),
    unwrap: (
      ctx: TenantContext,
      purpose: DayKeyPurpose,
      wrapped: WrappedKey,
    ): Promise<Uint8Array | undefined> =>
      days === undefined ? noDayKeys() : days.unwrap(ctx, purpose, wrapped),
    destroyBefore: (purpose: DayKeyPurpose, day: IsoDate): Promise<number> =>
      days === undefined ? noDayKeys() : days.destroyBefore(purpose, day),
  });
}
