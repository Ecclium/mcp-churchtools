import { describe, expect, it } from 'vitest';

import {
  cruiseCopy,
  cruiseTimeout,
  temporaryFoldersOfFile,
} from './dependency-cases.mts';

// dependency-cruiser keeps the set of followable extensions that the first
// import it resolves in a process gives (assertCodeFollowed in
// dependency-cases.mts). Vitest runs each test file with a fresh state of its
// modules, so the first cruise of this file sets that set: an import of a
// `.js` path that resolves to TypeScript narrows it, and each later cruise
// must then fail instead of stopping silently at a file of code.

describe('the check of followed code', () => {
  const temporaryFolders = temporaryFoldersOfFile();

  it(
    'fails cruises after a first import that narrowed the followable extensions',
    { timeout: 3 * cruiseTimeout },
    async () => {
      await cruiseCopy(
        { 'packages/cli/src/0-first.ts': "import './exit-codes.js';\n" },
        temporaryFolders,
      );
      // An .mts file in a package.
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
      // An .mjs file outside the packages that imports back: with the set
      // narrowed, only no-import-outside-packages would fire and the cycle
      // behind it would stay hidden.
      await expect(
        cruiseCopy(
          {
            'packages/core/src/forbidden.ts':
              "import '../../../tests/helper.mjs';\n",
            'tests/helper.mjs': "import '../packages/core/src/forbidden.ts';\n",
          },
          temporaryFolders,
        ),
      ).rejects.toThrow('dependency-cruiser did not follow tests/helper.mjs');
    },
  );
});
