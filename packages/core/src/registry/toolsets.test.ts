import type { ToolDomain } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import {
  isToolsetName,
  toolsetNames,
  toolsetOf,
  toolsetsOfAll,
} from './toolsets.js';

// Every area of the plugin API with its toolset (ADR 0062). A new area
// without a row here fails the type check of the record.
const expected: Readonly<
  Record<ToolDomain, (typeof toolsetNames)[number] | 'base' | undefined>
> = {
  base: 'base',
  persons: 'persons',
  groups: 'persons',
  events: 'events',
  services: 'events',
  calendars: 'calendars',
  appointments: 'calendars',
  resources: 'calendars',
  bookings: 'calendars',
  wiki: 'wiki',
  songs: 'songs',
  docs: 'docs',
  api: 'api',
};

describe('the toolsets', () => {
  it('names seven toolsets, frozen, in a fixed order', () => {
    expect(toolsetNames).toEqual([
      'persons',
      'events',
      'calendars',
      'wiki',
      'songs',
      'docs',
      'api',
    ]);
    expect(Object.isFrozen(toolsetNames)).toBe(true);
  });

  // The escape hatch passes on whole answers, so all leaves it out and an
  // operator names it on purpose (ADR 0067).
  it('turns on every toolset but api with all, frozen', () => {
    expect(toolsetsOfAll).toEqual(
      toolsetNames.filter((name) => name !== 'api'),
    );
    expect(toolsetsOfAll).not.toContain('api');
    expect(Object.isFrozen(toolsetsOfAll)).toBe(true);
  });

  it.each(Object.entries(expected))(
    'gives the area %s the toolset %s',
    (domain, toolset) => {
      expect(toolsetOf(domain as ToolDomain)).toBe(toolset);
    },
  );

  it('gives every toolset at least one area', () => {
    for (const name of toolsetNames) {
      expect(Object.values(expected), name).toContain(name);
    }
  });

  it.each(['toString', '__proto__', 'constructor', 'Persons', ''])(
    'gives no toolset to %j, which is no area',
    (domain) => {
      expect(toolsetOf(domain as ToolDomain)).toBeUndefined();
    },
  );

  it('knows only the seven names as toolsets', () => {
    for (const name of toolsetNames) expect(isToolsetName(name)).toBe(true);
    for (const value of ['all', 'base', 'groups', 'Persons', '', 1, null]) {
      expect(isToolsetName(value), String(value)).toBe(false);
    }
  });
});
