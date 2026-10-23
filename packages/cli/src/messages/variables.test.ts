import { variableNames } from '@ecclium/mcp-churchtools-core';
import { describe, expect, it } from 'vitest';

import { variableDescriptions } from './variables.js';

// The generated reference of the configuration takes these texts. A
// variable of the table without one would appear there without a
// description, so the list has to match the table exactly.
describe('variableDescriptions', () => {
  it('describes exactly the variables of the table', () => {
    expect(Object.keys(variableDescriptions).sort()).toEqual(
      [...variableNames].sort(),
    );
  });

  it.each(variableNames)(
    'describes %s in whole sentences of the house style',
    (name) => {
      const text = variableDescriptions[name];
      expect(text.length).toBeGreaterThan(20);
      expect(text).toMatch(/^[A-ZÄÖÜ`]/u);
      expect(text).toMatch(/\.$/u);
      // Swiss spelling and no dashes as punctuation (brand/README.md).
      expect(text).not.toMatch(/[ß—–]/u);
      expect(text).not.toMatch(/[“”„"]/u);
    },
  );

  it('is frozen and has no prototype', () => {
    expect(Object.isFrozen(variableDescriptions)).toBe(true);
    expect(Object.getPrototypeOf(variableDescriptions)).toBeNull();
  });
});
