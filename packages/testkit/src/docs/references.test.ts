import { variableNames } from '@ecclium/mcp-churchtools-core';
import { describe, expect, it } from 'vitest';

import { renderConfigurationReference } from './configuration.js';
import { renderToolsReference } from './tools.js';

// The two references are file snapshots: a change of a tool or a variable
// turns these tests red until `pnpm docs:generate` writes the files again.
// In CI, vitest writes no snapshot, so a forgotten generation fails there.
describe('the generated references', () => {
  it('matches docs/tools.md', async () => {
    await expect(renderToolsReference()).toMatchFileSnapshot(
      '../../../../docs/tools.md',
    );
  });

  it('matches docs/configuration.md', async () => {
    await expect(renderConfigurationReference()).toMatchFileSnapshot(
      '../../../../docs/configuration.md',
    );
  });
});

describe('renderToolsReference', () => {
  const page = renderToolsReference();

  it('renders the same page every time', () => {
    expect(renderToolsReference()).toBe(page);
  });

  it('lists every tool of the core once in the overview and once as a section', () => {
    const overview = page.slice(0, page.indexOf('\n## `'));
    for (const name of ['ct_groups_search', 'ct_persons_search', 'ct_whoami']) {
      expect(overview.split(`\n| \`${name}\` |`)).toHaveLength(2);
      expect(page.split(`\n## \`${name}\`\n`)).toHaveLength(2);
    }
  });

  it('names the toolset of the search tools and none for ct_whoami', () => {
    expect(page).toContain(
      '| `ct_persons_search` | `persons` | besonders schützenswert | nie | nein | `persons` in `ECCLIUM_TOOLSETS`, mit `ECCLIUM_STATE_DIR` |',
    );
    expect(page).toContain(
      '| `ct_groups_search` | `groups` | besonders schützenswert | nie | nein | `persons` in `ECCLIUM_TOOLSETS`, mit `ECCLIUM_STATE_DIR` |',
    );
    expect(page).toContain(
      '| `ct_whoami` | `base` | personenbezogen | nie | nein | immer |',
    );
  });

  it('shows containers that may be missing or null, not only their leaves', () => {
    expect(page).toContain('| `rights.modules` | Liste |  | nein | ja |');
    expect(page).toContain(
      '| `rights.modules[].rights[].ids` | Liste |  | ja | nein |',
    );
  });

  it('lists the free text of the core: the names of groups', () => {
    const freeText = page.slice(page.indexOf('## Freitextfelder'));
    expect(freeText).toContain('| `ct_groups_search` | `groups[].name` |');
    expect(freeText).not.toContain('ct_persons_search');
  });

  it('keeps each description as the model reads it, in a block of text', () => {
    expect(page).toContain(
      'Required ChurchTools rights: "view alldata" in churchdb.',
    );
  });
});

describe('renderConfigurationReference', () => {
  const page = renderConfigurationReference();

  it('has a row and a section for every variable of the table', () => {
    for (const name of variableNames) {
      expect(page.split(`\n| \`${name}\` |`)).toHaveLength(2);
      expect(page.split(`\n## \`${name}\`\n`)).toHaveLength(2);
    }
  });

  it('names the range of the requests per minute', () => {
    expect(page).toContain('ganze Zahl von 1 bis 500');
  });
});
