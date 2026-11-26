import os from 'node:os';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

// The job architecture runs only the tests in this folder, so the proof from
// inside the network namespace in tests/workflows/network-namespace.test.mts
// does not run there. This test gives the job the same proof (ADR 0052).

describe('the architecture tests', () => {
  // Only in CI: the tests of the job architecture run inside the namespace.
  it.runIf(process.env['GITHUB_ACTIONS'] === 'true')(
    'run inside the network namespace in CI and see only loopback',
    () => {
      expect(process.env['ECCLIUM_NETNS']).toBe('loopback-only');
      expect(Object.keys(os.networkInterfaces())).toEqual(['lo']);
    },
  );
});
