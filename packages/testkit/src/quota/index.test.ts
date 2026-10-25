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
