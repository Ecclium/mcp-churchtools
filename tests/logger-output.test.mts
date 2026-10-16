import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The stderr writer of core calls writeSync on fd 2 with exactly four
// arguments, the line break in the same call (ADR 0054). A fake in the
// package tests cannot show what the real call does with a pipe or a file,
// so a child process, started from source with the network guard inherited
// through NODE_OPTIONS, writes three lines onto its real fd 2. The package
// tests check what a line holds; this test checks only how lines land.
// The inherited guard loads node:process, which makes fd 2 non-blocking
// when it is a pipe, so in the case of a pipe the lines land on a
// non-blocking fd 2; a file keeps its flags. Whether the modules of the
// packages keep fd 2 blocking is checked in
// tests/blocking-descriptors.test.mts (ADR 0054).
// Package tests cannot start child processes, so this test lives here.

const fixture = fileURLToPath(
  new URL('fixtures/logger/output.mts', import.meta.url),
);

const run = (stderr: 'pipe' | number) =>
  spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', stderr],
    timeout: 30_000,
  });

/**
 * The events and counts of the JSON lines, in their order. Node.js itself
 * may write other lines to stderr, such as a warning; readers skip them.
 */
const events = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      const { level, event, count } = JSON.parse(line) as Record<
        string,
        unknown
      >;
      return { level, event, count };
    });

const expected = [
  { level: 'info', event: 'first', count: 1 },
  { level: 'warn', event: 'second', count: 2 },
  { level: 'error', event: 'third', count: 3 },
];

describe('log lines on the real fd 2', () => {
  it('reach a pipe whole and in order, and nothing reaches stdout', () => {
    const child = run('pipe');
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('');
    expect(child.stderr.endsWith('\n')).toBe(true);
    expect(events(child.stderr)).toEqual(expected);
  });

  it('reach a file whole and in order, none written over another', () => {
    const folder = mkdtempSync(join(tmpdir(), 'ecclium-logger-'));
    try {
      // Written and read through the same descriptor, so that nothing can
      // swap the file between the run and the check.
      const fd = openSync(join(folder, 'stderr.log'), 'w+');
      let child: ReturnType<typeof run>;
      let text: string;
      try {
        child = run(fd);
        // Three short lines fit in one read from the start of the file.
        const bytes = Buffer.alloc(65_536);
        const count = readSync(fd, bytes, 0, bytes.length, 0);
        text = bytes.toString('utf8', 0, count);
      } finally {
        closeSync(fd);
      }
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(events(text)).toEqual(expected);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
