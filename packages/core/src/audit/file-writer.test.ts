import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isEventName } from '../logger/index.js';
import {
  auditFileCodes,
  type AuditFileStats,
  type AuditFileSystem,
  type AuditFileWriter,
  maxNameAttempts,
  maxReopens,
  maxWriteAttempts,
  openAuditFile,
} from './file-writer.js';

// Real folders and files in a temporary folder cover what the disk can
// show: modes, links, names in use. Injected file functions cover what a
// test cannot build there, such as a descriptor below 3, another owner or
// a path that leads to another file after the open.

const stateDir = '/path/to/state';
const folderPath = `${stateDir}/audit`;
const pid = 4242;
const clock = { now: () => Date.UTC(2026, 9, 23, 5, 52, 30, 123) };
const nameOf = (number: number): string =>
  `audit-2026-10-23-055230-${String(pid)}-${String(number)}.jsonl`;

const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: open '${folderPath}'`), { code });

// Distinct bits, so that a missing flag changes the sum.
const fakeConstants = Object.freeze({
  O_RDONLY: 1,
  O_WRONLY: 2,
  O_APPEND: 4,
  O_CREAT: 8,
  O_EXCL: 16,
  O_NOFOLLOW: 32,
  O_NOCTTY: 64,
  O_DIRECTORY: 128,
});
const folderFlags = 1 | 128 | 32;
const fileFlags = 2 | 4 | 8 | 16 | 32 | 64;
const folderFd = 10;

const stats = (fields: Partial<AuditFileStats> & { kind: 'dir' | 'file' }) => {
  const { kind, ...rest } = fields;
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    uid: 1000,
    mode: kind === 'dir' ? 0o40700 : 0o100600,
    nlink: kind === 'dir' ? 2 : 1,
    dev: 1,
    ino: kind === 'dir' ? 100 : 200,
    ...rest,
  };
};

interface Hooks {
  readonly mkdir?: (path: string) => void;
  readonly open?: (path: string, flags: number) => number | undefined;
  readonly fstat?: (fd: number) => AuditFileStats | undefined;
  readonly lstat?: (path: string) => AuditFileStats | undefined;
  readonly close?: (fd: number) => void;
  /**
   * How many of the bytes a call takes, or undefined for all of them. It
   * may throw like writeSync.
   */
  readonly write?: (fd: number, bytes: Uint8Array) => number | undefined;
  readonly getuid?: () => number | undefined;
  readonly constants?: AuditFileSystem['constants'];
}

interface Fake {
  readonly fs: AuditFileSystem;
  readonly calls: string[];
  readonly closed: number[];
  /** What reached each descriptor, as text. */
  readonly content: (fd: number) => string;
  /** The number of arguments of each call of writeSync. */
  readonly arities: number[];
}

/**
 * File functions in memory: a folder audit with descriptor 10 and new
 * files from descriptor 11 up. A hook replaces one function; returning
 * undefined falls back to the default.
 */
const fake = (hooks: Hooks = {}): Fake => {
  const calls: string[] = [];
  const closed: number[] = [];
  const arities: number[] = [];
  const bytesOf = new Map<number, number[]>();
  const fdOfPath = new Map<string, number>();
  let nextFd = 11;
  const fs: AuditFileSystem = {
    mkdirSync: (path, mode) => {
      calls.push(`mkdir ${path} ${mode.toString(8)}`);
      hooks.mkdir?.(path);
    },
    openSync: (path, flags, mode) => {
      calls.push(`open ${path} ${String(flags)} ${mode?.toString(8) ?? '-'}`);
      const given = hooks.open?.(path, flags);
      if (given !== undefined) {
        fdOfPath.set(path, given);
        return given;
      }
      if (path === folderPath) return folderFd;
      const fd = nextFd;
      nextFd += 1;
      fdOfPath.set(path, fd);
      return fd;
    },
    fstatSync: (fd) =>
      hooks.fstat?.(fd) ??
      (fd === folderFd
        ? stats({ kind: 'dir' })
        : stats({ kind: 'file', ino: 200 + fd })),
    lstatSync: (path) =>
      hooks.lstat?.(path) ??
      (path === folderPath
        ? stats({ kind: 'dir' })
        : stats({ kind: 'file', ino: 200 + (fdOfPath.get(path) ?? 0) })),
    writeSync: (...args: unknown[]) => {
      arities.push(args.length);
      const [fd, buffer, offset, length] = args as [
        number,
        Uint8Array,
        number,
        number,
      ];
      calls.push(`write ${String(fd)} ${String(offset)} ${String(length)}`);
      const bytes = buffer.subarray(offset, offset + length);
      const taken = hooks.write?.(fd, bytes) ?? length;
      // A count outside the contract writes nothing, as a bad answer of a
      // call that did not happen.
      const kept =
        Number.isInteger(taken) && taken > 0 && taken <= length ? taken : 0;
      const target = bytesOf.get(fd) ?? [];
      target.push(...bytes.subarray(0, kept));
      bytesOf.set(fd, target);
      return taken;
    },
    closeSync: (fd) => {
      closed.push(fd);
      hooks.close?.(fd);
    },
    getuid: hooks.getuid ?? (() => 1000),
    constants: hooks.constants ?? fakeConstants,
  };
  return {
    fs,
    calls,
    closed,
    arities,
    content: (fd) =>
      new TextDecoder().decode(new Uint8Array(bytesOf.get(fd) ?? [])),
  };
};

const fileFd = 11;

/** An open writer over the fake, with the fake. */
const opened = (
  hooks: Hooks = {},
  time: { now: () => number } = clock,
): Fake & { writer: AuditFileWriter } => {
  const files = fake(hooks);
  const result = openAuditFile({ stateDir, clock: time, pid, fs: files.fs });
  if (!result.ok) throw new Error(result.code);
  return { ...files, writer: result.writer };
};

/** Answers of writeSync in turn, then all of each call. */
const script = (
  ...answers: (number | string)[]
): ((fd: number, bytes: Uint8Array) => number | undefined) => {
  return (_fd, bytes) => {
    const answer = answers.shift();
    if (typeof answer === 'string') throw fsError(answer);
    return answer === -2 ? bytes.length - 1 : answer;
  };
};

const codeOf = (hooks: Hooks): string => {
  const result = openAuditFile({ stateDir, clock, pid, fs: fake(hooks).fs });
  return result.ok ? 'ok' : result.code;
};

describe('openAuditFile with file functions', () => {
  it('creates the folder, opens a new file and checks both', () => {
    const { fs, calls, closed } = fake();
    const result = openAuditFile({ stateDir, clock, pid, fs });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      `mkdir ${folderPath} 700`,
      `open ${folderPath} ${String(folderFlags)} -`,
      `open ${folderPath}/${nameOf(1)} ${String(fileFlags)} 600`,
    ]);
    // The folder is closed once checked, the file stays open.
    expect(closed).toEqual([folderFd]);
  });

  it('takes a folder audit that is already there', () => {
    expect(
      codeOf({
        mkdir: () => {
          throw fsError('EEXIST');
        },
      }),
    ).toBe('ok');
  });

  it('puts the folder audit of the root folder at /audit', () => {
    const { fs, calls } = fake({
      open: (path) => (path === '/audit' ? 10 : undefined),
      lstat: (path) => (path === '/audit' ? stats({ kind: 'dir' }) : undefined),
    });
    expect(openAuditFile({ stateDir: '/', clock, pid, fs }).ok).toBe(true);
    expect(calls[0]).toBe('mkdir /audit 700');
  });

  it.each([
    ['no user ID', { getuid: () => undefined }],
    ...(
      [
        'O_RDONLY',
        'O_WRONLY',
        'O_APPEND',
        'O_CREAT',
        'O_EXCL',
        'O_NOFOLLOW',
        'O_NOCTTY',
        'O_DIRECTORY',
      ] as const
    ).map(
      (flag) =>
        [
          `no ${flag}`,
          { constants: { ...fakeConstants, [flag]: undefined } },
        ] as const,
    ),
  ] as const)(
    'refuses the platform with %s before any call',
    (_name, hooks) => {
      const { fs, calls } = fake(hooks);
      expect(openAuditFile({ stateDir, clock, pid, fs })).toEqual({
        ok: false,
        code: 'audit_file_platform',
      });
      expect(calls).toEqual([]);
    },
  );

  it.each(['EACCES', 'ENOENT', 'EROFS', 'ENOSPC'])(
    'refuses the folder when mkdir fails with %s',
    (code) => {
      expect(
        codeOf({
          mkdir: () => {
            throw fsError(code);
          },
        }),
      ).toBe('audit_file_folder_unavailable');
    },
  );

  it.each([
    ['ELOOP', 'audit_file_folder_unsafe'],
    ['ENOTDIR', 'audit_file_folder_unsafe'],
    ['EMLINK', 'audit_file_folder_unsafe'],
    ['EACCES', 'audit_file_folder_unavailable'],
  ])('maps %s on opening the folder to %s', (code, expected) => {
    expect(
      codeOf({
        open: (path) => {
          if (path === folderPath) throw fsError(code);
          return undefined;
        },
      }),
    ).toBe(expected);
  });

  it.each([
    ['no folder', stats({ kind: 'file' })],
    ['another owner', stats({ kind: 'dir', uid: 0 })],
    ['rights for the group', stats({ kind: 'dir', mode: 0o40750 })],
    ['rights for others', stats({ kind: 'dir', mode: 0o40705 })],
  ])('refuses a folder with %s and closes it', (_name, folder) => {
    const { fs, closed, calls } = fake({
      fstat: (fd) => (fd === folderFd ? folder : undefined),
    });
    expect(openAuditFile({ stateDir, clock, pid, fs })).toMatchObject({
      code: 'audit_file_folder_unsafe',
    });
    expect(closed).toEqual([folderFd]);
    expect(calls.some((call) => call.includes('.jsonl'))).toBe(false);
  });

  it('refuses a folder whose fstat throws, and one below descriptor 3', () => {
    expect(
      codeOf({
        fstat: (fd) => {
          if (fd === folderFd) throw fsError('EIO');
          return undefined;
        },
      }),
    ).toBe('audit_file_folder_unsafe');
    const { fs, closed } = fake({
      open: (path) => (path === folderPath ? 2 : undefined),
    });
    expect(openAuditFile({ stateDir, clock, pid, fs })).toMatchObject({
      code: 'audit_file_folder_unsafe',
    });
    expect(closed).toEqual([2]);
  });

  it('keeps the result of the folder when closing it throws', () => {
    expect(
      codeOf({
        close: (fd) => {
          if (fd === folderFd) throw fsError('EIO');
        },
      }),
    ).toBe('ok');
  });

  it.each(['EEXIST', 'ELOOP', 'EMLINK'])(
    'takes the next number when the name is in use with %s',
    (code) => {
      const { fs, calls } = fake({
        open: (path) => {
          if (path.endsWith(nameOf(1))) throw fsError(code);
          return undefined;
        },
      });
      expect(openAuditFile({ stateDir, clock, pid, fs }).ok).toBe(true);
      expect(calls.filter((call) => call.includes('.jsonl'))).toEqual([
        `open ${folderPath}/${nameOf(1)} ${String(fileFlags)} 600`,
        `open ${folderPath}/${nameOf(2)} ${String(fileFlags)} 600`,
      ]);
    },
  );

  it(`gives up after ${String(maxNameAttempts)} names in use`, () => {
    const { fs, calls } = fake({
      open: (path) => {
        if (path.endsWith('.jsonl')) throw fsError('EEXIST');
        return undefined;
      },
    });
    expect(openAuditFile({ stateDir, clock, pid, fs })).toMatchObject({
      code: 'audit_file_unavailable',
    });
    expect(calls.filter((call) => call.includes('.jsonl'))).toHaveLength(
      maxNameAttempts,
    );
  });

  it.each([
    ['EACCES', fsError('EACCES')],
    ['ENOSPC', fsError('ENOSPC')],
    ['a value that is no error', 'EEXIST'],
    ['a proxy', new Proxy(fsError('EEXIST'), {})],
  ])('refuses the file when open fails with %s', (_name, error: unknown) => {
    expect(
      codeOf({
        open: (path) => {
          if (path.endsWith('.jsonl')) throw error;
          return undefined;
        },
      }),
    ).toBe('audit_file_unavailable');
  });

  it.each<[string, Hooks]>([
    [
      'a descriptor below 3',
      { open: (path: string) => (path.endsWith('.jsonl') ? 2 : undefined) },
    ],
    [
      'no regular file',
      {
        fstat: (fd: number) =>
          fd === 11 ? stats({ kind: 'dir', ino: 211 }) : undefined,
      },
    ],
    [
      'another owner',
      {
        fstat: (fd: number) =>
          fd === 11 ? stats({ kind: 'file', ino: 211, uid: 0 }) : undefined,
      },
    ],
    [
      'rights for others',
      {
        fstat: (fd: number) =>
          fd === 11
            ? stats({ kind: 'file', ino: 211, mode: 0o100644 })
            : undefined,
      },
    ],
    [
      'a second link',
      {
        fstat: (fd: number) =>
          fd === 11 ? stats({ kind: 'file', ino: 211, nlink: 2 }) : undefined,
      },
    ],
    [
      'a path that leads to another file',
      {
        lstat: (path: string) =>
          path.endsWith('.jsonl')
            ? stats({ kind: 'file', ino: 999 })
            : undefined,
      },
    ],
    [
      'a path on another device',
      {
        lstat: (path: string) =>
          path.endsWith('.jsonl')
            ? stats({ kind: 'file', ino: 211, dev: 2 })
            : undefined,
      },
    ],
    [
      'a folder swapped after the check',
      {
        lstat: (path: string) =>
          path === folderPath ? stats({ kind: 'dir', ino: 101 }) : undefined,
      },
    ],
    [
      'a folder moved to another device',
      {
        lstat: (path: string) =>
          path === folderPath ? stats({ kind: 'dir', dev: 2 }) : undefined,
      },
    ],
    [
      'an fstat that throws',
      {
        fstat: (fd: number) => {
          if (fd === 11) throw fsError('EIO');
          return undefined;
        },
      },
    ],
  ])('refuses and closes a file with %s', (_name, hooks) => {
    const { fs, closed } = fake(hooks);
    expect(openAuditFile({ stateDir, clock, pid, fs })).toMatchObject({
      code: 'audit_file_unsafe',
    });
    // The folder after its check, then the refused file.
    expect(closed).toEqual([folderFd, 'open' in hooks ? 2 : 11]);
  });

  it('refuses the file when closing a refused file throws', () => {
    expect(
      codeOf({
        fstat: (fd) =>
          fd === 11 ? stats({ kind: 'file', ino: 211, nlink: 0 }) : undefined,
        close: (fd) => {
          if (fd === 11) throw fsError('EIO');
        },
      }),
    ).toBe('audit_file_unsafe');
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('clock');
      },
    ],
    ['gives no number', () => Number.NaN],
    ['gives a time out of range', () => 8.64e15 + 1],
  ])('refuses before any call when the clock %s', (_name, now) => {
    const { fs, calls } = fake();
    expect(openAuditFile({ stateDir, clock: { now }, pid, fs })).toMatchObject({
      code: 'audit_file_unavailable',
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ['a relative folder', { stateDir: 'state' }],
    ['a folder with a slash at the end', { stateDir: `${stateDir}/` }],
    ['no string', { stateDir: 1 }],
    ['no clock', { clock: {} }],
    ['a clock of null', { clock: null }],
    ['a process ID of 0', { pid: 0 }],
    ['a process ID that is no integer', { pid: 1.5 }],
  ])('throws for %s', (_name, change) => {
    expect(() =>
      openAuditFile({
        stateDir,
        clock,
        pid,
        fs: fake().fs,
        ...change,
      } as Parameters<typeof openAuditFile>[0]),
    ).toThrow(
      new TypeError(
        'The audit file needs a folder of state, a clock and a process ID.',
      ),
    );
  });

  it('closes the file once and stays closed', () => {
    const { fs, closed } = fake();
    const result = openAuditFile({ stateDir, clock, pid, fs });
    if (!result.ok) throw new Error('not opened');
    expect(result.writer.counts().closed).toBe(false);
    result.writer.close();
    result.writer.close();
    expect(closed).toEqual([folderFd, 11]);
    expect(result.writer.counts().closed).toBe(true);
  });

  it('is closed for good when closing throws', () => {
    const { fs } = fake({
      close: (fd) => {
        if (fd === 11) throw fsError('EIO');
      },
    });
    const result = openAuditFile({ stateDir, clock, pid, fs });
    if (!result.ok) throw new Error('not opened');
    expect(() => {
      result.writer.close();
    }).not.toThrow();
    expect(result.writer.counts().closed).toBe(true);
  });

  it('gives frozen results without a prototype', () => {
    const opened = openAuditFile({ stateDir, clock, pid, fs: fake().fs });
    const refused = openAuditFile({
      stateDir,
      clock,
      pid,
      fs: fake({ getuid: () => undefined }).fs,
    });
    for (const result of [opened, refused]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.getPrototypeOf(result)).toBeNull();
    }
    if (opened.ok) {
      expect(Object.isFrozen(opened.writer)).toBe(true);
      expect(Object.isFrozen(opened.writer.counts())).toBe(true);
    }
  });
});

describe('the writer of the audit file', () => {
  it('appends each line with its line break, in one call', () => {
    const { writer, content, arities, calls } = opened();
    expect(writer.write('{"v":1}')).toBe(true);
    expect(writer.write('{"v":2}')).toBe(true);
    expect(content(fileFd)).toBe('{"v":1}\n{"v":2}\n');
    // Exactly four arguments: a position would write over the file.
    expect(arities).toEqual([4, 4]);
    expect(calls.filter((call) => call.startsWith('write'))).toEqual([
      `write ${String(fileFd)} 0 8`,
      `write ${String(fileFd)} 0 8`,
    ]);
    expect(writer.counts()).toEqual({
      written: 2,
      failed: 0,
      partial: 0,
      rejected: 0,
      reopened: 0,
      closed: false,
    });
  });

  it.each([
    ['an empty line', ''],
    ['a line break', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['a tab', 'a\tb'],
    ['an umlaut', '\u00fc'],
    ['a line separator', 'a\u2028b'],
    ['a line too long', 'a'.repeat(65_537)],
    ['no string', 1],
  ])('refuses %s without a call', (_name, line) => {
    const { writer, calls } = opened();
    expect(writer.write(line as string)).toBe(false);
    expect(writer.counts().rejected).toBe(1);
    expect(calls.some((call) => call.startsWith('write'))).toBe(false);
  });

  it('takes a line of 65536 characters', () => {
    expect(opened().writer.write('a'.repeat(65_536))).toBe(true);
  });

  it('continues a partial write at its offset', () => {
    const { writer, content, calls } = opened({ write: script(3) });
    expect(writer.write('{"v":1}')).toBe(true);
    expect(content(fileFd)).toBe('{"v":1}\n');
    expect(calls.filter((call) => call.startsWith('write'))).toEqual([
      `write ${String(fileFd)} 0 8`,
      `write ${String(fileFd)} 3 5`,
    ]);
  });

  it.each([0, -1, Number.NaN, 1.5, 9])(
    'counts %s bytes from writeSync as no progress',
    (count) => {
      const { writer, content } = opened({
        write: script(count, count, count),
      });
      expect(writer.write('{"v":1}')).toBe(true);
      expect(content(fileFd)).toBe('{"v":1}\n');
    },
  );

  it(`gives up after ${String(maxWriteAttempts)} calls without progress`, () => {
    const { writer, content, calls } = opened({ write: script(0, 0, 0, 0) });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(calls.filter((call) => call.startsWith('write'))).toHaveLength(
      maxWriteAttempts,
    );
    expect(content(fileFd)).toBe('');
    expect(writer.counts()).toMatchObject({ failed: 1, partial: 0 });
    // Nothing reached the file, so the next line needs no repair.
    expect(writer.write('{"v":2}')).toBe(true);
    expect(content(fileFd)).toBe('{"v":2}\n');
  });

  it.each(['ENOSPC', 'EDQUOT', 'EIO'])(
    'loses the line on %s and writes the next one',
    (code) => {
      const { writer, content } = opened({ write: script(code) });
      expect(writer.write('{"v":1}')).toBe(false);
      expect(writer.write('{"v":2}')).toBe(true);
      expect(content(fileFd)).toBe('{"v":2}\n');
      expect(writer.counts()).toMatchObject({ written: 1, failed: 1 });
    },
  );

  it('stops on a thrown value that is no error', () => {
    const { writer } = opened({
      write: () => {
        throw new Proxy(fsError('EAGAIN'), {});
      },
    });
    expect(writer.write('{"v":1}')).toBe(false);
  });

  it('closes a piece of a line with a tilde at once', () => {
    const { writer, content } = opened({ write: script(4, 'ENOSPC') });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(content(fileFd)).toBe('{"v"~\n');
    expect(writer.counts()).toMatchObject({ failed: 1, partial: 1 });
    expect(writer.write('{"v":2}')).toBe(true);
    expect(content(fileFd)).toBe('{"v"~\n{"v":2}\n');
  });

  it('never turns a piece that lacks only its break into a valid line', () => {
    const { writer, content } = opened({ write: script(-2, 'EIO') });
    expect(writer.write('{"v":1}')).toBe(false);
    const [piece] = content(fileFd).split('\n');
    expect(piece).toBe('{"v":1}~');
    expect(() => JSON.parse(piece ?? '') as unknown).toThrow(SyntaxError);
  });

  it('repairs a piece with the next line when the repair fails', () => {
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', 'ENOSPC'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(content(fileFd)).toBe('{"v"');
    expect(writer.write('{"v":2}')).toBe(true);
    expect(content(fileFd)).toBe('{"v"~\n{"v":2}\n');
  });

  it('keeps a piece invalid when the repair stops after the tilde', () => {
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', 1, 'EIO'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(content(fileFd)).toBe('{"v"~');
    expect(writer.write('{"v":2}')).toBe(true);
    expect(content(fileFd)).toBe('{"v"~~\n{"v":2}\n');
  });

  it('repairs again after a line of which only the tilde went out', () => {
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', 'ENOSPC', 1, 'EIO'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(writer.write('{"v":2}')).toBe(false);
    expect(content(fileFd)).toBe('{"v"~');
    expect(writer.counts()).toMatchObject({ failed: 2, partial: 1 });
    expect(writer.write('{"v":3}')).toBe(true);
    expect(content(fileFd)).toBe('{"v"~~\n{"v":3}\n');
  });

  it('needs no repair after a line of which only the repair went out', () => {
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', 'ENOSPC', 2, 'ENOSPC'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(writer.write('{"v":2}')).toBe(false);
    expect(content(fileFd)).toBe('{"v"~\n');
    expect(writer.counts()).toMatchObject({ failed: 2, partial: 1 });
    expect(writer.write('{"v":3}')).toBe(true);
    expect(content(fileFd)).toBe('{"v"~\n{"v":3}\n');
  });

  it('counts a line after close as lost, without a call', () => {
    const { writer, calls } = opened();
    writer.close();
    expect(writer.write('{"v":1}')).toBe(false);
    expect(calls.some((call) => call.startsWith('write'))).toBe(false);
    expect(writer.counts()).toMatchObject({ failed: 1, closed: true });
  });
});

describe('the writer of the audit file and a new file', () => {
  const day = 24 * 60 * 60 * 1000;
  const opens = (calls: readonly string[]): string[] =>
    calls.filter((call) => call.startsWith('open') && call.includes('.jsonl'));

  /** A fake whose files can be deleted, with fstat showing no link. */
  const deletable = (hooks: Hooks = {}) => {
    const deleted = new Set<number>();
    const files = opened({
      fstat: (fd) =>
        deleted.has(fd)
          ? stats({ kind: 'file', ino: 200 + fd, nlink: 0 })
          : undefined,
      ...hooks,
    });
    return { ...files, deleted };
  };

  it('opens a new file when the file was deleted, and closes the old one', () => {
    const { writer, deleted, closed, content, calls } = deletable();
    deleted.add(fileFd);
    expect(writer.write('{"v":1}')).toBe(true);
    expect(closed).toEqual([folderFd, fileFd, folderFd]);
    expect(opens(calls)).toEqual([
      `open ${folderPath}/${nameOf(1)} ${String(fileFlags)} 600`,
      `open ${folderPath}/${nameOf(2)} ${String(fileFlags)} 600`,
    ]);
    expect(content(fileFd + 1)).toBe('{"v":1}\n');
    expect(writer.counts()).toMatchObject({ written: 1, reopened: 1 });
  });

  it('counts a line as lost when the file is deleted while it is written', () => {
    const { writer, deleted, content } = deletable({
      write: (fd) => {
        deleted.add(fd);
        return undefined;
      },
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(content(fileFd)).toBe('{"v":1}\n');
    expect(writer.counts()).toMatchObject({ written: 0, failed: 1 });
    expect(writer.ready()).toBe(true);
    expect(writer.counts().reopened).toBe(1);
  });

  it.each([
    [
      'an fstat that throws',
      (): AuditFileStats => {
        throw fsError('EBADF');
      },
    ],
    ['an fstat of another file', () => stats({ kind: 'file', ino: 7 })],
    [
      'an fstat on another device',
      () => stats({ kind: 'file', ino: 211, dev: 2 }),
    ],
  ])('gives up a descriptor after %s without closing it', (_name, fstat) => {
    let armed = false;
    const { writer, closed, content } = opened({
      fstat: (fd) => (armed && fd === fileFd ? fstat() : undefined),
    });
    armed = true;
    expect(writer.write('{"v":1}')).toBe(true);
    // Only the folder, twice: the old descriptor may be someone else's.
    expect(closed).toEqual([folderFd, folderFd]);
    expect(content(fileFd + 1)).toBe('{"v":1}\n');
  });

  it('writes the line into a new file after EBADF, without closing the old one', () => {
    const { writer, closed, content } = opened({
      write: (fd) => {
        if (fd === fileFd) throw fsError('EBADF');
        return undefined;
      },
    });
    expect(writer.write('{"v":1}')).toBe(true);
    expect(closed).toEqual([folderFd, folderFd]);
    expect(content(fileFd + 1)).toBe('{"v":1}\n');
  });

  it.each(['ESTALE', 'EFBIG'])(
    'leaves the piece in the old file after %s and writes the line anew',
    (code) => {
      // The piece, its repair and the repair before closing all fail.
      const { writer, closed, content } = opened({
        write: script(4, code, code, code),
      });
      expect(writer.write('{"v":1}')).toBe(true);
      expect(closed).toEqual([folderFd, fileFd, folderFd]);
      expect(content(fileFd)).toBe('{"v"');
      expect(content(fileFd + 1)).toBe('{"v":1}\n');
      expect(writer.counts()).toMatchObject({ written: 1, partial: 1 });
    },
  );

  it('loses the line when the new file cannot be opened, and tries again', () => {
    let refuse = true;
    const { writer, deleted, content, calls } = deletable({
      open: (path) => {
        if (refuse && path.endsWith('.jsonl') && !path.endsWith(nameOf(1))) {
          throw fsError('EACCES');
        }
        return undefined;
      },
    });
    deleted.add(fileFd);
    expect(writer.write('{"v":1}')).toBe(false);
    expect(writer.ready()).toBe(false);
    refuse = false;
    expect(writer.write('{"v":2}')).toBe(true);
    // The names 2 and 3 were tried and refused, 4 is the next one.
    expect(opens(calls)).toHaveLength(4);
    expect(content(fileFd + 1)).toBe('{"v":2}\n');
  });

  it('loses the line when the folder for the new file is gone', () => {
    let armed = false;
    const { writer, deleted, calls } = deletable({
      mkdir: () => {
        if (armed) throw fsError('ENOENT');
      },
    });
    armed = true;
    deleted.add(fileFd);
    expect(writer.write('{"v":1}')).toBe(false);
    expect(opens(calls)).toHaveLength(1);
  });

  it('opens at most one new file per line', () => {
    const { writer, deleted, calls } = deletable({
      write: (fd) => {
        if (fd !== fileFd) throw fsError('EBADF');
        return undefined;
      },
    });
    deleted.add(fileFd);
    expect(writer.write('{"v":1}')).toBe(false);
    expect(opens(calls)).toHaveLength(2);
  });

  it(`opens at most ${String(maxReopens)} new files per process`, () => {
    const deleted = new Set<number>();
    const { writer, calls } = opened({
      fstat: (fd) =>
        deleted.has(fd)
          ? stats({ kind: 'file', ino: 200 + fd, nlink: 0 })
          : undefined,
      write: (fd) => {
        deleted.add(fd);
        return undefined;
      },
    });
    for (let line = 0; line < maxReopens + 3; line += 1) {
      expect(writer.write('{"v":1}')).toBe(false);
    }
    expect(opens(calls)).toHaveLength(1 + maxReopens);
    expect(writer.counts().reopened).toBe(maxReopens);
    expect(writer.ready()).toBe(false);
  });

  it('repairs a piece that lacks only its break before it closes the file', () => {
    const { writer, content } = opened({ write: script(-2, 'EIO', 'EIO') });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(content(fileFd)).toBe('{"v":1}');
    writer.close();
    expect(content(fileFd)).toBe('{"v":1}~\n');
  });

  it('repairs a piece in the old file on a new UTC day', () => {
    let now = clock.now();
    const { writer, content } = opened(
      { write: script(-2, 'EIO', 'EIO') },
      { now: () => now },
    );
    expect(writer.write('{"v":1}')).toBe(false);
    now += day;
    expect(writer.write('{"v":2}')).toBe(true);
    expect(content(fileFd)).toBe('{"v":1}~\n');
    expect(content(fileFd + 1)).toBe('{"v":2}\n');
  });

  it('never closes a descriptor that names another file, on a new day or at close', () => {
    let now = clock.now();
    let armed = false;
    const { writer, closed } = opened(
      {
        fstat: (fd) =>
          armed && fd === fileFd ? stats({ kind: 'file', ino: 7 }) : undefined,
      },
      { now: () => now },
    );
    armed = true;
    now += day;
    expect(writer.write('{"v":1}')).toBe(true);
    writer.close();
    // The folder twice and the new file, never the old descriptor.
    expect(closed).toEqual([folderFd, folderFd, fileFd + 1]);
  });

  it('tries the file of a new day once and keeps the bound for lost files', () => {
    let now = clock.now();
    let refuse = true;
    const deleted = new Set<number>();
    const { writer, calls, content } = opened(
      {
        open: (path) => {
          if (refuse && path.includes('2026-10-24')) throw fsError('EACCES');
          return undefined;
        },
        fstat: (fd) =>
          deleted.has(fd)
            ? stats({ kind: 'file', ino: 200 + fd, nlink: 0 })
            : undefined,
      },
      { now: () => now },
    );
    now += day;
    for (let line = 0; line < maxReopens + 6; line += 1) {
      expect(writer.write('{"v":1}')).toBe(true);
    }
    expect(opens(calls)).toHaveLength(2);
    expect(content(fileFd)).toBe('{"v":1}\n'.repeat(maxReopens + 6));
    refuse = false;
    deleted.add(fileFd);
    expect(writer.write('{"v":2}')).toBe(true);
    expect(content(fileFd + 1)).toBe('{"v":2}\n');
  });

  it('starts a file for each new day without using the bound for lost files', () => {
    let now = clock.now();
    const { writer, calls } = opened({}, { now: () => now });
    for (let days = 0; days < maxReopens + 6; days += 1) {
      now += day;
      expect(writer.write('{"v":1}')).toBe(true);
    }
    expect(opens(calls)).toHaveLength(maxReopens + 7);
    expect(writer.counts().reopened).toBe(maxReopens + 6);
  });

  it('starts a new file on a new UTC day and closes the old one', () => {
    let now = clock.now();
    const { writer, closed, content, calls } = opened({}, { now: () => now });
    expect(writer.write('{"v":1}')).toBe(true);
    now += day;
    expect(writer.write('{"v":2}')).toBe(true);
    expect(opens(calls)[1]).toBe(
      `open ${folderPath}/audit-2026-10-24-055230-${String(pid)}-2.jsonl ${String(fileFlags)} 600`,
    );
    expect(closed).toEqual([folderFd, folderFd, fileFd]);
    expect(content(fileFd)).toBe('{"v":1}\n');
    expect(content(fileFd + 1)).toBe('{"v":2}\n');
  });

  it('never starts a file for an earlier day', () => {
    let now = clock.now();
    const { writer, calls } = opened({}, { now: () => now });
    now -= day;
    expect(writer.write('{"v":1}')).toBe(true);
    expect(opens(calls)).toHaveLength(1);
  });

  it('writes into the old file when the file of a new day cannot be opened', () => {
    let now = clock.now();
    const { writer, closed, content } = opened(
      {
        open: (path) => {
          if (path.includes('2026-10-24')) throw fsError('ENOSPC');
          return undefined;
        },
      },
      { now: () => now },
    );
    now += day;
    expect(writer.write('{"v":1}')).toBe(true);
    expect(closed).toEqual([folderFd, folderFd]);
    expect(content(fileFd)).toBe('{"v":1}\n');
  });

  it('writes without a change of day when the clock fails', () => {
    let fails = false;
    const { writer, content } = opened(
      {},
      {
        now: () => {
          if (fails) throw new Error('clock');
          return clock.now();
        },
      },
    );
    fails = true;
    expect(writer.write('{"v":1}')).toBe(true);
    expect(content(fileFd)).toBe('{"v":1}\n');
  });

  it('opens no new file when the clock fails', () => {
    let fails = false;
    const deleted = new Set<number>();
    const { writer, calls } = opened(
      {
        fstat: (fd) =>
          deleted.has(fd)
            ? stats({ kind: 'file', ino: 200 + fd, nlink: 0 })
            : undefined,
      },
      {
        now: () => {
          if (fails) throw new Error('clock');
          return clock.now();
        },
      },
    );
    fails = true;
    deleted.add(fileFd);
    expect(writer.write('{"v":1}')).toBe(false);
    expect(writer.ready()).toBe(false);
    expect(opens(calls)).toHaveLength(1);
  });

  it('is ready while the last line reached the file, and not after a lost one', () => {
    const { writer, calls } = opened({
      write: script(undefined as never, 'ENOSPC'),
    });
    expect(writer.ready()).toBe(true);
    expect(writer.write('{"v":1}')).toBe(true);
    expect(writer.ready()).toBe(true);
    expect(writer.write('{"v":2}')).toBe(false);
    expect(writer.ready()).toBe(false);
    // Only a line shows whether the file takes lines again.
    expect(opens(calls)).toHaveLength(1);
    expect(writer.write('{"v":3}')).toBe(true);
    expect(writer.ready()).toBe(true);
  });

  it('opens a new file for ready when the file was deleted', () => {
    const { writer, deleted, calls } = deletable();
    deleted.add(fileFd);
    expect(writer.ready()).toBe(true);
    expect(opens(calls)).toHaveLength(2);
  });

  it('is closed for good: not ready, no line and no new file', () => {
    const { writer, calls } = opened();
    writer.close();
    expect(writer.ready()).toBe(false);
    expect(writer.write('{"v":1}')).toBe(false);
    expect(opens(calls)).toHaveLength(1);
    expect(writer.counts()).toMatchObject({ failed: 1, closed: true });
  });
});

describe('openAuditFile on the disk', () => {
  const base = mkdtempSync(join(tmpdir(), 'ecclium-audit-file-'));
  const fresh = (name: string): string => {
    const folder = join(base, name);
    mkdirSync(folder);
    chmodSync(folder, 0o700);
    return folder;
  };
  const open = (folder: string) =>
    openAuditFile({ stateDir: folder, clock, pid });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('creates the folder audit with 0700 and an empty file with 0600', () => {
    const folder = fresh('new');
    const result = open(folder);
    expect(result.ok).toBe(true);
    const audit = join(folder, 'audit');
    expect(statSync(audit).mode & 0o777).toBe(0o700);
    expect(readdirSync(audit)).toEqual([nameOf(1)]);
    const file = statSync(join(audit, nameOf(1)));
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.size).toBe(0);
    if (result.ok) result.writer.close();
  });

  it('writes lines into the file on the disk', () => {
    const folder = fresh('lines');
    const result = open(folder);
    if (!result.ok) throw new Error(result.code);
    expect(result.writer.write('{"v":1}')).toBe(true);
    expect(result.writer.write('{"v":2}')).toBe(true);
    result.writer.close();
    expect(readFileSync(join(folder, 'audit', nameOf(1)), 'utf8')).toBe(
      '{"v":1}\n{"v":2}\n',
    );
  });

  it('opens a second file in the same folder with the next free number', () => {
    const folder = fresh('second');
    const first = open(folder);
    const second = open(folder);
    expect(first.ok && second.ok).toBe(true);
    expect(readdirSync(join(folder, 'audit')).sort()).toEqual([
      nameOf(1),
      nameOf(2),
    ]);
    if (first.ok) first.writer.close();
    if (second.ok) second.writer.close();
  });

  it('never opens through a link at the name of the file', () => {
    const folder = fresh('link-name');
    const audit = join(folder, 'audit');
    mkdirSync(audit, { mode: 0o700 });
    const target = join(base, 'link-target');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, join(audit, nameOf(1)));
    const result = open(folder);
    expect(result.ok).toBe(true);
    expect(readdirSync(audit).sort()).toEqual([nameOf(1), nameOf(2)]);
    expect(statSync(target).size).toBe(0);
    if (result.ok) result.writer.close();
  });

  it('writes into a new file when the file was deleted', () => {
    const folder = fresh('deleted');
    const result = open(folder);
    if (!result.ok) throw new Error(result.code);
    expect(result.writer.write('{"v":1}')).toBe(true);
    rmSync(join(folder, 'audit', nameOf(1)));
    expect(result.writer.ready()).toBe(true);
    expect(result.writer.write('{"v":2}')).toBe(true);
    result.writer.close();
    expect(readdirSync(join(folder, 'audit'))).toEqual([nameOf(2)]);
    expect(readFileSync(join(folder, 'audit', nameOf(2)), 'utf8')).toBe(
      '{"v":2}\n',
    );
  });

  it('writes into a new folder audit when the folder was deleted', () => {
    const folder = fresh('deleted-folder');
    const result = open(folder);
    if (!result.ok) throw new Error(result.code);
    rmSync(join(folder, 'audit'), { recursive: true });
    expect(result.writer.write('{"v":1}')).toBe(true);
    result.writer.close();
    expect(statSync(join(folder, 'audit')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(folder, 'audit'))).toEqual([nameOf(2)]);
  });

  it('starts a new file on the disk on a new UTC day', () => {
    const folder = fresh('day');
    let now = clock.now();
    const result = openAuditFile({
      stateDir: folder,
      clock: { now: () => now },
      pid,
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.writer.write('{"v":1}')).toBe(true);
    now += 24 * 60 * 60 * 1000;
    expect(result.writer.write('{"v":2}')).toBe(true);
    result.writer.close();
    expect(readdirSync(join(folder, 'audit')).sort()).toEqual([
      nameOf(1),
      `audit-2026-10-24-055230-${String(pid)}-2.jsonl`,
    ]);
  });

  it('refuses a folder audit that is a link to a good folder', () => {
    const folder = fresh('link-folder');
    symlinkSync(fresh('link-folder-target'), join(folder, 'audit'));
    expect(open(folder)).toMatchObject({ code: 'audit_file_folder_unsafe' });
  });

  it('refuses a file named audit', () => {
    const folder = fresh('file-folder');
    writeFileSync(join(folder, 'audit'), '', { mode: 0o600 });
    expect(open(folder)).toMatchObject({ code: 'audit_file_folder_unsafe' });
  });

  it('refuses a folder audit with 0755', () => {
    const folder = fresh('open-folder');
    mkdirSync(join(folder, 'audit'));
    chmodSync(join(folder, 'audit'), 0o755);
    expect(open(folder)).toMatchObject({ code: 'audit_file_folder_unsafe' });
  });

  it('refuses a missing folder of state', () => {
    expect(open(join(base, 'missing'))).toMatchObject({
      code: 'audit_file_folder_unavailable',
    });
  });
});

describe('auditFileCodes', () => {
  it('is frozen and has each code once', () => {
    expect(Object.isFrozen(auditFileCodes)).toBe(true);
    expect(new Set(auditFileCodes).size).toBe(auditFileCodes.length);
  });

  it('fit the name of a log event', () => {
    for (const code of auditFileCodes) {
      expect(isEventName(code), code).toBe(true);
    }
  });
});
