// Attempts that no single test reports (ADR 0052): one in a test marked as
// failing, where the error of the hook counts as the expected failure, and
// one after the hooks of the test have run. Both tests pass on their own;
// the guard must fail the file instead. Only the proof in
// tests/support/no-network.test.mts runs this file, in a separate Vitest
// process. Hosts are placeholders for documentation only.
import dns from 'node:dns';
import { it } from 'vitest';

it.fails('an attempt in a test marked as failing', async () => {
  try {
    await fetch('https://example.org/');
  } catch {
    // Hidden here, and the test is expected to fail anyway.
  }
});

it('an attempt after the test', ({ onTestFinished }) => {
  onTestFinished(() => {
    try {
      dns.lookup('example.org', () => undefined);
    } catch {
      // Hidden after the hooks of the test have run.
    }
  });
});
