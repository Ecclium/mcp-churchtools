import { describe, expect, it } from 'vitest';

import { fitsShape } from './json-shape.js';

const limits = { maxDepth: 16, maxElements: 10 };

describe('fitsShape', () => {
  it('takes 16 levels and refuses 17', () => {
    expect(
      fitsShape(`${'['.repeat(16)}${']'.repeat(16)}`, {
        maxDepth: 16,
        maxElements: 100,
      }),
    ).toBe(true);
    expect(
      fitsShape(`${'['.repeat(17)}${']'.repeat(17)}`, {
        maxDepth: 16,
        maxElements: 100,
      }),
    ).toBe(false);
    expect(
      fitsShape(`${'{"a":'.repeat(17)}1${'}'.repeat(17)}`, {
        maxDepth: 16,
        maxElements: 100,
      }),
    ).toBe(false);
  });

  it('takes exactly the limit of elements and refuses one more', () => {
    // One opening bracket and nine commas are ten elements.
    expect(fitsShape(`[${'1,'.repeat(9)}1]`, limits)).toBe(true);
    expect(fitsShape(`[${'1,'.repeat(10)}1]`, limits)).toBe(false);
    expect(fitsShape('[]'.repeat(11), limits)).toBe(false);
  });

  it('counts nothing inside strings, also after an escaped quote', () => {
    const inner = `"${'[{,'.repeat(50)}\\"${'[{,'.repeat(50)}"`;
    expect(fitsShape(`{"a":${inner}}`, { maxDepth: 2, maxElements: 2 })).toBe(
      true,
    );
    expect(fitsShape(`{"a":"\\\\"}`, { maxDepth: 1, maxElements: 1 })).toBe(
      true,
    );
  });

  it('closes levels again', () => {
    expect(fitsShape('[[]]'.repeat(5), { maxDepth: 2, maxElements: 10 })).toBe(
      true,
    );
  });
});
