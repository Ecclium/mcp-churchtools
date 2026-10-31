import { describe, expect, it } from 'vitest';

import { dataKeyLength, keyPurposes } from './index.js';

describe('the port for keys', () => {
  it('serves one purpose today, frozen', () => {
    expect(keyPurposes).toEqual(['pseudonym']);
    expect(Object.isFrozen(keyPurposes)).toBe(true);
  });

  it('gives keys of 256 bits', () => {
    expect(dataKeyLength).toBe(32);
  });
});
