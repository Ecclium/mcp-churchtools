import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import workspace from '../../../vitest.config.mts';

// Runs only the network fixtures, with every other setting of the workspace,
// its setup files included (ADR 0052). Vitest has no option to run a file
// outside the include pattern, so the proof needs this file. No mergeConfig:
// it joins arrays, so the include list of the workspace would come back and
// the run would start the proof again.
export default defineConfig({
  ...workspace,
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    ...workspace.test,
    include: [
      'tests/fixtures/network/connects.mts',
      'tests/fixtures/network/environment.mts',
      'tests/fixtures/network/hidden.mts',
      'tests/fixtures/network/late-load.mts',
      'tests/fixtures/network/loopback.mts',
    ],
  },
});
