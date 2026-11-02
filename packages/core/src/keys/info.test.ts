import { describe, expect, it } from 'vitest';

import { infoOf } from './info.js';

describe('infoOf', () => {
  it('puts the length of each part before it, so that no two lists meet', () => {
    expect([...infoOf(['ab', 'c'])]).toEqual([0, 2, 97, 98, 0, 1, 99]);
    expect(infoOf(['a', 'bc'])).not.toEqual(infoOf(['ab', 'c']));
    expect(infoOf([])).toEqual(new Uint8Array());
  });

  it('refuses a part longer than its two bytes of length can say', () => {
    expect(infoOf(['x'.repeat(0xffff)]).length).toBe(0xffff + 2);
    expect(() => infoOf(['x'.repeat(0x10000)])).toThrow(TypeError);
  });
});
