// An attempt from a timer that fires after the last test of the file, when
// no hook of a test is left to see it (ADR 0052). Only the proof in
// tests/support/no-network.test.mts runs this file, in a separate Vitest
// run, and expects the run to fail with the message of the guard. Hosts are
// placeholders for documentation only.
import dns from 'node:dns';
import { it } from 'vitest';

it('starts a timer that tries later', () => {
  setTimeout(() => {
    try {
      dns.lookup('example.org', () => undefined);
    } catch {
      // Hidden after the test.
    }
  }, 0);
});
