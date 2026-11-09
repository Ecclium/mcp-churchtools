import type {
  IsoDate,
  QuotaKey,
  QuotaStore,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import {
  createMemoryQuotaStore,
  type QuotaMemory,
  quotaStoreChecks,
} from './index.js';

describe('the store of quotas in memory', () => {
  it.each(quotaStoreChecks)('$name', async ({ run }) => {
    const memory: QuotaMemory = new Map();
    await run(() => createMemoryQuotaStore(memory));
  });

  it('is frozen, and so are the checks', () => {
    const store = createMemoryQuotaStore();
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(quotaStoreChecks)).toBe(true);
  });
});

// A store that counts wrong must fail the checks, or they show nothing.
describe('the checks of a store of quotas', () => {
  it('fail for a store that forgets everything', async () => {
    const failures = await Promise.all(
      quotaStoreChecks.map(({ run }) =>
        run(() => createMemoryQuotaStore()).then(
          () => false,
          () => true,
        ),
      ),
    );
    expect(failures).toContain(true);
  });

  // Counters of decisions the way the other counters are kept: per actor,
  // and dropped once a later day counts, as a store of one file per day
  // without a file of decisions would.
  const perActor = (): QuotaStore => {
    const memory = new Map<string, number>();
    let latest = '';
    const keyOf = (ctx: TenantContext, key: QuotaKey, day: IsoDate): string =>
      JSON.stringify([ctx.tenantId, ctx.actor.kind, ctx.actor.id, key, day]);
    return {
      increment: (ctx, key, day) => {
        if (day > latest) {
          latest = day;
          for (const entry of [...memory.keys()]) {
            if (!entry.endsWith(`"${day}"]`)) memory.delete(entry);
          }
        }
        const value = (memory.get(keyOf(ctx, key, day)) ?? 0) + 1;
        memory.set(keyOf(ctx, key, day), value);
        return Promise.resolve(value);
      },
      read: (ctx, key, day) =>
        Promise.resolve(memory.get(keyOf(ctx, key, day)) ?? 0),
    };
  };

  it.each([
    'counts a decision for the tenant, whichever actor counts',
    'keeps a decision while later days count',
  ])(
    'fail for a store that keeps decisions like the other counters: %s',
    async (name) => {
      const check = quotaStoreChecks.find((item) => item.name === name);
      const store = perActor();
      await expect(check?.run(() => store)).rejects.toThrow();
      const memory: QuotaMemory = new Map();
      await expect(
        check?.run(() => createMemoryQuotaStore(memory)),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    'counts a run for the tenant, whichever actor counts, under the day of its trigger',
    'keeps a run while later days count',
  ])(
    'fail for a store that keeps runs like the other counters: %s',
    async (name) => {
      const check = quotaStoreChecks.find((item) => item.name === name);
      const store = perActor();
      await expect(check?.run(() => store)).rejects.toThrow();
      const memory: QuotaMemory = new Map();
      await expect(
        check?.run(() => createMemoryQuotaStore(memory)),
      ).resolves.toBeUndefined();
    },
  );

  it('fail for a store that counts a run under any day', async () => {
    const check = quotaStoreChecks.find(({ name }) =>
      name.startsWith('counts a run for the tenant'),
    );
    // Per tenant, as it should, but without a look at the day of the
    // trigger.
    const memory = new Map<string, number>();
    const keyOf = (ctx: TenantContext, key: QuotaKey, day: IsoDate): string =>
      JSON.stringify([ctx.tenantId, key, day]);
    const anyDay: QuotaStore = {
      increment: (ctx, key, day) => {
        const value = (memory.get(keyOf(ctx, key, day)) ?? 0) + 1;
        memory.set(keyOf(ctx, key, day), value);
        return Promise.resolve(value);
      },
      read: (ctx, key, day) =>
        Promise.resolve(memory.get(keyOf(ctx, key, day)) ?? 0),
    };
    await expect(check?.run(() => anyDay)).rejects.toThrow();
  });

  it('fail for a store that takes any key of a run', async () => {
    const check = quotaStoreChecks.find(({ name }) =>
      name.includes('run of another form'),
    );
    const lax = {
      increment: () => Promise.resolve(1),
      read: () => Promise.resolve(0),
    };
    await expect(check?.run(() => lax)).rejects.toThrow();
  });

  it.each([
    'gives 1 to one decision only when two stores count at the same time',
    'gives each count of a run once when two stores count at the same time',
  ])('fail for a store that counts apart from another: %s', async (name) => {
    const check = quotaStoreChecks.find((item) => item.name === name);
    expect(check).toBeDefined();
    // Each store keeps its own count, as two processes without a shared
    // file would.
    await expect(check?.run(() => createMemoryQuotaStore())).rejects.toThrow();
  });

  it('fail for a store that takes any key of a decision', async () => {
    const check = quotaStoreChecks.find(({ name }) =>
      name.includes('decision of another form'),
    );
    const lax = {
      increment: () => Promise.resolve(1),
      read: () => Promise.resolve(0),
    };
    await expect(check?.run(() => lax)).rejects.toThrow();
  });

  it('fail for a store that takes any day', async () => {
    const check = quotaStoreChecks.find(({ name }) =>
      name.includes('day that is no day'),
    );
    const loose = createMemoryQuotaStore();
    const lax = {
      increment: () => Promise.resolve(1),
      read: () => Promise.resolve(0),
    };
    await expect(check?.run(() => lax)).rejects.toThrow();
    await expect(check?.run(() => loose)).resolves.toBeUndefined();
  });
});
