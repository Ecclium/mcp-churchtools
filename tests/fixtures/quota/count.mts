// Child process for tests/quota-processes.test.mts. It counts against the
// store of quotas of core, run from source, as often as the test says,
// from the moment the test gives, with a pause after each count so that
// the other child gets the lock in between, and prints only the counts it
// got. Without a key it counts the read budget on 24.10.2026, with one the
// key on the day the test gives.
import process from 'node:process';

import type {
  IsoDate,
  QuotaKey,
} from '../../../packages/plugin-api/src/index.ts';
import { createFileQuotaStore } from '../../../packages/core/src/quota/file-store.ts';
import { quotaContext } from '../../../packages/testkit/src/quota/index.ts';

const [
  stateDir = '',
  times = '0',
  startAt = '0',
  pauseMs = '0',
  key = 'special_reads',
  onDay = '2026-10-24',
] = process.argv.slice(2);
const store = createFileQuotaStore({
  stateDir,
  clock: { now: () => Date.now() },
  pid: process.pid,
  host: 'test-host',
});
const ctx = quotaContext('default', 'user', 'stdio:local-stdio');
const day = onDay as IsoDate;

await new Promise((resolve) => {
  setTimeout(resolve, Math.max(0, Number(startAt) - Date.now()));
});
const counts: number[] = [];
for (let index = 0; index < Number(times); index += 1) {
  counts.push(await store.increment(ctx, key as QuotaKey, day));
  await new Promise((resolve) => {
    setTimeout(resolve, Number(pauseMs));
  });
}
process.stdout.write(`${JSON.stringify(counts)}\n`);
