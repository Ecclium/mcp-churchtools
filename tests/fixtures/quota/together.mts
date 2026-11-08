// What the children of tests/quota-processes.test.mts share: a clock that
// runs from noon of 24.10.2026, so that every child counts on that day
// whenever the test runs and no midnight falls between two of them, while
// the wait for a lock passes as it would; and a start together, so that
// the children count at the same time however long each took to load the
// source, also on a loaded runner.
import process from 'node:process';

import type { Clock } from '../../../packages/plugin-api/src/index.ts';

/** Noon of the day every child counts on, in UTC. */
export const noon = Date.UTC(2026, 9, 24, 12);

/**
 * A clock that runs from noon of 24.10.2026 on, from the moment it is made.
 *
 * @returns The clock.
 */
export function clockFromNoon(): Clock {
  const began = Date.now();
  return Object.freeze({ now: () => noon + (Date.now() - began) });
}

/**
 * Says on stdout that the child is ready and waits until the test writes
 * to its stdin, which the test does for every child at once when all of
 * them are ready. The end of stdin starts the child as well, so that it
 * never waits for a test that is gone.
 *
 * @returns Once the child may start.
 */
export async function startTogether(): Promise<void> {
  process.stdout.write('ready\n');
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => {
      resolve();
    });
    process.stdin.once('end', () => {
      resolve();
    });
  });
  process.stdin.destroy();
}
