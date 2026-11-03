import type {
  ApprovalQueue,
  Clock,
  IsoDate,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMemoryApprovalQueue,
  createMemoryDayKeys,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { createFileKeyProvider } from '../keys/file-provider.js';
import {
  createQueueKeeper,
  firstKeptQueueDay,
  queueRetentionDays,
} from './keeper.js';
import type { QueueEntryContent } from './seal.js';

const ctx = {
  tenantId: 'demo-tenant',
  instance: 'https://example.church.tools',
} as unknown as TenantContext;
const id = '11111111-2222-4333-8444-555555555555';
const second = '11111111-2222-4333-8444-555555555556';
const day = '2026-11-03' as IsoDate;
const content: QueueEntryContent = {
  tool: 'ct_wiki_page_create',
  origin: 'core',
  toolMeta: { sensitivity: 'personal', unattended: 'policy' },
  actor: { kind: 'service', id: 'stdio:local-stdio' },
  intent: {
    kind: 'wikiPageCreate',
    categoryId: 12,
    title: 'Bericht',
    text: '# Bericht\n',
  },
  planHash: 'b'.repeat(64),
  target: { kind: 'wiki_category', key: '12' },
  summary: 'Neue Seite «Bericht» in der Kategorie 12 mit 1 Zeile anlegen.',
  title: 'Bericht',
  diff: ['@@ -0,0 +1,1 @@', '+# Bericht'],
  reason: 'setting',
  queuedAt: Date.UTC(2026, 10, 3, 17),
};

// A clock at noon of a day, which a test can move.
const clockAt = (iso: string): Clock & { set: (next: string) => void } => {
  let now = Date.parse(`${iso}T12:00:00.000Z`);
  return {
    now: () => now,
    set: (next: string) => {
      now = Date.parse(`${next}T12:00:00.000Z`);
    },
  };
};

const setup = (store: ApprovalQueue = createMemoryApprovalQueue()) => {
  const dayKeys = createMemoryDayKeys();
  const keys = createFileKeyProvider({ dayKeys });
  const clock = clockAt(day);
  return {
    keys,
    store,
    clock,
    keeper: createQueueKeeper({ keys, store, clock }),
  };
};

describe('firstKeptQueueDay', () => {
  it('is the day 14 days before, and none without a time', () => {
    expect(queueRetentionDays).toBe(14);
    expect(firstKeptQueueDay(Date.UTC(2026, 10, 15, 12))).toBe('2026-11-01');
    expect(firstKeptQueueDay(Date.UTC(2026, 10, 15, 0))).toBe('2026-11-01');
    expect(firstKeptQueueDay(Date.UTC(2026, 10, 14, 23, 59))).toBe(
      '2026-10-31',
    );
    expect(firstKeptQueueDay(Number.NaN)).toBeUndefined();
    expect(firstKeptQueueDay(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(firstKeptQueueDay(8.64e15 + 14 * 86_400_000 + 1)).toBeUndefined();
    // A year beyond 9999 gives no day of the form of the audit.
    expect(firstKeptQueueDay(Date.UTC(10_000, 0, 20))).toBeUndefined();
  });
});

describe('createQueueKeeper', () => {
  it('queues an entry, loads it again and lists it as open', async () => {
    const { keeper, store } = setup();
    expect(await keeper.load(ctx, id)).toEqual({ kind: 'missing' });
    await keeper.enqueue(ctx, { id, day, content });
    const item = await store.get(ctx, id);
    expect(item?.entry?.sealed).not.toContain('Bericht');
    expect(await keeper.load(ctx, id)).toEqual({
      kind: 'found',
      day,
      content,
    });
    const listed = await keeper.list(ctx);
    expect(listed).toEqual([{ state: 'open', id, day, content }]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(await keeper.waiting(ctx)).toBe(1);
  });

  it('keeps a decision, destroys the entry and says so', async () => {
    const { keeper, store } = setup();
    await keeper.enqueue(ctx, { id, day, content });
    const decision = {
      id,
      day,
      decision: 'rejected',
      decidedAt: '2026-11-03T18:00:00.000Z',
    } as const;
    await keeper.decide(ctx, decision);
    expect((await store.get(ctx, id))?.entry).toBeUndefined();
    expect(await keeper.load(ctx, id)).toEqual({ kind: 'decided', decision });
    expect(await keeper.list(ctx)).toEqual([
      {
        state: 'rejected',
        id,
        day,
        decidedAt: '2026-11-03T18:00:00.000Z',
      },
    ]);
    expect(await keeper.waiting(ctx)).toBe(0);
    await expect(keeper.decide(ctx, decision)).rejects.toThrow();
  });

  it('counts an entry past 14 days as expired by its day, while its day key is still there', async () => {
    const { keeper, clock } = setup();
    await keeper.enqueue(ctx, { id, day, content });
    clock.set('2026-11-17');
    expect(await keeper.load(ctx, id)).toEqual({ kind: 'found', day, content });
    clock.set('2026-11-18');
    expect(await keeper.load(ctx, id)).toEqual({ kind: 'expired', day });
    expect(await keeper.list(ctx)).toEqual([{ state: 'expired', id, day }]);
    expect(await keeper.waiting(ctx)).toBe(0);
  });

  it('counts an entry whose day key is gone as expired', async () => {
    const { keeper, keys } = setup();
    await keeper.enqueue(ctx, { id, day, content });
    expect(await keys.destroyBefore('queue', '2026-11-04' as IsoDate)).toBe(1);
    expect(await keeper.load(ctx, id)).toEqual({ kind: 'expired', day });
    expect(await keeper.list(ctx)).toEqual([{ state: 'expired', id, day }]);
  });

  it('lists an entry that does not open as damaged, and its load rejects', async () => {
    const store = createMemoryApprovalQueue();
    const { keeper } = setup(store);
    await keeper.enqueue(ctx, { id, day, content });
    await store.put(ctx, { id: second, day, sealed: 'not.sealed' });
    expect(await keeper.list(ctx)).toEqual([
      { state: 'open', id, day, content },
      { state: 'damaged', id: second, day },
    ]);
    await expect(keeper.load(ctx, second)).rejects.toThrow('does not open');
    expect(await keeper.waiting(ctx)).toBe(2);
  });

  it('counts every entry as expired and none as waiting with a clock that fails', async () => {
    const dayKeys = createMemoryDayKeys();
    const keys = createFileKeyProvider({ dayKeys });
    const store = createMemoryApprovalQueue();
    await createQueueKeeper({ keys, store, clock: clockAt(day) }).enqueue(ctx, {
      id,
      day,
      content,
    });
    for (const clock of [
      { now: () => Number.NaN },
      {
        now: () => {
          throw new Error('no clock');
        },
      },
    ]) {
      const keeper = createQueueKeeper({ keys, store, clock });
      expect(await keeper.load(ctx, id)).toEqual({ kind: 'expired', day });
      expect(await keeper.list(ctx)).toEqual([{ state: 'expired', id, day }]);
      expect(await keeper.waiting(ctx)).toBeUndefined();
    }
  });

  it('removes entries and day keys before a day, and says when one half failed', async () => {
    const { keeper, store, keys } = setup();
    await keeper.enqueue(ctx, { id, day, content });
    expect(await keeper.purgeBefore('2026-11-04' as IsoDate)).toEqual({
      records: 1,
      dayKeys: 1,
      complete: true,
    });
    expect(await store.list(ctx)).toEqual([]);
    const failing = createQueueKeeper({
      keys: {
        ...keys,
        destroyBefore: () => Promise.reject(new Error('stays')),
      },
      store: {
        ...store,
        purgeBefore: () => Promise.reject(new Error('stays')),
      },
      clock: clockAt(day),
    });
    expect(await failing.purgeBefore('2026-11-04' as IsoDate)).toEqual({
      records: 0,
      dayKeys: 0,
      complete: false,
    });
  });

  it('destroys an entry left next to its decision when it finds both', async () => {
    const store = createMemoryApprovalQueue();
    const { keeper } = setup(store);
    await keeper.enqueue(ctx, { id, day, content });
    const decision = {
      id,
      day,
      decision: 'rejected',
      decidedAt: '2026-11-03T18:00:00.000Z',
    } as const;
    const item = await store.get(ctx, id);
    if (item === undefined) throw new Error('no entry');
    // A store that stopped after keeping the decision gives both.
    const stopped: ApprovalQueue = {
      ...store,
      get: async (c, i) =>
        (await store.get(c, i)) === undefined
          ? undefined
          : { ...item, decision },
    };
    const decided: string[] = [];
    const watching: ApprovalQueue = {
      ...stopped,
      decide: (c, d) => {
        decided.push(d.decision);
        return store.decide(c, d);
      },
    };
    const healing = setup(watching).keeper;
    expect(await healing.load(ctx, id)).toEqual({ kind: 'decided', decision });
    expect(decided).toEqual(['rejected']);
    expect((await store.get(ctx, id))?.entry).toBeUndefined();
    // A second look finds the decision alone and decides nothing more.
    const failing = setup({
      ...stopped,
      decide: () => Promise.reject(new Error('decided')),
    }).keeper;
    expect(await failing.load(ctx, id)).toEqual({ kind: 'decided', decision });
  });

  it('counts an entry a store gives under another ID or day as damaged', async () => {
    const store = createMemoryApprovalQueue();
    const { keeper } = setup(store);
    await keeper.enqueue(ctx, { id, day, content });
    const sealed = (await store.get(ctx, id))?.entry;
    if (sealed === undefined) throw new Error('no entry');
    for (const item of [
      { id: second, day, entry: sealed },
      { id, day: '2026-11-04' as IsoDate, entry: sealed },
    ]) {
      const relabelled: ApprovalQueue = {
        ...store,
        get: () => Promise.resolve(item),
        list: () => Promise.resolve([item]),
      };
      const other = setup(relabelled).keeper;
      await expect(other.load(ctx, item.id)).rejects.toThrow('does not open');
      expect((await other.list(ctx))[0]?.state).toBe('damaged');
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(setup().keeper)).toBe(true);
  });
});
