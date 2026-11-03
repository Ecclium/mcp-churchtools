/**
 * Checks every provider of day keys must pass (ADR 0031): the files of the
 * free core as well as a later replacement, and day keys in memory for the
 * tests of snapshots and the pipeline. A provider wraps a key with the day
 * key of a tenant, purpose and day, opens it again only for the same three,
 * and after `destroyBefore` gives nothing for the days before. The checks
 * use `node:assert`, so that a test runner of any kind can run them.
 *
 * @packageDocumentation
 */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  dataKeyLength,
  type DayKeyPurpose,
  dayKeyPurposes,
  type IsoDate,
  isIsoDate,
  type KeyProvider,
  type TenantContext,
  type WrappedKey,
} from '@ecclium/mcp-churchtools-plugin-api';

import { quotaContext } from '../quota/index.js';

/** The part of a provider of keys that serves day keys. */
export type DayKeyProvider = Pick<
  KeyProvider,
  'wrap' | 'unwrap' | 'destroyBefore'
>;

/** The day keys of {@link createMemoryDayKeys}, to share between providers. */
export type DayKeyMemory = Map<string, Uint8Array>;

const keyOf = (tenant: string, purpose: DayKeyPurpose, day: IsoDate) =>
  JSON.stringify([tenant, purpose, day]);

const aadOf = (tenant: string, purpose: DayKeyPurpose, day: IsoDate) =>
  Buffer.from(JSON.stringify(['testkit/day-key', tenant, purpose, day]));

/**
 * Day keys in memory, only for tests. Two providers over the same memory
 * stand for one provider before and after a restart.
 *
 * @param memory - The day keys, new by default.
 * @returns The provider of day keys, frozen.
 * @example
 * ```ts
 * const dayKeys = createMemoryDayKeys();
 * const wrapped = await dayKeys.wrap(ctx, 'snapshot', day, key);
 * ```
 */
export function createMemoryDayKeys(
  memory: DayKeyMemory = new Map(),
): DayKeyProvider {
  const check = (purpose: unknown, day: unknown): void => {
    if (!(dayKeyPurposes as readonly unknown[]).includes(purpose)) {
      throw new TypeError('The purpose is no purpose of a day key.');
    }
    if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
  };
  return Object.freeze({
    wrap: (
      ctx: TenantContext,
      purpose: DayKeyPurpose,
      day: IsoDate,
      key: Uint8Array,
    ): Promise<WrappedKey> =>
      Promise.resolve().then(() => {
        check(purpose, day);
        if (!(key instanceof Uint8Array) || key.length !== dataKeyLength) {
          throw new TypeError('The key to wrap must have 32 bytes.');
        }
        const name = keyOf(ctx.tenantId, purpose, day);
        const kek = memory.get(name) ?? new Uint8Array(randomBytes(32));
        memory.set(name, kek);
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', kek, nonce);
        cipher.setAAD(aadOf(ctx.tenantId, purpose, day));
        const sealed = Buffer.concat([
          nonce,
          cipher.update(key),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString('base64url');
        return Object.freeze({ purpose, day, sealed });
      }),
    unwrap: (
      ctx: TenantContext,
      purpose: DayKeyPurpose,
      wrapped: WrappedKey,
    ): Promise<Uint8Array | undefined> =>
      Promise.resolve().then(() => {
        check(purpose, wrapped.day);
        if (wrapped.purpose !== purpose) {
          throw new TypeError('The wrapped key does not fit.');
        }
        const kek = memory.get(keyOf(ctx.tenantId, purpose, wrapped.day));
        if (kek === undefined) return undefined;
        const bytes = Buffer.from(wrapped.sealed, 'base64url');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          kek,
          bytes.subarray(0, 12),
        );
        decipher.setAAD(aadOf(ctx.tenantId, purpose, wrapped.day));
        decipher.setAuthTag(bytes.subarray(bytes.length - 16));
        const opened = decipher.update(bytes.subarray(12, bytes.length - 16));
        decipher.final();
        return new Uint8Array(opened);
      }),
    destroyBefore: (purpose: DayKeyPurpose, day: IsoDate): Promise<number> =>
      Promise.resolve().then(() => {
        check(purpose, day);
        let destroyed = 0;
        for (const [name, kek] of memory) {
          const [, keyPurpose, keyDay] = JSON.parse(name) as string[];
          if (keyPurpose === purpose && (keyDay ?? '') < day) {
            kek.fill(0);
            memory.delete(name);
            destroyed += 1;
          }
        }
        return destroyed;
      }),
  });
}

/**
 * Opens a provider of day keys. Every call over the same storage stands
 * for the provider after a restart of the process.
 */
export type OpenDayKeys = () => DayKeyProvider;

/** One check of {@link dayKeyChecks}. */
export interface DayKeyCheck {
  /** What the check shows, as a sentence for the name of a test. */
  readonly name: string;
  /**
   * Runs the check against fresh storage.
   *
   * @param open - Opens a provider over storage of its own for this check.
   * @returns Nothing; it rejects with an assertion error on a failure.
   */
  readonly run: (open: OpenDayKeys) => Promise<void>;
}

const day = '2026-11-03' as IsoDate;
const before = '2026-11-02' as IsoDate;
const after = '2026-11-04' as IsoDate;
const one = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const other = quotaContext('other-tenant', 'service', 'stdio:local-stdio');

const sample = (seed: number): Uint8Array =>
  Uint8Array.from(
    { length: dataKeyLength },
    (_, index) => (seed + index) % 256,
  );

const check = (
  name: string,
  run: (open: OpenDayKeys) => Promise<void>,
): DayKeyCheck => Object.freeze({ name, run });

/**
 * The checks every provider of day keys passes, frozen. A test runs each
 * one with a function that opens a provider over storage of its own.
 *
 * @example
 * ```ts
 * it.each(dayKeyChecks)('$name', ({ run }) => run(() => openDayKeys(dir)));
 * ```
 */
export const dayKeyChecks: readonly DayKeyCheck[] = Object.freeze([
  check('opens a key it wrapped, as a copy of its own', async (open) => {
    const keys = open();
    const key = sample(1);
    const wrapped = await keys.wrap(one, 'snapshot', day, key);
    assert.equal(wrapped.purpose, 'snapshot');
    assert.equal(wrapped.day, day);
    const opened = await keys.unwrap(one, 'snapshot', wrapped);
    assert.deepEqual(opened, key);
    assert.notEqual(opened, key);
    opened.fill(0);
    assert.deepEqual(await keys.unwrap(one, 'snapshot', wrapped), key);
  }),
  check('wraps the same key twice into two different values', async (open) => {
    const keys = open();
    const first = await keys.wrap(one, 'snapshot', day, sample(2));
    const second = await keys.wrap(one, 'snapshot', day, sample(2));
    assert.notEqual(first.sealed, second.sealed);
  }),
  check('opens a key after a restart, with the same day key', async (open) => {
    const wrapped = await open().wrap(one, 'queue', day, sample(3));
    assert.deepEqual(await open().unwrap(one, 'queue', wrapped), sample(3));
  }),
  check('never opens a key for another tenant', async (open) => {
    const keys = open();
    const wrapped = await keys.wrap(one, 'snapshot', day, sample(4));
    await keys.wrap(other, 'snapshot', day, sample(5));
    await assert.rejects(keys.unwrap(other, 'snapshot', wrapped));
  }),
  check(
    'gives nothing for a tenant without a day key of that day',
    async (open) => {
      const keys = open();
      const wrapped = await keys.wrap(one, 'snapshot', day, sample(19));
      assert.equal(await keys.unwrap(other, 'snapshot', wrapped), undefined);
    },
  ),
  check('never opens a key for the other purpose', async (open) => {
    const keys = open();
    const wrapped = await keys.wrap(one, 'snapshot', day, sample(6));
    await keys.wrap(one, 'queue', day, sample(7));
    await assert.rejects(keys.unwrap(one, 'queue', wrapped));
    await assert.rejects(
      keys.unwrap(one, 'queue', { ...wrapped, purpose: 'queue' }),
    );
  }),
  check('never opens a key under another day', async (open) => {
    const keys = open();
    const wrapped = await keys.wrap(one, 'snapshot', day, sample(8));
    await keys.wrap(one, 'snapshot', after, sample(9));
    await assert.rejects(
      keys.unwrap(one, 'snapshot', { ...wrapped, day: after }),
    );
  }),
  check('refuses a wrapped key that was changed', async (open) => {
    const keys = open();
    const wrapped = await keys.wrap(one, 'snapshot', day, sample(10));
    const last = wrapped.sealed.at(-1) === 'A' ? 'B' : 'A';
    const changed = `${wrapped.sealed.slice(0, -1)}${last}`;
    await assert.rejects(
      keys.unwrap(one, 'snapshot', { ...wrapped, sealed: changed }),
    );
  }),
  check('gives nothing for a day whose key it destroyed', async (open) => {
    const keys = open();
    const old = await keys.wrap(one, 'snapshot', before, sample(11));
    const kept = await keys.wrap(one, 'snapshot', day, sample(12));
    const queued = await keys.wrap(one, 'queue', before, sample(13));
    assert.equal(await keys.destroyBefore('snapshot', day), 1);
    assert.equal(await keys.unwrap(one, 'snapshot', old), undefined);
    assert.equal(await open().unwrap(one, 'snapshot', old), undefined);
    assert.deepEqual(await keys.unwrap(one, 'snapshot', kept), sample(12));
    assert.deepEqual(await keys.unwrap(one, 'queue', queued), sample(13));
    assert.equal(await keys.destroyBefore('snapshot', day), 0);
  }),
  check(
    'destroys the day keys of every tenant before the day',
    async (open) => {
      const keys = open();
      const mine = await keys.wrap(one, 'snapshot', before, sample(14));
      const theirs = await keys.wrap(other, 'snapshot', before, sample(15));
      assert.equal(await keys.destroyBefore('snapshot', day), 2);
      assert.equal(await keys.unwrap(one, 'snapshot', mine), undefined);
      assert.equal(await keys.unwrap(other, 'snapshot', theirs), undefined);
    },
  ),
  check(
    'refuses a key of another length, a purpose of derived keys and a day that is no day',
    async (open) => {
      const keys = open();
      await assert.rejects(
        keys.wrap(one, 'snapshot', day, new Uint8Array(dataKeyLength - 1)),
      );
      await assert.rejects(
        keys.wrap(one, 'pseudonym' as DayKeyPurpose, day, sample(17)),
      );
      await assert.rejects(
        keys.wrap(one, 'snapshot', '2026-02-30' as IsoDate, sample(18)),
      );
      await assert.rejects(
        keys.destroyBefore('pseudonym' as DayKeyPurpose, day),
      );
      await assert.rejects(keys.destroyBefore('snapshot', 'today' as IsoDate));
    },
  ),
]);
