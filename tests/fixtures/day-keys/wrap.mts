// Child process for tests/day-keys-processes.test.mts. It wraps one key
// for each of the days the test names with the day keys of core, run from
// source, from the moment the test gives, and prints the wrapped keys with
// the synthetic keys they hold. Both children wrap for the same new days at
// the same moment, so that they race for every day key.
import process from 'node:process';

import type { IsoDate } from '../../../packages/plugin-api/src/index.ts';
import { createFileDayKeys } from '../../../packages/core/src/keys/day-keys.ts';
import { quotaContext } from '../../../packages/testkit/src/quota/index.ts';

const [keysDir = '', days = '', startAt = '0', seed = '0'] =
  process.argv.slice(2);
const keys = createFileDayKeys({ keysDir, pid: process.pid });
const ctx = quotaContext('default', 'user', 'stdio:local-stdio');

await new Promise((resolve) => {
  setTimeout(resolve, Math.max(0, Number(startAt) - Date.now()));
});
const wrapped = [];
for (const day of days.split(',')) {
  const key = Uint8Array.from(
    { length: 32 },
    (_, index) => (Number(seed) + index) % 256,
  );
  wrapped.push({
    key: Buffer.from(key).toString('hex'),
    wrapped: await keys.wrap(ctx, 'snapshot', day as IsoDate, key),
  });
}
process.stdout.write(`${JSON.stringify(wrapped)}\n`);
