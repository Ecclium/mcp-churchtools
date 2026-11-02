import type { IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import {
  createMemoryDayKeys,
  type DayKeyMemory,
  type DayKeyProvider,
  dayKeyChecks,
} from './index.js';

describe('the day keys in memory', () => {
  it.each(dayKeyChecks)('$name', async ({ run }) => {
    const memory: DayKeyMemory = new Map();
    await run(() => createMemoryDayKeys(memory));
  });

  it('are frozen, and so are the checks', () => {
    expect(Object.isFrozen(createMemoryDayKeys())).toBe(true);
    expect(Object.isFrozen(dayKeyChecks)).toBe(true);
  });
});

// A provider that breaks a promise must fail the checks, or they show
// nothing.
describe('the checks of day keys', () => {
  const failures = async (open: () => DayKeyProvider): Promise<string[]> => {
    const failed: string[] = [];
    for (const { name, run } of dayKeyChecks) {
      await run(open).catch(() => failed.push(name));
    }
    return failed;
  };

  it('fail for day keys that a restart loses', async () => {
    expect(await failures(() => createMemoryDayKeys())).toContain(
      'opens a key after a restart, with the same day key',
    );
  });

  it('fail for day keys that are never destroyed', async () => {
    const memory: DayKeyMemory = new Map();
    const open = (): DayKeyProvider => ({
      ...createMemoryDayKeys(memory),
      destroyBefore: () => Promise.resolve(0),
    });
    expect(await failures(open)).toEqual(
      expect.arrayContaining([
        'gives nothing for a day whose key it destroyed',
        'destroys the day keys of every tenant before the day',
      ]),
    );
  });

  it('fail for day keys that open a key for any purpose and day', async () => {
    const memory: DayKeyMemory = new Map();
    const open = (): DayKeyProvider => {
      const keys = createMemoryDayKeys(memory);
      return {
        ...keys,
        unwrap: (ctx, _purpose, wrapped) =>
          keys.unwrap(ctx, 'snapshot', {
            ...wrapped,
            purpose: 'snapshot',
            day: '2026-11-03' as IsoDate,
          }),
      };
    };
    expect(await failures(open)).toContain(
      'never opens a key for the other purpose',
    );
  });

  it('fail for day keys that take any purpose and day', async () => {
    const memory: DayKeyMemory = new Map();
    const open = (): DayKeyProvider => {
      const keys = createMemoryDayKeys(memory);
      return {
        ...keys,
        wrap: (ctx, _purpose, _day, key) =>
          keys.wrap(ctx, 'snapshot', '2026-11-03' as IsoDate, key),
        destroyBefore: () => Promise.resolve(0),
      };
    };
    expect(await failures(open)).toContain(
      'refuses a key of another length, a purpose of derived keys and a day that is no day',
    );
  });
});
