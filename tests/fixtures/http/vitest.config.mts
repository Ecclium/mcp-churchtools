import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import workspace from '../../../vitest.config.mts';

// Runs only the fixtures of the HTTP transport, with every other setting of
// the workspace, its network guard included (ADR 0052). Vitest has no
// option to run a file outside the include pattern, so the test needs this
// file. No mergeConfig: it joins arrays, so the include list of the
// workspace would come back.
export default defineConfig({
  ...workspace,
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    ...workspace.test,
    include: [
      'tests/fixtures/http/trusted.mts',
      'tests/fixtures/http/untrusted.mts',
    ],
  },
});
