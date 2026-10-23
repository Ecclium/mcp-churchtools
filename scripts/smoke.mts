/**
 * Manual smoke test of the built server against a real ChurchTools
 * instance. It reads only, prints only structure and never runs in CI
 * (ADR 0049, ADR 0052).
 *
 * Without `ECCLIUM_SMOKE_ALLOW_SEARCH` it calls only `ct_whoami`. With it,
 * and only after it has found the identification category of the test
 * instance, it also calls the two search tools with the term from
 * `ECCLIUM_SMOKE_QUERY`. Usage: «Smoke-Test» in docs/betrieb/stdio.md.
 *
 * @packageDocumentation
 */
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { hints } from './spike/lib/errors.mts';
import type { Io } from './spike/lib/output.mts';
import { runSmoke, smokeExitCodes } from './smoke/main.mts';

if (import.meta.main) {
  const io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  // An error outside the course would print its message and stack, which
  // can hold data from an answer.
  const crash = (): void => {
    io.stderr(`Code: INTERN\n${hints.smokeIntern}\n`);
    process.exit(smokeExitCodes.internal);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  process.exitCode = await runSmoke({
    env: process.env,
    args: process.argv.slice(2),
    io,
    fetch,
    platform: process.platform,
    tmpdir: tmpdir(),
    server: {
      executable: process.execPath,
      preArgs: [],
      entry: fileURLToPath(
        new URL('../packages/cli/dist/bin.js', import.meta.url),
      ),
    },
  });
}
