import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isAllowed, runtimeLicences } from '../../scripts/check-licenses.mts';

// pnpm licenses list cannot see code that the MCP SDK bundles into its own
// files, so ADR 0053 lists it with its licences. Bundled code ships with
// the SDK, so every licence there must be on the list for run time
// (ADR 0021). packages/testkit/src/mcp-spike/bundled-code.test.ts keeps
// the list in line with the installed package.

const adr = readFileSync(
  new URL('../../docs/adr/0053-mcp-sdk-und-instanzmodell.md', import.meta.url),
  'utf8',
);

/** Package and licence of every row of the table in the Umsetzung section. */
const rows = (adr.split(/^## Umsetzung$/m)[1] ?? '')
  .split('\n')
  .map((line) =>
    line
      .trim()
      .split('|')
      .map((cell) => cell.trim()),
  )
  .filter((cells) => /^`[^`]+`$/.test(cells[1] ?? ''))
  .map((cells) => ({ name: cells[1] ?? '', licence: cells[3] ?? '' }));

describe('licences of the code bundled in the MCP SDK', () => {
  it('reads the table of ADR 0053', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(rows)('allows $licence of $name at run time', ({ licence }) => {
    expect(isAllowed(licence, runtimeLicences)).toBe(true);
  });

  it('would refuse a licence that is not on the list', () => {
    // The same check, with a row as it would read for a copyleft package.
    expect(isAllowed('GPL-3.0-only', runtimeLicences)).toBe(false);
  });
});
