import { describe, expect, it } from 'vitest';

import { createStdioCatalog } from './catalog.js';

describe('the catalog over stdio', () => {
  it.each([true, false])(
    'holds exactly ct_whoami from the core with readOnly %s',
    (readOnly) => {
      const catalog = createStdioCatalog({ readOnly });
      expect(catalog.list().map((entry) => entry.name)).toEqual(['ct_whoami']);
      expect(catalog.get('ct_whoami')?.origin).toBe('core');
      expect(Object.isFrozen(catalog)).toBe(true);
    },
  );
});
