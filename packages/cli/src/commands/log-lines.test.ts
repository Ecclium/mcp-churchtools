import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  logChunkSize,
  type LogFileSystem,
  maxWaits,
  readLogLines,
  stdinName,
} from './log-lines.js';

const base = mkdtempSync(join(tmpdir(), 'ecclium-log-lines-'));

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

let files = 0;
const put = (content: string | Uint8Array): string => {
  files += 1;
  const path = join(base, `log-${String(files)}`);
  writeFileSync(path, content);
  return path;
};

const linesOf = (
  source: string,
  maxLineLength = 100,
  fs?: LogFileSystem,
): { read: boolean; lines: string[] } => {
  const lines: string[] = [];
  const read = readLogLines(
    source,
    maxLineLength,
    (line) => lines.push(line),
    fs,
  );
  return { read, lines };
};

const realFs = (changes: Partial<LogFileSystem> = {}): LogFileSystem => ({
  openSync: (path, flags) => openSync(path, flags),
  fstatSync,
  readSync,
  closeSync,
  pause: () => undefined,
  ...changes,
});

const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: /path/to/log`), { code });

describe('readLogLines', () => {
  it('reads every line, the last one also without a line break', () => {
    const path = put('first\r\nsecond\n\nlast');

    expect(linesOf(path)).toEqual({
      read: true,
      lines: ['first', 'second', '', 'last'],
    });
  });

  it('reads lines across the pieces it reads and skips lines too long', () => {
    const long = 'x'.repeat(logChunkSize + 5);
    const fits = 'y'.repeat(logChunkSize + 5);
    const path = put(`${long}\nshort\n${fits}\r\n${long}`);

    expect(linesOf(path, logChunkSize + 5)).toEqual({
      read: true,
      lines: [long, 'short', fits, long],
    });
    expect(linesOf(path, logChunkSize).lines).toEqual(['short']);
  });

  it('decodes UTF-8 and replaces bytes that are none', () => {
    const path = put(new Uint8Array([0xc3, 0xa4, 0x0a, 0xff, 0x41, 0x0a]));

    expect(linesOf(path).lines).toEqual(['ä', '�A']);
  });

  it('reads an empty log as no line and follows a link to a log', () => {
    const empty = put('');
    const link = join(base, 'link');
    symlinkSync(put('linked\n'), link);

    expect(linesOf(empty)).toEqual({ read: true, lines: [] });
    expect(linesOf(link)).toEqual({ read: true, lines: ['linked'] });
  });

  it('refuses a missing log and a folder', () => {
    const folder = join(base, 'folder');
    mkdirSync(folder);

    expect(linesOf(join(base, 'missing')).read).toBe(false);
    expect(linesOf(folder).read).toBe(false);
  });

  it('reads stdin for - and leaves it open', () => {
    const content = new TextEncoder().encode('from stdin\n');
    const opened: string[] = [];
    const closed: number[] = [];
    let done = false;
    const fs = realFs({
      openSync: (path) => {
        opened.push(path);
        return 9;
      },
      readSync: (fd, buffer) => {
        expect(fd).toBe(0);
        if (done) return 0;
        done = true;
        buffer.set(content);
        return content.length;
      },
      closeSync: (fd) => {
        closed.push(fd);
      },
    });

    expect(linesOf(stdinName, 100, fs)).toEqual({
      read: true,
      lines: ['from stdin'],
    });
    expect(opened).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('waits for stdin after EAGAIN and gives up after many waits', () => {
    const content = new TextEncoder().encode('late\n');
    let calls = 0;
    let pauses = 0;
    const fs = realFs({
      readSync: (_fd, buffer) => {
        calls += 1;
        if (calls <= 2) throw fsError('EAGAIN');
        if (calls === 3) {
          buffer.set(content);
          return content.length;
        }
        return 0;
      },
      pause: () => {
        pauses += 1;
      },
    });

    expect(linesOf(stdinName, 100, fs)).toEqual({
      read: true,
      lines: ['late'],
    });
    expect(pauses).toBe(2);

    let waits = 0;
    const never = realFs({
      readSync: () => {
        throw fsError('EAGAIN');
      },
      pause: () => {
        waits += 1;
      },
    });
    expect(linesOf(stdinName, 100, never).read).toBe(false);
    expect(waits).toBe(maxWaits);
  });

  it('gives false when a read fails or answers outside its contract', () => {
    const path = put('line\n');
    for (const readSync of [
      () => {
        throw fsError('EIO');
      },
      ...(['not an error', new Proxy({ code: 'EAGAIN' }, {})] as unknown[]).map(
        (thrown) => () => {
          throw thrown;
        },
      ),
      () => -1,
      () => logChunkSize + 1,
      () => 0.5,
    ]) {
      expect(linesOf(path, 100, realFs({ readSync })).read).toBe(false);
    }
  });

  it('gives false when fstat fails, and ignores a failed close', () => {
    const path = put('line\n');
    const fstat = realFs({
      fstatSync: () => {
        throw fsError('EIO');
      },
    });
    const close = realFs({
      closeSync: () => {
        throw fsError('EBADF');
      },
    });

    expect(linesOf(path, 100, fstat).read).toBe(false);
    expect(linesOf(path, 100, close)).toEqual({ read: true, lines: ['line'] });
  });

  it('passes on what the callback throws as a failed read', () => {
    const path = put('line\n');

    expect(
      readLogLines(path, 100, () => {
        throw new Error('callback');
      }),
    ).toBe(false);
  });
});
