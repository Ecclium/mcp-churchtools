import type {
  IsoDate,
  SnapshotStore,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMemoryDayKeys,
  createMemorySnapshotStore,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { createFileKeyProvider } from '../keys/file-provider.js';
import { contentHashOf } from '../write/plan-hash.js';
import { createSnapshotKeeper } from './keeper.js';
import { type SnapshotState, sealSnapshot } from './seal.js';

const ctx = {
  tenantId: 'demo-tenant',
  instance: 'https://example.church.tools',
} as unknown as TenantContext;
const eventId = '11111111-2222-4333-8444-555555555555';
const day = '2026-11-03' as IsoDate;
const guid = '00000000-0000-4000-8000-0000000000ab';
const state: SnapshotState = {
  kind: 'wikiPageCreate',
  tool: 'ct_wiki_page_create',
  categoryId: 12,
  title: 'Bericht',
  textHash: contentHashOf(['# Bericht\n']),
};

const setup = () => {
  const dayKeys = createMemoryDayKeys();
  const keys = createFileKeyProvider({ dayKeys });
  const store = createMemorySnapshotStore();
  return { keys, store, keeper: createSnapshotKeeper({ keys, store }) };
};

describe('createSnapshotKeeper', () => {
  it('saves the parts of a snapshot and loads them again', async () => {
    const { keeper } = setup();
    expect(await keeper.load(ctx, eventId)).toEqual({ kind: 'missing' });
    await keeper.save(ctx, { eventId, part: 'before', day, content: state });
    expect(await keeper.load(ctx, eventId)).toEqual({
      kind: 'found',
      before: state,
      day,
    });
    const created = { kind: 'wikiPageCreated', guid, version: 1 } as const;
    await keeper.save(ctx, { eventId, part: 'after', day, content: created });
    expect(await keeper.load(ctx, eventId)).toEqual({
      kind: 'found',
      before: state,
      day,
      after: created,
    });
  });

  it('says expired once the day key is gone, and removes records and keys', async () => {
    const { keeper, store } = setup();
    await keeper.save(ctx, { eventId, part: 'before', day, content: state });
    expect(await keeper.purgeBefore('2026-11-04' as IsoDate)).toEqual({
      records: 1,
      dayKeys: 1,
      complete: true,
    });
    expect(await store.get(ctx, eventId)).toEqual([]);
    expect(await keeper.load(ctx, eventId)).toEqual({ kind: 'missing' });
    // A record whose day key went but which stayed in the store.
    const kept = setup();
    await kept.keeper.save(ctx, {
      eventId,
      part: 'before',
      day,
      content: state,
    });
    await kept.keys.destroyBefore('snapshot', '2026-11-04' as IsoDate);
    expect(await kept.keeper.load(ctx, eventId)).toEqual({ kind: 'expired' });
  });

  it('finds nothing when only the part after is there, or the part before holds an outcome', async () => {
    const { keys, store, keeper } = setup();
    await keeper.save(ctx, {
      eventId,
      part: 'after',
      day,
      content: { kind: 'wikiPageCreated', guid, version: 1 },
    });
    expect(await keeper.load(ctx, eventId)).toEqual({ kind: 'missing' });
    // A store that hands the part after back as the part before.
    const sealed = await sealSnapshot(keys, ctx, {
      eventId,
      part: 'after',
      day,
      content: { kind: 'wikiPageCreated', guid, version: 1 },
    });
    const lying: SnapshotStore = {
      ...store,
      get: () => Promise.resolve([{ ...sealed, part: 'before' }]),
    };
    await expect(
      createSnapshotKeeper({ keys, store: lying }).load(ctx, eventId),
    ).rejects.toThrow('does not open');
  });

  it('leaves out a part after whose day key is gone', async () => {
    const { keeper, keys } = setup();
    const later = '2026-11-04' as IsoDate;
    await keeper.save(ctx, {
      eventId,
      part: 'before',
      day: later,
      content: state,
    });
    await keeper.save(ctx, {
      eventId,
      part: 'after',
      day,
      content: { kind: 'wikiPageCreated', guid, version: 1 },
    });
    await keys.destroyBefore('snapshot', later);
    expect(await keeper.load(ctx, eventId)).toEqual({
      kind: 'found',
      before: state,
      day: later,
    });
  });

  it('destroys the day keys also when the store cannot purge, and then reports it', async () => {
    const { keys, store } = setup();
    const failing: SnapshotStore = {
      ...store,
      purgeBefore: () => Promise.reject(new Error('stays')),
    };
    const counting = {
      ...keys,
      destroyBefore: () => Promise.resolve(2),
    };
    expect(
      await createSnapshotKeeper({
        keys: counting,
        store: failing,
      }).purgeBefore(day),
    ).toEqual({ records: 0, dayKeys: 2, complete: false });
  });

  it('keeps the count of the records when the day keys cannot all go', async () => {
    const { keys, store, keeper } = setup();
    await keeper.save(ctx, { eventId, part: 'before', day, content: state });
    const failing = {
      ...keys,
      destroyBefore: () => Promise.reject(new Error('stays')),
    };
    expect(
      await createSnapshotKeeper({ keys: failing, store }).purgeBefore(
        '2026-11-04' as IsoDate,
      ),
    ).toEqual({ records: 1, dayKeys: 0, complete: false });
  });
});
