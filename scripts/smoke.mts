/**
 * Manual smoke test of the built server against a real ChurchTools
 * instance. It reads only, prints only structure and never runs in CI
 * (ADR 0049, ADR 0052).
 *
 * Without `ECCLIUM_SMOKE_ALLOW_SEARCH` it reads from ChurchTools only
 * through `ct_whoami`, besides the docs tools, which read only the docs
 * index of the build. With it, and only after it has found the
 * identification category of the test instance, it also calls the other
 * read tools, the searches with the term from `ECCLIUM_SMOKE_QUERY`, those
 * of songs with the one from `ECCLIUM_SMOKE_SONG_QUERY` when it is set, and
 * with `ECCLIUM_SMOKE_ALLOW_API` as well the escape hatch. Usage:
 * «Smoke-Test» in docs/betrieb/stdio.md.
 *
 * @packageDocumentation
 */
import { rmSync } from 'node:fs';
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
  // An interrupt ends the process without the `finally` of the course, so
  // the folders of state it knows of go here. The server ends by itself
  // when its stdin closes with this process.
  const folders = new Set<string>();
  const interrupt = (code: number) => (): void => {
    for (const folder of folders)
      rmSync(folder, { recursive: true, force: true });
    process.exit(code);
  };
  process.on('SIGINT', interrupt(130));
  process.on('SIGTERM', interrupt(143));
  process.exitCode = await runSmoke({
    env: process.env,
    args: process.argv.slice(2),
    io,
    fetch,
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
