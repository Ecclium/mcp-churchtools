// Child process for tests/blocking-descriptors.test.mts. It loads the
// module its argument names, touches process.stderr for one control or
// loads nothing for the other, waits one turn of the event loop, then
// writes 4 MiB to fd 2 with writeSync
// and prints on fd 1 how many writes failed with EAGAIN. It uses the
// global process and imports only node:fs, because loading node:process
// would itself make fd 2 non-blocking (ADR 0054).
import { writeSync } from 'node:fs';

const [target = 'none'] = process.argv.slice(2);
// Reading the getter is what the control needs; it creates the stream.
if (target === 'stderr') {
  if (!process.stderr.writable) throw new Error('stderr is not writable');
} else if (target !== 'none') {
  await import(target);
}
// A warning that a module emits while it loads reaches process.stderr only
// on a later tick. One turn of the event loop lets such effects happen
// before the measurement.
await new Promise((resolve) => setImmediate(resolve));

writeSync(1, 'ready\n');
const chunk = new Uint8Array(65_536).fill(0x61);
const total = 4 * 1024 * 1024;
let again = 0;
let written = 0;
// A blocking descriptor waits here until the parent reads; a non-blocking
// one throws EAGAIN at once. A thousand of them are proof enough.
while (written < total && again < 1000) {
  try {
    written += writeSync(2, chunk, 0, Math.min(chunk.length, total - written));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
    again += 1;
  }
}
writeSync(1, `${JSON.stringify({ again, written })}\n`);
