/**
 * Manual smoke test for writing: the built server writes on the test
 * instance through its pipeline and its write guard, and the smoke test
 * checks every way of a confirmation, a conflict and every undo. It runs
 * only behind the guard of the test environment, after a person typed
 * «ja», prints only structure and never runs in CI (ADR 0049, ADR 0052).
 * It never sends a write itself. Usage: «Smoke-Test für das Schreiben» in
 * docs/betrieb/stdio.md.
 *
 * @packageDocumentation
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { hints } from './spike/lib/errors.mts';
import type { Io } from './spike/lib/output.mts';
import { askTerminal } from './spike/lib/probe.mts';
import { runSmokeWrite, smokeWriteExitCodes } from './smoke-write/main.mts';

if (import.meta.main) {
  const io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  // An error outside the course would print its message and stack, which
  // can hold data from an answer.
  // A crash and an interrupt end the process without the `finally` of the
  // course, so the folders it knows of go here: they hold the day keys, a
  // copy of the token and the audit files of the run. A server ends by
  // itself when its stdin closes with this process.
  const folders = new Set<string>();
  const removeFolders = (): void => {
    for (const folder of folders) {
      try {
        rmSync(folder, { recursive: true, force: true });
      } catch {
        // The next folder still goes.
      }
    }
  };
  const crash = (): void => {
    removeFolders();
    io.stderr(
      `Code: INTERN\n${hints.smokeIntern}\n${hints.schreibSmokeAbgebrochen}\n`,
    );
    process.exit(smokeWriteExitCodes.internal);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  const interrupt = (code: number) => (): void => {
    removeFolders();
    io.stderr(`${hints.schreibSmokeAbgebrochen}\n`);
    process.exit(code);
  };
  process.on('SIGINT', interrupt(130));
  process.on('SIGTERM', interrupt(143));
  process.exitCode = await runSmokeWrite({
    env: process.env,
    args: process.argv.slice(2),
    io,
    fetch,
    input: { isTerminal: process.stdin.isTTY, readLine: askTerminal },
    platform: process.platform,
    tmpdir: tmpdir(),
    track: (folder, exists) => {
      if (exists) folders.add(folder);
      else folders.delete(folder);
    },
    server: {
      executable: process.execPath,
      preArgs: [],
      entry: fileURLToPath(
        new URL('../packages/cli/dist/bin.js', import.meta.url),
      ),
    },
  });
}
