import { describe, expect, it } from 'vitest';

import {
  cruiseCopy,
  cruiseTimeout,
  temporaryFoldersOfFile,
} from './dependency-cases.mts';

// dependency-cruiser keeps the set of followable extensions that the first
// import it resolves in a process gives (assertSourcesFollowed in
// dependency-cases.mts). Vitest runs each test file in a process of its own,
// so the first cruise of this file sets that set: an import of a `.js` path
// that resolves to TypeScript narrows it, and the next cruise must then fail
// instead of stopping silently at an `.mts` file.

describe('the check of followed sources', () => {
  const temporaryFolders = temporaryFoldersOfFile();

  it(
    'fails a cruise after a first import that narrowed the followable extensions',
    { timeout: 2 * cruiseTimeout },
    async () => {
      await cruiseCopy(
        { 'packages/cli/src/0-first.ts': "import './exit-codes.js';\n" },
        temporaryFolders,
      );
      await expect(
        cruiseCopy(
          {
            'packages/core/src/probe.ts':
              "import { value } from './probe-helper.mts';\n\nexport const probe = value;\n",
            'packages/core/src/probe-helper.mts': 'export const value = 1;\n',
          },
          temporaryFolders,
        ),
      ).rejects.toThrow(
        'dependency-cruiser did not follow packages/core/src/probe-helper.mts',
      );
    },
  );
});
