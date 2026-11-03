import type {
  ApprovalQueue,
  IsoDate,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { quotaContext } from '../quota/index.js';
import {
  approvalQueueChecks,
  type ApprovalQueueMemory,
  createMemoryApprovalQueue,
} from './index.js';

const memoryOf = (): ApprovalQueueMemory => ({
  entries: new Map(),
  decisions: new Map(),
});

describe('the queue of approvals in memory', () => {
  it.each(approvalQueueChecks)('$name', async ({ run }) => {
    const memory = memoryOf();
    await run(() => createMemoryApprovalQueue(memory));
  });

  it('is frozen, and so are the checks and the items it gives', async () => {
    const queue = createMemoryApprovalQueue();
    expect(Object.isFrozen(queue)).toBe(true);
    expect(Object.isFrozen(approvalQueueChecks)).toBe(true);
    const ctx = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
    const id = '00000000-0000-4000-8000-000000000001';
    await queue.put(ctx, { id, day: '2026-11-03' as IsoDate, sealed: 'x' });
    const items = await queue.list(ctx);
    expect(Object.isFrozen(items)).toBe(true);
    expect(items.every((item) => Object.isFrozen(item))).toBe(true);
  });
});

// A queue that breaks a promise must fail the checks, or they show
// nothing.
describe('the checks of queues of approvals', () => {
  const failures = async (open: () => ApprovalQueue): Promise<string[]> => {
    const failed: string[] = [];
    for (const { name, run } of approvalQueueChecks) {
      await run(open).catch(() => failed.push(name));
    }
    return failed;
  };

  it('fail for a queue that a restart empties', async () => {
    expect(await failures(() => createMemoryApprovalQueue())).toContain(
      'keeps its entries and decisions over a restart',
    );
  });

  it('fail for a queue that gives its entries newest first', async () => {
    const memory = memoryOf();
    const open = (): ApprovalQueue => {
      const queue = createMemoryApprovalQueue(memory);
      return {
        ...queue,
        list: async (ctx) => [...(await queue.list(ctx))].reverse(),
      };
    };
    expect(await failures(open)).toContain(
      'gives back the entries it keeps, the oldest day first and by ID within a day',
    );
  });

  it('fail for a queue that never removes an item', async () => {
    const memory = memoryOf();
    const open = (): ApprovalQueue => ({
      ...createMemoryApprovalQueue(memory),
      purgeBefore: () => Promise.resolve(0),
    });
    expect(await failures(open)).toContain(
      'removes the entries and decisions of every tenant before the day and keeps the day and later',
    );
  });

  it('fail for a queue that mixes the tenants', async () => {
    const memory = memoryOf();
    const shared = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
    const open = (): ApprovalQueue => {
      const queue = createMemoryApprovalQueue(memory);
      return {
        ...queue,
        put: (_ctx, entry) => queue.put(shared, entry),
        get: (_ctx, id) => queue.get(shared, id),
        list: () => queue.list(shared),
        decide: (_ctx, decision) => queue.decide(shared, decision),
      };
    };
    expect(await failures(open)).toEqual(
      expect.arrayContaining([
        'gives nothing for another ID or another tenant',
        'keeps the same ID of another tenant apart',
      ]),
    );
  });

  it('fail for a queue that replaces an entry it keeps', async () => {
    const memory = memoryOf();
    const open = (): ApprovalQueue => {
      const queue = createMemoryApprovalQueue(memory);
      return {
        ...queue,
        put: (ctx, entry) => {
          memory.entries.delete(
            JSON.stringify([ctx.tenantId, entry.day, entry.id]),
          );
          return queue.put(ctx, entry);
        },
      };
    };
    expect(await failures(open)).toContain(
      'refuses a second entry of the same ID and keeps the first',
    );
  });

  it('fail for a queue that keeps the entry after a decision or takes a second one', async () => {
    const memory = memoryOf();
    const open = (): ApprovalQueue => {
      const queue = createMemoryApprovalQueue(memory);
      return {
        ...queue,
        decide: async (ctx, decision) => {
          const key = JSON.stringify([ctx.tenantId, decision.day, decision.id]);
          const entry = memory.entries.get(key);
          memory.decisions.delete(key);
          await queue.decide(ctx, decision).catch(() => undefined);
          if (entry !== undefined) memory.entries.set(key, entry);
        },
      };
    };
    expect(await failures(open)).toContain(
      'keeps one decision per entry and destroys the entry with it',
    );
  });

  it('fail for a queue that decides an entry it does not hold', async () => {
    const memory = memoryOf();
    const open = (): ApprovalQueue => {
      const queue = createMemoryApprovalQueue(memory);
      return {
        ...queue,
        decide: (ctx, decision) =>
          queue.decide(ctx, decision).catch(() => {
            memory.decisions.set(
              JSON.stringify([ctx.tenantId, decision.day, decision.id]),
              decision,
            );
          }),
      };
    };
    expect(await failures(open)).toContain(
      'refuses a decision without an entry of its ID, day and tenant',
    );
  });

  it('fail for a queue that takes any entry', async () => {
    const memory = memoryOf();
    const open = (): ApprovalQueue => {
      const queue = createMemoryApprovalQueue(memory);
      return {
        ...queue,
        put: (ctx, entry) =>
          queue.put(ctx, { ...entry, sealed: 'accepted' }).catch(() => {
            // Taken all the same.
          }),
      };
    };
    expect(await failures(open)).toContain(
      'refuses an ID that is no UUID in lower case, a day that is no day, a sealed entry of another form and a decision or time that is none',
    );
  });
});
