import type {
  IsoDate,
  SnapshotStore,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { quotaContext } from '../quota/index.js';
import {
  createMemorySnapshotStore,
  type SnapshotMemory,
  snapshotStoreChecks,
} from './index.js';

describe('the store of snapshots in memory', () => {
  it.each(snapshotStoreChecks)('$name', async ({ run }) => {
    const memory: SnapshotMemory = new Map();
    await run(() => createMemorySnapshotStore(memory));
  });

  it('is frozen, and so are the checks and the records it gives', async () => {
    const store = createMemorySnapshotStore();
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(snapshotStoreChecks)).toBe(true);
    const ctx = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
    const eventId = '00000000-0000-4000-8000-000000000001';
    await store.put(ctx, {
      eventId,
      part: 'before',
      day: '2026-11-03' as IsoDate,
      sealed: 'x',
    });
    const records = await store.get(ctx, eventId);
    expect(Object.isFrozen(records)).toBe(true);
    expect(records.every((record) => Object.isFrozen(record))).toBe(true);
  });
});

// A store that breaks a promise must fail the checks, or they show
// nothing.
describe('the checks of stores of snapshots', () => {
  const failures = async (open: () => SnapshotStore): Promise<string[]> => {
    const failed: string[] = [];
    for (const { name, run } of snapshotStoreChecks) {
      await run(open).catch(() => failed.push(name));
    }
    return failed;
  };

  it('fail for a store that a restart empties', async () => {
    expect(await failures(() => createMemorySnapshotStore())).toContain(
      'keeps its records over a restart',
    );
  });

  it('fail for a store that never removes a record', async () => {
    const memory: SnapshotMemory = new Map();
    const open = (): SnapshotStore => ({
      ...createMemorySnapshotStore(memory),
      purgeBefore: () => Promise.resolve(0),
    });
    expect(await failures(open)).toContain(
      'removes the records of every tenant before the day and keeps the day and later',
    );
  });

  it('fail for a store that mixes the tenants', async () => {
    const memory: SnapshotMemory = new Map();
    const shared = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
    const open = (): SnapshotStore => {
      const store = createMemorySnapshotStore(memory);
      return {
        ...store,
        put: (_ctx, snapshot) => store.put(shared, snapshot),
        get: (_ctx, eventId) => store.get(shared, eventId),
      };
    };
    expect(await failures(open)).toEqual(
      expect.arrayContaining([
        'gives nothing for another event or another tenant',
        'keeps the same event of another tenant apart',
      ]),
    );
  });

  it('fail for a store that replaces a record it keeps', async () => {
    const memory: SnapshotMemory = new Map();
    const open = (): SnapshotStore => {
      const store = createMemorySnapshotStore(memory);
      return {
        ...store,
        put: (ctx, snapshot) => {
          memory.delete(
            JSON.stringify([ctx.tenantId, snapshot.eventId, snapshot.part]),
          );
          return store.put(ctx, snapshot);
        },
      };
    };
    expect(await failures(open)).toContain(
      'refuses a second record of the same part and keeps the first',
    );
  });

  it('fail for a store that takes any record', async () => {
    const memory: SnapshotMemory = new Map();
    const open = (): SnapshotStore => {
      const store = createMemorySnapshotStore(memory);
      return {
        ...store,
        put: (ctx, snapshot) =>
          store.put(ctx, { ...snapshot, sealed: 'accepted' }).catch(() => {
            // Taken all the same.
          }),
      };
    };
    expect(await failures(open)).toContain(
      'refuses an event that is no UUID in lower case, an unknown part, a day that is no day and a sealed record of another form',
    );
  });
});
