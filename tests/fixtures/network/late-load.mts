// An attempt while the file loads, in a file whose only test is skipped, so
// that no hook of a test or of the file runs (ADR 0052). Only the proof in
// tests/support/no-network.test.mts runs this file, in a separate Vitest
// run, and expects the run to fail with the message of the guard. Hosts are
// placeholders for documentation only.
import dns from 'node:dns';
import { it } from 'vitest';

try {
  dns.lookup('example.org', () => undefined);
} catch {
  // Hidden while the file loads.
}

it.skip('a skipped test', () => undefined);
