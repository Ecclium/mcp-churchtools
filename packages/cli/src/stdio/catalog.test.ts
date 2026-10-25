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
    'adds the six tools of persons and groups with readOnly %s and the toolset persons, all special',
    (readOnly) => {
      const catalog = createStdioCatalog({ readOnly, toolsets: ['persons'] });
      expect(catalog.list().map((entry) => entry.name)).toEqual([
        'ct_groups_get',
        'ct_groups_get_members',
        'ct_groups_search',
        'ct_persons_get',
        'ct_persons_get_groups',
        'ct_persons_search',
        'ct_whoami',
      ]);
      for (const entry of catalog.list()) {
        expect(entry.origin).toBe('core');
        if (entry.name !== 'ct_whoami') {
          expect(entry.meta.sensitivity).toBe('special');
        }
      }
    },
  );

  it('adds the three tools of the wiki for the toolset wiki, none of them special', () => {
    const catalog = createStdioCatalog({ readOnly: true, toolsets: ['wiki'] });
    expect(catalog.list().map((entry) => entry.name)).toEqual([
      'ct_whoami',
      'ct_wiki_categories_list',
      'ct_wiki_page_get',
      'ct_wiki_pages_list',
    ]);
    for (const entry of catalog.list()) {
      expect(entry.meta.sensitivity).not.toBe('special');
    }
  });

  // The other toolsets have no tool of the core yet.
  it('adds no tool for a toolset without tools', () => {
    const catalog = createStdioCatalog({
      readOnly: true,
      toolsets: ['events', 'calendars', 'songs'],
    });
    expect(catalog.list().map((entry) => entry.name)).toEqual(['ct_whoami']);
  });
});
