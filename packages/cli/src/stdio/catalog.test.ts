import { describe, expect, it } from 'vitest';

import { createStdioCatalog } from './catalog.js';

describe('the catalog over stdio', () => {
  it.each([true, false])(
    'holds exactly ct_whoami from the core with readOnly %s and no toolset',
    (readOnly) => {
      const catalog = createStdioCatalog({ readOnly, toolsets: [] });
      expect(catalog.list().map((entry) => entry.name)).toEqual(['ct_whoami']);
      expect(catalog.get('ct_whoami')?.origin).toBe('core');
      expect(Object.isFrozen(catalog)).toBe(true);
    },
  );

  it.each([true, false])(
    'adds both search tools of the core with readOnly %s and the toolset persons',
    (readOnly) => {
      const catalog = createStdioCatalog({ readOnly, toolsets: ['persons'] });
      expect(catalog.list().map((entry) => entry.name)).toEqual([
        'ct_groups_search',
        'ct_persons_search',
        'ct_whoami',
      ]);
      for (const entry of catalog.list()) expect(entry.origin).toBe('core');
      expect(catalog.get('ct_persons_search')?.meta.sensitivity).toBe(
        'special',
      );
      expect(catalog.get('ct_groups_search')?.meta.sensitivity).toBe('special');
    },
  );

  // The other toolsets have no tool of the core yet.
  it('adds no tool for a toolset without tools', () => {
    const catalog = createStdioCatalog({
      readOnly: true,
      toolsets: ['events', 'calendars', 'wiki', 'songs'],
    });
    expect(catalog.list().map((entry) => entry.name)).toEqual(['ct_whoami']);
  });
});
