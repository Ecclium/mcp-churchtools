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
    'adds the six tools of persons and groups and the global search with readOnly %s and the toolset persons, all special',
    (readOnly) => {
      const catalog = createStdioCatalog({ readOnly, toolsets: ['persons'] });
      expect(catalog.list().map((entry) => entry.name)).toEqual([
        'ct_groups_get',
        'ct_groups_get_members',
        'ct_groups_search',
        'ct_persons_get',
        'ct_persons_get_groups',
        'ct_persons_search',
        'ct_search',
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

  // The search in the wiki names no person in a field of its own: its
  // previews are text in the data envelope (ADR 0064).
  it('adds the four tools of the wiki for the toolset wiki, none of them special or treated as special', () => {
    const catalog = createStdioCatalog({ readOnly: true, toolsets: ['wiki'] });
    expect(catalog.list().map((entry) => entry.name)).toEqual([
      'ct_whoami',
      'ct_wiki_categories_list',
      'ct_wiki_page_get',
      'ct_wiki_pages_list',
      'ct_wiki_search',
    ]);
    for (const entry of catalog.list()) {
      expect(entry.meta.sensitivity).not.toBe('special');
      expect(entry.asSpecial).toBe(false);
    }
  });

  // Only the tool of the assignments names persons, so only it is treated
  // like a special one (ADR 0064).
  it('adds the five tools of events and services for the toolset events, one treated as special', () => {
    const catalog = createStdioCatalog({
      readOnly: true,
      toolsets: ['events'],
    });
    expect(catalog.list().map((entry) => entry.name)).toEqual([
      'ct_events_get',
      'ct_events_get_agenda',
      'ct_events_list',
      'ct_services_get_assignments',
      'ct_services_list',
      'ct_whoami',
    ]);
    for (const entry of catalog.list()) {
      expect(entry.meta.sensitivity).not.toBe('special');
      expect(entry.asSpecial).toBe(
        entry.name === 'ct_services_get_assignments',
      );
    }
  });

  // No tool of calendars, appointments, resources and bookings names a
  // person, so none is treated like a special one and the toolset needs no
  // folder of state (ADR 0064).
  it('adds the five tools of calendars and resources for the toolset calendars, none treated as special', () => {
    const catalog = createStdioCatalog({
      readOnly: true,
      toolsets: ['calendars'],
    });
    expect(catalog.list().map((entry) => entry.name)).toEqual([
      'ct_appointments_get',
      'ct_appointments_list',
      'ct_bookings_list',
      'ct_calendars_list',
      'ct_resources_list',
      'ct_whoami',
    ]);
    for (const entry of catalog.list()) {
      expect(entry.origin).toBe('core');
      expect(entry.meta.sensitivity).not.toBe('special');
      expect(entry.asSpecial).toBe(false);
    }
  });

  // Songs name no person of ChurchTools, so neither tool is treated like
  // a special one and the toolset needs no folder of state (ADR 0064).
  it('adds the two tools of songs for the toolset songs, none treated as special', () => {
    const catalog = createStdioCatalog({
      readOnly: true,
      toolsets: ['songs'],
    });
    expect(catalog.list().map((entry) => entry.name)).toEqual([
      'ct_songs_get',
      'ct_songs_search',
      'ct_whoami',
    ]);
    for (const entry of catalog.list()) {
      expect(entry.origin).toBe('core');
      expect(entry.meta.sensitivity).not.toBe('special');
      expect(entry.asSpecial).toBe(false);
    }
  });
});
