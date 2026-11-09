import { coreToolCatalog } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { describeRunTool } from './run-tool.js';

// The facts of a tool that the engine of a run checks before the first
// read (ADR 0033), on the tools of the free core.

const catalog = coreToolCatalog();

describe('the facts of a tool for a run', () => {
  it('name a list tool with pages, its parameters and the fields of an entry', () => {
    const facts = describeRunTool(catalog, 'ct_events_list');
    expect(facts).toEqual({
      capability: 'read',
      routineStable: true,
      unattended: 'policy',
      params: ['from', 'page', 'to'],
      list: 'events',
      entryFields: [
        'calendarId',
        'calendarName',
        'endDate',
        'id',
        'isCanceled',
        'name',
        'startDate',
      ],
      paged: true,
    });
    expect(Object.isFrozen(facts)).toBe(true);
  });

  it('name the fields of the result itself for a tool without a list', () => {
    const facts = describeRunTool(catalog, 'ct_wiki_page_get');
    expect(facts?.list).toBe(undefined);
    expect(facts?.paged).toBe(false);
    expect(facts?.entryFields).toContain('text');
    expect(facts?.params).toContain('guid');
  });

  it('tell a tool that is not stable for routines', () => {
    expect(describeRunTool(catalog, 'ct_whoami')).toMatchObject({
      routineStable: false,
      params: [],
      paged: false,
    });
  });

  it('are none for a tool the catalog does not have', () => {
    expect(describeRunTool(catalog, 'ct_test_none')).toBe(undefined);
  });
});
