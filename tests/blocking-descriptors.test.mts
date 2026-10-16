import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

// The writers of the packages call writeSync on fd 2 and rely on it to
// block while a reader is slow (ADR 0053, ADR 0054). Loading some built-in
// modules turns fd 2 non-blocking, and then lines get lost. A child
// process loads one module, writes 4 MiB to fd 2 while this test does not
// read it for a second, and counts EAGAIN. It starts with an empty
// environment: the network guard, inherited through NODE_OPTIONS, loads
// node:process and would make every case non-blocking (ADR 0052).
//
// What a red case means:
// - A control fails: the child cannot show a blocking or a non-blocking
//   descriptor on this platform or in this window. That is a problem of
//   the test, not of the code.
// - node:util or node:process fails: Node.js changed, and the facts in
//   ADR 0054 are out of date. Update the docs.
// - node:util/types fails: the type checks of the core and the command
//   line come from it, so the writers would lose lines. The code needs
//   another way to make those checks, not only a change of the docs.
// - A module of the packages fails: it loads something that makes fd 2
//   non-blocking. Fix the import.
// Only modules without relative imports can be loaded from source. The rest
// of the packages relies on the architecture rules, which see imports, not
// what a module does while it loads.

const fixture = fileURLToPath(
  new URL('fixtures/blocking/write.mts', import.meta.url),
);

const source = (path: string): string =>
  pathToFileURL(fileURLToPath(new URL(`../${path}`, import.meta.url))).href;

interface Result {
  readonly again: number;
  readonly written: number;
}

/** Runs the child for one target and gives what it reported on fd 1. */
const run = (target: string): Promise<Result> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, target], {
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // No listener on stderr yet: a paused stream stops reading, so the
    // pipe fills and the child has to wait or meets EAGAIN.
    child.stderr.pause();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      child.stderr.on('data', () => undefined);
      child.stderr.resume();
    };
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      const ready = !out.includes('ready\n');
      out += text;
      if (ready && out.includes('ready\n')) setTimeout(release, 1000);
    });
    child.on('exit', release);
    child.on('error', reject);
    // The result is read at the end of stdout, not at exit, when the
    // streams may still be open.
    child.stdout.on('end', () => {
      const line = out.trim().split('\n').at(-1) ?? '';
      try {
        resolve(JSON.parse(line) as Result);
      } catch {
        reject(new Error(`no result from the child for ${target}`));
      }
    });
  });

const timeout = 30_000;

describe('fd 2 after loading a module', () => {
  it.concurrent(
    'blocks when the child loads nothing',
    async () => {
      expect((await run('none')).again).toBe(0);
    },
    timeout,
  );

  it.concurrent(
    'does not block once the child touches process.stderr',
    async () => {
      expect((await run('stderr')).again).toBeGreaterThan(0);
    },
    timeout,
  );

  it.concurrent.each(['node:util', 'node:process'])(
    'does not block after loading %s',
    async (module) => {
      expect((await run(module)).again).toBeGreaterThan(0);
    },
    timeout,
  );

  it.concurrent(
    'does not block after a module that warns while it loads',
    async () => {
      const warning = pathToFileURL(
        fileURLToPath(new URL('fixtures/blocking/warn.mts', import.meta.url)),
      ).href;
      expect((await run(warning)).again).toBeGreaterThan(0);
    },
    timeout,
  );

  it.concurrent(
    'blocks after loading node:util/types',
    async () => {
      expect((await run('node:util/types')).again).toBe(0);
    },
    timeout,
  );

  it.concurrent.each([
    'packages/cli/src/environment.ts',
    'packages/cli/src/send.ts',
  ])(
    'blocks after loading %s from source',
    async (path) => {
      const result = await run(source(path));
      expect(result.again).toBe(0);
      expect(result.written).toBe(4 * 1024 * 1024);
    },
    timeout,
  );
});
