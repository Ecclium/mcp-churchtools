import { describe, expect, it } from 'vitest';

import { dataKeyLength, dayKeyPurposes, keyPurposes } from './index.js';

describe('the port for keys', () => {
  it('derives keys for one purpose, frozen', () => {
    expect(keyPurposes).toEqual(['pseudonym']);
    expect(Object.isFrozen(keyPurposes)).toBe(true);
  });

  it('keeps day keys for snapshots and the queue, frozen', () => {
    expect(dayKeyPurposes).toEqual(['snapshot', 'queue']);
    expect(Object.isFrozen(dayKeyPurposes)).toBe(true);
  });

  it('never shares a name between the two kinds of keys', () => {
    const derived: readonly string[] = keyPurposes;
    expect(
      dayKeyPurposes.filter((purpose) => derived.includes(purpose)),
    ).toEqual([]);
  });

  it('gives keys of 256 bits', () => {
    expect(dataKeyLength).toBe(32);
  });
});
