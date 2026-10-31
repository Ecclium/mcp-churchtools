import { createHash } from 'node:crypto';
import {
  chmodSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isEventName, maxLineLength } from '../logger/index.js';
import {
  type AuditChainAnchor,
  auditFileCodes,
  type AuditSweep,
  type AuditFileStats,
  type AuditFileSystem,
  type AuditFileWriter,
  maxAuditLineLength,
  maxNameAttempts,
  maxReopens,
  maxWriteAttempts,
  openAuditFile,
} from './file-writer.js';

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

// Each link of the chain the writer puts before the last brace of a line.
const linkPattern = /,"seq":[1-9][0-9]*,"prevHash":"[0-9a-f]{64}"\}/g;

/**
 * The text without the links of the chain, for tests of what the writer
 * does with the bytes of a line.
 */
const unchained = (text: string): string => text.replaceAll(linkPattern, '}');

/** The bytes of a line with its link and line break. */
const bytesOf = (line: string, seq: number): number =>
  line.length + `,"seq":${String(seq)},"prevHash":"${'0'.repeat(64)}"\n`.length;

/**
 * The links of the whole lines of a file, checked as `audit verify` will
 * check them: seq counts from 1, and each prevHash is the SHA-256 of the
 * line before, or of the name of the file for the first line. Pieces,
 * which end in a tilde, are no part of the chain.
 */
const chainOf = (name: string, text: string): number[] => {
  const seqs: number[] = [];
  let hash = sha256(name);
  for (const line of text.split('\n').slice(0, -1)) {
    if (line.endsWith('~')) continue;
    const parsed = JSON.parse(line) as { seq: number; prevHash: string };
    expect(parsed.seq).toBe(seqs.length + 1);
    expect(parsed.prevHash).toBe(hash);
    seqs.push(parsed.seq);
    hash = sha256(line);
  }
  return seqs;
};

// Real folders and files in a temporary folder cover what the disk can
// show: modes, links, names in use. Injected file functions cover what a
// test cannot build there, such as a descriptor below 3, another owner or
// a path that leads to another file after the open.

const stateDir = '/path/to/state';
const folderPath = `${stateDir}/audit`;
const pid = 4242;
const retentionMonths = 12;
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
    size: 0,
    mtimeMs: clock.now(),
    ...rest,
  };
};

interface Hooks {
  readonly mkdir?: (path: string) => void;
  readonly open?: (path: string, flags: number) => number | undefined;
  readonly fstat?: (fd: number) => AuditFileStats | undefined;
  readonly lstat?: (path: string) => AuditFileStats | undefined;
  readonly close?: (fd: number) => void;
  readonly fsync?: (fd: number) => void;
  readonly readdir?: (path: string) => string[] | undefined;
  readonly unlink?: (path: string) => void;
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
        : stats({
            kind: 'file',
            ino: 200 + fd,
            size: bytesOf.get(fd)?.length ?? 0,
          })),
    lstatSync: (path) => {
      const given = hooks.lstat?.(path);
      if (given !== undefined) return given;
      if (path === folderPath) return stats({ kind: 'dir' });
      const fd = fdOfPath.get(path);
      if (fd === undefined) throw fsError('ENOENT');
      return stats({
        kind: 'file',
        ino: 200 + fd,
        size: bytesOf.get(fd)?.length ?? 0,
      });
    },
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
    fsyncSync: (fd) => {
      calls.push(`fsync ${String(fd)}`);
      hooks.fsync?.(fd);
    },
    readdirSync: (path) => {
      calls.push(`readdir ${path}`);
      return (
        hooks.readdir?.(path) ??
        [...fdOfPath.keys()].map((name) => name.slice(folderPath.length + 1))
      );
    },
    unlinkSync: (path) => {
      calls.push(`unlink ${path}`);
      hooks.unlink?.(path);
      fdOfPath.delete(path);
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
  const result = openAuditFile({
    stateDir,
    clock: time,
    pid,
    fs: files.fs,
    retentionMonths,
  });
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
  const result = openAuditFile({
    stateDir,
    clock,
    pid,
    fs: fake(hooks).fs,
    retentionMonths,
  });
  return result.ok ? 'ok' : result.code;
};

describe('openAuditFile with file functions', () => {
  it('creates the folder, opens a new file and checks both', () => {
    const { fs, calls, closed } = fake();
    const result = openAuditFile({ stateDir, clock, pid, fs, retentionMonths });
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
    expect(
      openAuditFile({ stateDir: '/', clock, pid, fs, retentionMonths }).ok,
    ).toBe(true);
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
      expect(
        openAuditFile({ stateDir, clock, pid, fs, retentionMonths }),
      ).toEqual({
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
    expect(
      openAuditFile({ stateDir, clock, pid, fs, retentionMonths }),
    ).toMatchObject({
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
    expect(
      openAuditFile({ stateDir, clock, pid, fs, retentionMonths }),
    ).toMatchObject({
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
      expect(
        openAuditFile({ stateDir, clock, pid, fs, retentionMonths }).ok,
      ).toBe(true);
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
    expect(
      openAuditFile({ stateDir, clock, pid, fs, retentionMonths }),
    ).toMatchObject({
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
    expect(
      openAuditFile({ stateDir, clock, pid, fs, retentionMonths }),
    ).toMatchObject({
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
    expect(
      openAuditFile({ stateDir, clock: { now }, pid, fs, retentionMonths }),
    ).toMatchObject({
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
    ['a retention of 0 months', { retentionMonths: 0 }],
    ['a retention of 121 months', { retentionMonths: 121 }],
    ['a retention that is no integer', { retentionMonths: 1.5 }],
    ['no retention', { retentionMonths: undefined }],
  ])('throws for %s', (_name, change) => {
    expect(() =>
      openAuditFile({
        stateDir,
        clock,
        pid,
        retentionMonths,
        fs: fake().fs,
        ...change,
      } as Parameters<typeof openAuditFile>[0]),
    ).toThrow(
      new TypeError(
        'The audit file needs a folder of state, a clock, a process ID and a retention.',
      ),
    );
  });

  it('closes the file once and stays closed', () => {
    const { fs, closed } = fake();
    const result = openAuditFile({ stateDir, clock, pid, fs, retentionMonths });
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
    const result = openAuditFile({ stateDir, clock, pid, fs, retentionMonths });
    if (!result.ok) throw new Error('not opened');
    expect(() => {
      result.writer.close();
    }).not.toThrow();
    expect(result.writer.counts().closed).toBe(true);
  });

  it('gives frozen results without a prototype', () => {
    const opened = openAuditFile({
      stateDir,
      clock,
      pid,
      fs: fake().fs,
      retentionMonths,
    });
    const refused = openAuditFile({
      stateDir,
      clock,
      pid,
      retentionMonths,
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
    expect(unchained(content(fileFd))).toBe('{"v":1}\n{"v":2}\n');
    // Exactly four arguments: a position would write over the file.
    expect(arities).toEqual([4, 4]);
    expect(calls.filter((call) => call.startsWith('write'))).toEqual([
      `write ${String(fileFd)} 0 ${String(bytesOf('{"v":1}', 1))}`,
      `write ${String(fileFd)} 0 ${String(bytesOf('{"v":2}', 2))}`,
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
    ['a line too long', `{"a":"${'a'.repeat(maxAuditLineLength - 7)}"}`],
    ['no string', 1],
    ['no object', 'a'],
    ['an array', '[1]'],
    ['an empty object', '{}'],
    ['an object without its end', '{"v":1'],
    ['an object without its start', '"v":1}'],
  ])('refuses %s without a call', (_name, line) => {
    const { writer, calls } = opened();
    expect(writer.write(line as string)).toBe(false);
    expect(writer.counts().rejected).toBe(1);
    expect(calls.some((call) => call.startsWith('write'))).toBe(false);
  });

  it('takes the longest line, which fits with its link the rule for a line', () => {
    const { writer, content } = opened();
    const line = `{"a":"${'a'.repeat(maxAuditLineLength - 8)}"}`;
    expect(line).toHaveLength(maxAuditLineLength);
    expect(writer.write(line)).toBe(true);
    // The line with the longest link of all, seq 2**53 - 1, still fits.
    expect(maxAuditLineLength + 101).toBe(maxLineLength);
    expect(content(fileFd).length).toBe(bytesOf(line, 1));
  });

  it('continues a partial write at its offset', () => {
    const { writer, content, calls } = opened({ write: script(3) });
    expect(writer.write('{"v":1}')).toBe(true);
    expect(unchained(content(fileFd))).toBe('{"v":1}\n');
    const length = bytesOf('{"v":1}', 1);
    expect(calls.filter((call) => call.startsWith('write'))).toEqual([
      `write ${String(fileFd)} 0 ${String(length)}`,
      `write ${String(fileFd)} 3 ${String(length - 3)}`,
    ]);
  });

  it('chains each line to the one before and the first to the name of the file', () => {
    const { writer, content } = opened();
    for (let line = 1; line <= 5; line += 1) {
      expect(writer.write(`{"v":${String(line)}}`)).toBe(true);
    }
    const text = content(fileFd);
    expect(chainOf(nameOf(1), text)).toEqual([1, 2, 3, 4, 5]);
    // The link stands after every field the line had, before its brace.
    expect(text.split('\n')[0]).toBe(
      `{"v":1,"seq":1,"prevHash":"${sha256(nameOf(1))}"}`,
    );
  });

  it('keeps the head of the chain after a lost line and a piece', () => {
    // A piece of the first line with its repair, nothing of the second.
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', undefined as never, 'EIO'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(writer.write('{"v":2}')).toBe(false);
    expect(writer.write('{"v":3}')).toBe(true);
    expect(writer.write('{"v":4}')).toBe(true);
    const text = content(fileFd);
    expect(unchained(text)).toBe('{"v"~\n{"v":3}\n{"v":4}\n');
    // The piece and the lost line are no part of the chain.
    expect(chainOf(nameOf(1), text)).toEqual([1, 2]);
  });

  it.each([0, -1, Number.NaN, 1.5, 9])(
    'counts %s bytes from writeSync as no progress',
    (count) => {
      const { writer, content } = opened({
        write: script(count, count, count),
      });
      expect(writer.write('{"v":1}')).toBe(true);
      expect(unchained(content(fileFd))).toBe('{"v":1}\n');
    },
  );

  it(`gives up after ${String(maxWriteAttempts)} calls without progress`, () => {
    const { writer, content, calls } = opened({ write: script(0, 0, 0, 0) });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(calls.filter((call) => call.startsWith('write'))).toHaveLength(
      maxWriteAttempts,
    );
    expect(unchained(content(fileFd))).toBe('');
    expect(writer.counts()).toMatchObject({ failed: 1, partial: 0 });
    // Nothing reached the file, so the next line needs no repair.
    expect(writer.write('{"v":2}')).toBe(true);
    expect(unchained(content(fileFd))).toBe('{"v":2}\n');
  });

  it.each(['ENOSPC', 'EDQUOT', 'EIO'])(
    'loses the line on %s and writes the next one',
    (code) => {
      const { writer, content } = opened({ write: script(code) });
      expect(writer.write('{"v":1}')).toBe(false);
      expect(writer.write('{"v":2}')).toBe(true);
      expect(unchained(content(fileFd))).toBe('{"v":2}\n');
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
    expect(unchained(content(fileFd))).toBe('{"v"~\n');
    expect(writer.counts()).toMatchObject({ failed: 1, partial: 1 });
    expect(writer.write('{"v":2}')).toBe(true);
    expect(unchained(content(fileFd))).toBe('{"v"~\n{"v":2}\n');
  });

  it('never turns a piece that lacks only its break into a valid line', () => {
    const { writer, content } = opened({ write: script(-2, 'EIO') });
    expect(writer.write('{"v":1}')).toBe(false);
    const [piece] = content(fileFd).split('\n');
    expect(unchained(piece ?? '')).toBe('{"v":1}~');
    expect(() => JSON.parse(piece ?? '') as unknown).toThrow(SyntaxError);
  });

  it('repairs a piece with the next line when the repair fails', () => {
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', 'ENOSPC'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(unchained(content(fileFd))).toBe('{"v"');
    expect(writer.write('{"v":2}')).toBe(true);
    expect(unchained(content(fileFd))).toBe('{"v"~\n{"v":2}\n');
  });

  it('keeps a piece invalid when the repair stops after the tilde', () => {
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', 1, 'EIO'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(unchained(content(fileFd))).toBe('{"v"~');
    expect(writer.write('{"v":2}')).toBe(true);
    expect(unchained(content(fileFd))).toBe('{"v"~~\n{"v":2}\n');
  });

  it('repairs again after a line of which only the tilde went out', () => {
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', 'ENOSPC', 1, 'EIO'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(writer.write('{"v":2}')).toBe(false);
    expect(unchained(content(fileFd))).toBe('{"v"~');
    expect(writer.counts()).toMatchObject({ failed: 2, partial: 1 });
    expect(writer.write('{"v":3}')).toBe(true);
    expect(unchained(content(fileFd))).toBe('{"v"~~\n{"v":3}\n');
  });

  it('needs no repair after a line of which only the repair went out', () => {
    const { writer, content } = opened({
      write: script(4, 'ENOSPC', 'ENOSPC', 2, 'ENOSPC'),
    });
    expect(writer.write('{"v":1}')).toBe(false);
    expect(writer.write('{"v":2}')).toBe(false);
    expect(unchained(content(fileFd))).toBe('{"v"~\n');
    expect(writer.counts()).toMatchObject({ failed: 2, partial: 1 });
    expect(writer.write('{"v":3}')).toBe(true);
    expect(unchained(content(fileFd))).toBe('{"v"~\n{"v":3}\n');
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
    expect(unchained(content(fileFd + 1))).toBe('{"v":1}\n');
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
    expect(unchained(content(fileFd))).toBe('{"v":1}\n');
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
    expect(unchained(content(fileFd + 1))).toBe('{"v":1}\n');
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
    expect(unchained(content(fileFd + 1))).toBe('{"v":1}\n');
    // The line goes into the new file with the first link of its chain.
    expect(chainOf(nameOf(2), content(fileFd + 1))).toEqual([1]);
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
      expect(unchained(content(fileFd))).toBe('{"v"');
      expect(unchained(content(fileFd + 1))).toBe('{"v":1}\n');
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
    expect(unchained(content(fileFd + 1))).toBe('{"v":2}\n');
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
    expect(unchained(content(fileFd))).toBe('{"v":1}');
    writer.close();
    expect(unchained(content(fileFd))).toBe('{"v":1}~\n');
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
    expect(unchained(content(fileFd))).toBe('{"v":1}~\n');
    expect(unchained(content(fileFd + 1))).toBe('{"v":2}\n');
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
    expect(unchained(content(fileFd))).toBe('{"v":1}\n'.repeat(maxReopens + 6));
    refuse = false;
    deleted.add(fileFd);
    expect(writer.write('{"v":2}')).toBe(true);
    expect(unchained(content(fileFd + 1))).toBe('{"v":2}\n');
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
    expect(unchained(content(fileFd))).toBe('{"v":1}\n');
    expect(unchained(content(fileFd + 1))).toBe('{"v":2}\n');
    // Each day has a chain of its own, anchored to the name of its file.
    expect(chainOf(nameOf(1), content(fileFd))).toEqual([1]);
    expect(
      chainOf(
        `audit-2026-10-24-055230-${String(pid)}-2.jsonl`,
        content(fileFd + 1),
      ),
    ).toEqual([1]);
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
    expect(unchained(content(fileFd))).toBe('{"v":1}\n');
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
    expect(unchained(content(fileFd))).toBe('{"v":1}\n');
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

describe('the flush of the writer', () => {
  const day = 24 * 60 * 60 * 1000;
  const syncs = (calls: readonly string[]): string[] =>
    calls.filter((call) => call.startsWith('fsync'));

  it('flushes no line on its own, only the file when it closes, before closing it', () => {
    const order: string[] = [];
    const { writer, calls } = opened({
      fsync: (fd) => order.push(`fsync ${String(fd)}`),
      close: (fd) => order.push(`close ${String(fd)}`),
    });
    for (let line = 0; line < 5; line += 1) writer.write('{"v":1}');
    expect(syncs(calls)).toEqual([]);
    writer.close();
    expect(order).toEqual([
      `close ${String(folderFd)}`,
      `fsync ${String(fileFd)}`,
      `close ${String(fileFd)}`,
    ]);
  });

  it('flushes the old file on a new UTC day and a deleted one before the new file', () => {
    let now = clock.now();
    const deleted = new Set<number>();
    const { writer, calls } = opened(
      {
        // A deleted file that holds a line.
        fstat: (fd) =>
          deleted.has(fd)
            ? stats({ kind: 'file', ino: 200 + fd, nlink: 0, size: 1 })
            : undefined,
      },
      { now: () => now },
    );
    writer.write('{"v":1}');
    now += day;
    writer.write('{"v":2}');
    expect(syncs(calls)).toEqual([`fsync ${String(fileFd)}`]);
    deleted.add(fileFd + 1);
    writer.write('{"v":3}');
    expect(syncs(calls)).toEqual([
      `fsync ${String(fileFd)}`,
      `fsync ${String(fileFd + 1)}`,
    ]);
  });

  it('never flushes a descriptor it gives up after EBADF', () => {
    const { writer, calls } = opened({
      write: (fd) => {
        if (fd === fileFd) throw fsError('EBADF');
        return undefined;
      },
    });
    expect(writer.write('{"v":1}')).toBe(true);
    expect(syncs(calls)).toEqual([]);
  });

  it('closes the file and reports its anchor when the flush fails', () => {
    const { writer, closed } = opened({
      fsync: () => {
        throw fsError('EIO');
      },
    });
    const anchors: unknown[] = [];
    writer.attach({
      anchor: (given) => anchors.push(given),
      swept: () => undefined,
    });
    writer.write('{"v":1}');
    writer.close();
    expect(closed).toEqual([folderFd, fileFd]);
    expect(anchors).toHaveLength(1);
  });
});

describe('the anchors of the writer', () => {
  const day = 24 * 60 * 60 * 1000;

  /** An open writer with a listener that keeps every anchor. */
  const anchored = (hooks: Hooks = {}, time: { now: () => number } = clock) => {
    const files = opened(hooks, time);
    const anchors: AuditChainAnchor[] = [];
    const sweeps: AuditSweep[] = [];
    expect(
      files.writer.attach({
        anchor: (given) => {
          anchors.push(given);
        },
        swept: (given) => {
          sweeps.push(given);
        },
      }),
    ).toBe(true);
    return { ...files, anchors, sweeps };
  };

  /** The anchor of the last whole line of a text of a file. */
  const headOf = (name: string, text: string): AuditChainAnchor => {
    const lines = text.split('\n').slice(0, -1);
    const last = lines.at(-1) ?? '';
    return {
      file: name,
      seq: (JSON.parse(last) as { seq: number }).seq,
      hash: sha256(last),
    };
  };

  it('reports the head of the chain when the file closes', () => {
    const { writer, anchors, content } = anchored();
    writer.write('{"v":1}');
    writer.write('{"v":2}');
    expect(anchors).toEqual([]);
    writer.close();
    expect(anchors).toEqual([headOf(nameOf(1), content(fileFd))]);
    expect(anchors[0]?.seq).toBe(2);
    expect(Object.isFrozen(anchors[0])).toBe(true);
    // Once: a second close finds no file.
    writer.close();
    expect(anchors).toHaveLength(1);
  });

  it('reports no anchor for a file without a whole line', () => {
    const { writer, anchors } = anchored({ write: script(4, 'ENOSPC') });
    expect(writer.write('{"v":1}')).toBe(false);
    writer.close();
    expect(anchors).toEqual([]);
  });

  it('reports the old file on a new UTC day, and the new one when it closes', () => {
    let now = clock.now();
    const { writer, anchors, content } = anchored({}, { now: () => now });
    writer.write('{"v":1}');
    now += day;
    writer.write('{"v":2}');
    expect(anchors).toEqual([headOf(nameOf(1), content(fileFd))]);
    writer.close();
    expect(anchors[1]).toEqual(
      headOf(
        `audit-2026-10-24-055230-${String(pid)}-2.jsonl`,
        content(fileFd + 1),
      ),
    );
  });

  it('reports a file that was deleted before the new one', () => {
    const deleted = new Set<number>();
    const { writer, anchors, content } = anchored({
      fstat: (fd) =>
        deleted.has(fd)
          ? stats({ kind: 'file', ino: 200 + fd, nlink: 0 })
          : undefined,
    });
    writer.write('{"v":1}');
    deleted.add(fileFd);
    writer.write('{"v":2}');
    expect(anchors).toEqual([headOf(nameOf(1), content(fileFd))]);
  });

  it('reports a file it gives up after EBADF without closing it', () => {
    let fail = false;
    const { writer, anchors, closed, content } = anchored({
      write: (fd) => {
        if (fail && fd === fileFd) throw fsError('EBADF');
        return undefined;
      },
    });
    writer.write('{"v":1}');
    fail = true;
    expect(writer.write('{"v":2}')).toBe(true);
    expect(closed).toEqual([folderFd, folderFd]);
    expect(anchors).toEqual([headOf(nameOf(1), content(fileFd))]);
  });

  it('takes one listener, only with both functions, and survives one that throws', () => {
    const { writer } = opened();
    const quiet = { anchor: () => undefined, swept: () => undefined };
    expect(writer.attach(null as never)).toBe(false);
    expect(writer.attach({} as never)).toBe(false);
    expect(writer.attach({ anchor: () => undefined } as never)).toBe(false);
    expect(writer.attach({ swept: () => undefined } as never)).toBe(false);
    expect(writer.attach(new Proxy(quiet, {}))).toBe(false);
    expect(
      writer.attach(
        Object.defineProperty({ swept: () => undefined }, 'anchor', {
          get: () => () => undefined,
        }) as never,
      ),
    ).toBe(false);
    const fail = (): never => {
      throw new Error('listener');
    };
    expect(writer.attach({ anchor: fail, swept: fail })).toBe(true);
    expect(writer.attach(quiet)).toBe(false);
    writer.write('{"v":1}');
    expect(() => {
      writer.sweep();
      writer.close();
    }).not.toThrow();
    expect(writer.counts().closed).toBe(true);
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
    openAuditFile({ stateDir: folder, clock, pid, retentionMonths });

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
    const text = readFileSync(join(folder, 'audit', nameOf(1)), 'utf8');
    expect(unchained(text)).toBe('{"v":1}\n{"v":2}\n');
    expect(chainOf(nameOf(1), text)).toEqual([1, 2]);
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
    const text = readFileSync(join(folder, 'audit', nameOf(2)), 'utf8');
    // The new file starts a chain of its own.
    expect(unchained(text)).toBe('{"v":2}\n');
    expect(chainOf(nameOf(2), text)).toEqual([1]);
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
      retentionMonths,
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

describe('the empty files of the writer', () => {
  const day = 24 * 60 * 60 * 1000;
  const unlinks = (calls: readonly string[]): string[] =>
    calls.filter((call) => call.startsWith('unlink'));

  it('removes its file without a byte when it closes, without a flush', () => {
    const { writer, calls } = opened();
    writer.close();
    expect(unlinks(calls)).toEqual([`unlink ${folderPath}/${nameOf(1)}`]);
    expect(calls.some((call) => call.startsWith('fsync'))).toBe(false);
  });

  it('keeps a file with a line or with a piece of one', () => {
    const lines = opened();
    lines.writer.write('{"v":1}');
    lines.writer.close();
    expect(unlinks(lines.calls)).toEqual([]);
    const piece = opened({ write: script(4, 'ENOSPC') });
    piece.writer.write('{"v":1}');
    piece.writer.close();
    expect(unlinks(piece.calls)).toEqual([]);
  });

  it('keeps an empty file whose name leads to another file by now', () => {
    let armed = false;
    const { writer, calls } = opened({
      lstat: (path) =>
        armed && path.endsWith(nameOf(1))
          ? stats({ kind: 'file', ino: 999 })
          : undefined,
    });
    armed = true;
    writer.close();
    expect(unlinks(calls)).toEqual([]);
  });

  it('flushes and keeps a file whose size it cannot see when it closes', () => {
    let seen = 0;
    const { writer, calls } = opened({
      fstat: (fd) => {
        if (fd !== fileFd) return undefined;
        seen += 1;
        // The check of the file at its open and in verify, then a failure.
        if (seen > 2) throw fsError('EIO');
        return undefined;
      },
    });
    writer.close();
    expect(calls.filter((call) => call.startsWith('fsync'))).toEqual([
      `fsync ${String(fileFd)}`,
    ]);
    expect(calls.some((call) => call.startsWith('unlink'))).toBe(false);
  });

  it('closes for good when the removal fails', () => {
    const { writer } = opened({
      unlink: () => {
        throw fsError('EPERM');
      },
    });
    expect(() => {
      writer.close();
    }).not.toThrow();
    expect(writer.counts().closed).toBe(true);
  });

  it('removes its empty file of an earlier day when a new day starts', () => {
    let now = clock.now();
    const { writer, calls } = opened({}, { now: () => now });
    now += day;
    expect(writer.write('{"v":1}')).toBe(true);
    expect(unlinks(calls)).toEqual([`unlink ${folderPath}/${nameOf(1)}`]);
  });
});

describe('a new UTC day without a line', () => {
  const day = 24 * 60 * 60 * 1000;
  const opens = (calls: readonly string[]): string[] =>
    calls.filter((call) => call.startsWith('open') && call.includes('.jsonl'));

  /** A writer on a clock that moves, whose files can be deleted. */
  const moving = () => {
    let now = clock.now();
    const deleted = new Set<number>();
    const files = opened(
      {
        fstat: (fd) =>
          deleted.has(fd)
            ? stats({ kind: 'file', ino: 200 + fd, nlink: 0 })
            : undefined,
      },
      { now: () => now },
    );
    return {
      ...files,
      deleted,
      nextDay: () => {
        now += day;
      },
    };
  };

  it('starts the file of a new UTC day on tick, once, with a sweep', () => {
    const { writer, calls, nextDay } = moving();
    writer.tick();
    expect(opens(calls)).toHaveLength(1);
    nextDay();
    writer.tick();
    writer.tick();
    expect(opens(calls)).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('readdir'))).toHaveLength(1);
    expect(writer.counts().reopened).toBe(1);
    expect(writer.ready()).toBe(true);
  });

  it('does nothing on tick once closed', () => {
    const { writer, calls, nextDay } = moving();
    writer.close();
    nextDay();
    writer.tick();
    writer.sweep();
    expect(opens(calls)).toHaveLength(1);
    expect(calls.some((call) => call.startsWith('readdir'))).toBe(false);
  });

  it('replaces a file of an earlier day that another process removed as a change of day, in write', () => {
    const { writer, calls, deleted, nextDay } = moving();
    deleted.add(fileFd);
    nextDay();
    expect(writer.write('{"v":1}')).toBe(true);
    // The whole bound for lost files is still there.
    for (let lost = 0; lost < maxReopens; lost += 1) {
      deleted.add(fileFd + 1 + lost);
      expect(writer.write('{"v":2}')).toBe(true);
    }
    expect(opens(calls)).toHaveLength(2 + maxReopens);
    deleted.add(fileFd + 1 + maxReopens);
    expect(writer.write('{"v":3}')).toBe(false);
  });

  it('does the same when the gate asks first', () => {
    const { writer, calls, deleted, nextDay } = moving();
    deleted.add(fileFd);
    nextDay();
    expect(writer.ready()).toBe(true);
    expect(opens(calls)).toHaveLength(2);
    for (let lost = 0; lost < maxReopens; lost += 1) {
      deleted.add(fileFd + 1 + lost);
      expect(writer.ready()).toBe(true);
    }
    deleted.add(fileFd + 1 + maxReopens);
    expect(writer.ready()).toBe(false);
  });

  it('opens at most one file when the gate asks on a new day that cannot be opened', () => {
    let now = clock.now();
    const deleted = new Set<number>();
    const { writer, calls } = opened(
      {
        open: (path) => {
          if (path.includes('2026-10-24')) throw fsError('EACCES');
          return undefined;
        },
        fstat: (fd) =>
          deleted.has(fd)
            ? stats({ kind: 'file', ino: 200 + fd, nlink: 0 })
            : undefined,
      },
      { now: () => now },
    );
    deleted.add(fileFd);
    now += day;
    expect(writer.ready()).toBe(false);
    // The first file and one try for the new day, no second try.
    expect(opens(calls)).toHaveLength(2);
  });

  it('opens no file for a new day once the bound for lost files is used up', () => {
    const { writer, calls, deleted, nextDay } = moving();
    for (let lost = 0; lost <= maxReopens; lost += 1) {
      deleted.add(fileFd + lost);
      writer.write('{"v":1}');
    }
    expect(opens(calls)).toHaveLength(1 + maxReopens);
    nextDay();
    expect(writer.write('{"v":2}')).toBe(false);
    writer.tick();
    expect(writer.ready()).toBe(false);
    expect(opens(calls)).toHaveLength(1 + maxReopens);
  });
});

describe('the sweep of the writer with file functions', () => {
  // The clock stands on 2026-10-23; with twelve months, a file of
  // 2025-10-22 is past its retention, one of 2025-10-23 is not.
  const at = (day: string): number => Date.parse(`${day}T12:00:00.000Z`);
  const name = (day: string, number = 1): string =>
    `audit-${day}-120000-77-${String(number)}.jsonl`;

  /** A writer whose folder holds the given entries besides its own file. */
  const folderWith = (
    entries: Readonly<Record<string, AuditFileStats | Error>>,
    hooks: Hooks = {},
  ) => {
    const sweeps: AuditSweep[] = [];
    const files = opened({
      readdir: () => [nameOf(1), ...Object.keys(entries)],
      lstat: (path) => {
        const entry = entries[path.slice(folderPath.length + 1)];
        if (entry instanceof Error) throw entry;
        return entry;
      },
      ...hooks,
    });
    files.writer.attach({
      anchor: () => undefined,
      swept: (given) => sweeps.push(given),
    });
    const unlinked = () =>
      files.calls
        .filter((call) => call.startsWith('unlink'))
        .map((call) => call.slice(`unlink ${folderPath}/`.length));
    return { ...files, sweeps, unlinked };
  };

  const old = (fields: Partial<AuditFileStats> = {}) =>
    stats({
      kind: 'file',
      ino: 500,
      size: 10,
      mtimeMs: at('2025-10-22'),
      ...fields,
    });

  it('deletes only what is past its retention or empty from an earlier day', () => {
    const { writer, sweeps, unlinked } = folderWith({
      [name('2025-10-22')]: old(),
      [name('2025-10-23')]: old({ mtimeMs: at('2025-10-23') }),
      [name('2025-10-22', 2)]: old({ mtimeMs: at('2026-01-01') }),
      [name('2026-10-22')]: old({ size: 0, mtimeMs: at('2026-10-22') }),
      [name('2026-10-22', 2)]: old({ size: 0, mtimeMs: at('2026-10-23') }),
      [name('2026-10-23', 2)]: old({ size: 0, mtimeMs: at('2026-10-23') }),
      [name('2027-01-01')]: old({ size: 0, mtimeMs: at('2025-01-01') }),
      [name('2025-10-22', 3)]: old({ mtimeMs: Number.NaN }),
      [`${name('2025-10-22')}.bak`]: old(),
      'notes.txt': old(),
    });
    writer.sweep();
    expect(unlinked()).toEqual([name('2025-10-22'), name('2026-10-22')]);
    expect(sweeps).toEqual([{ deleted: 2, kept: 0, complete: true }]);
    expect(Object.isFrozen(sweeps[0])).toBe(true);
  });

  it('keeps and counts what is due but no private regular file with one link', () => {
    const { writer, sweeps, unlinked } = folderWith({
      [name('2025-01-01', 1)]: old({ isFile: () => false }),
      [name('2025-01-01', 2)]: old({ uid: 0 }),
      [name('2025-01-01', 3)]: old({ mode: 0o100640 }),
      [name('2025-01-01', 4)]: old({ nlink: 2 }),
      [name('2025-01-01', 5)]: stats({
        kind: 'dir',
        mtimeMs: at('2025-01-01'),
      }),
    });
    writer.sweep();
    expect(unlinked()).toEqual([]);
    expect(sweeps).toEqual([{ deleted: 0, kept: 5, complete: true }]);
  });

  it('never deletes its own file, also under another name', () => {
    const { writer, unlinked } = folderWith({
      // A second link to the open file, with an old name.
      [name('2025-01-01')]: old({ ino: 200 + fileFd }),
    });
    writer.sweep();
    expect(unlinked()).toEqual([]);
  });

  it('counts a file that is gone as deleted by someone else, and one it cannot see or delete as kept', () => {
    const { writer, sweeps, unlinked } = folderWith(
      {
        [name('2025-01-01', 1)]: fsError('ENOENT'),
        [name('2025-01-01', 2)]: fsError('EACCES'),
        [name('2025-01-01', 3)]: old(),
        [name('2025-01-01', 4)]: old(),
      },
      {
        unlink: (path) => {
          if (path.endsWith(name('2025-01-01', 3))) throw fsError('ENOENT');
          if (path.endsWith(name('2025-01-01', 4))) throw fsError('EPERM');
        },
      },
    );
    writer.sweep();
    expect(unlinked()).toEqual([name('2025-01-01', 3), name('2025-01-01', 4)]);
    expect(sweeps).toEqual([{ deleted: 0, kept: 2, complete: true }]);
  });

  it('stops before a file when the folder is no longer the one opened', () => {
    let checks = 0;
    let armed = false;
    const sweeps: AuditSweep[] = [];
    const { writer, calls } = opened({
      readdir: () => [name('2025-01-01', 1), name('2025-01-01', 2)],
      lstat: (path) => {
        if (!armed) return undefined;
        if (path !== folderPath) return old();
        checks += 1;
        // Before reading and before the first file, then another folder.
        return stats({ kind: 'dir', ino: checks <= 2 ? 100 : 101 });
      },
    });
    writer.attach({
      anchor: () => undefined,
      swept: (given) => sweeps.push(given),
    });
    armed = true;
    writer.sweep();
    expect(calls.filter((call) => call.startsWith('unlink'))).toEqual([
      `unlink ${folderPath}/${name('2025-01-01', 1)}`,
    ]);
    expect(sweeps).toEqual([{ deleted: 1, kept: 0, complete: false }]);
  });

  it.each<[string, Hooks]>([
    [
      'a folder that cannot be read',
      {
        readdir: () => {
          throw fsError('EACCES');
        },
      },
    ],
    [
      'a folder that is a link by now',
      {
        lstat: (path) =>
          path === folderPath ? stats({ kind: 'file', ino: 100 }) : undefined,
      },
    ],
  ])('reports an incomplete sweep for %s', (_name, hooks) => {
    const sweeps: AuditSweep[] = [];
    const { writer, calls } = opened(hooks);
    writer.attach({
      anchor: () => undefined,
      swept: (given) => sweeps.push(given),
    });
    writer.sweep();
    expect(sweeps).toEqual([{ deleted: 0, kept: 0, complete: false }]);
    expect(calls.some((call) => call.startsWith('unlink'))).toBe(false);
  });

  it('reports an incomplete sweep when the folder is gone', () => {
    let armed = false;
    const sweeps: AuditSweep[] = [];
    const { writer, calls } = opened({
      lstat: (path) => {
        if (armed && path === folderPath) throw fsError('ENOENT');
        return undefined;
      },
    });
    writer.attach({
      anchor: () => undefined,
      swept: (given) => sweeps.push(given),
    });
    armed = true;
    writer.sweep();
    expect(sweeps).toEqual([{ deleted: 0, kept: 0, complete: false }]);
    expect(calls.some((call) => call.startsWith('readdir'))).toBe(false);
  });

  it('reports an incomplete sweep when the clock fails, without reading the folder', () => {
    let fails = false;
    const sweeps: AuditSweep[] = [];
    const { writer, calls } = opened(
      {},
      {
        now: () => {
          if (fails) throw new Error('clock');
          return clock.now();
        },
      },
    );
    writer.attach({
      anchor: () => undefined,
      swept: (given) => sweeps.push(given),
    });
    fails = true;
    writer.sweep();
    expect(sweeps).toEqual([{ deleted: 0, kept: 0, complete: false }]);
    expect(calls.some((call) => call.startsWith('readdir'))).toBe(false);
  });
});

describe('the sweep of the writer on the disk', () => {
  const base = mkdtempSync(join(tmpdir(), 'ecclium-audit-sweep-'));
  const at = (day: string): Date => new Date(`${day}T12:00:00.000Z`);
  const name = (day: string, number = 1): string =>
    `audit-${day}-120000-77-${String(number)}.jsonl`;

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // A file with content and a last change on a day.
  const place = (path: string, day: string, content = '{"v":1}\n'): void => {
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    utimesSync(path, at(day), at(day));
  };

  it('deletes nothing outside the files of the folder audit that are due', () => {
    const stateDir = join(base, 'decoys');
    mkdirSync(stateDir, { mode: 0o700 });
    const audit = join(stateDir, 'audit');
    mkdirSync(audit, { mode: 0o700 });
    const quota = join(stateDir, 'quota');
    mkdirSync(quota, { mode: 0o700 });
    const outside = join(base, 'outside');
    mkdirSync(outside, { mode: 0o700 });

    // Due and deleted: past the retention, and empty from yesterday.
    place(join(audit, name('2025-10-01')), '2025-10-01');
    place(join(audit, name('2026-10-22')), '2026-10-22', '');
    // Not due: within the retention, empty of today, a day to come.
    place(join(audit, name('2025-10-23')), '2025-10-23');
    place(join(audit, name('2026-10-23', 2)), '2026-10-23', '');
    place(join(audit, name('2027-01-01')), '2025-01-01');
    // Due by name but no private regular file with one link.
    place(join(outside, 'target'), '2025-01-01');
    symlinkSync(join(outside, 'target'), join(audit, name('2025-01-01', 1)));
    // The link itself is old as well, not only its target.
    lutimesSync(
      join(audit, name('2025-01-01', 1)),
      at('2025-01-01'),
      at('2025-01-01'),
    );
    mkdirSync(join(audit, name('2025-01-01', 2)), { mode: 0o700 });
    utimesSync(
      join(audit, name('2025-01-01', 2)),
      at('2025-01-01'),
      at('2025-01-01'),
    );
    place(join(audit, name('2025-01-01', 3)), '2025-01-01');
    chmodSync(join(audit, name('2025-01-01', 3)), 0o644);
    // Names that only look like audit files, and audit names elsewhere.
    place(join(audit, `${name('2025-01-01', 4)}.bak`), '2025-01-01');
    place(join(audit, 'notes.txt'), '2025-01-01');
    place(join(stateDir, name('2025-01-01', 5)), '2025-01-01');
    place(join(quota, name('2025-01-01', 6)), '2025-01-01');
    place(join(outside, name('2025-01-01', 7)), '2025-01-01');

    const result = openAuditFile({ stateDir, clock, pid, retentionMonths });
    if (!result.ok) throw new Error(result.code);
    const sweeps: AuditSweep[] = [];
    result.writer.attach({
      anchor: () => undefined,
      swept: (given) => sweeps.push(given),
    });
    result.writer.sweep();
    expect(sweeps).toEqual([{ deleted: 2, kept: 3, complete: true }]);
    expect(readdirSync(audit).sort()).toEqual(
      [
        name('2025-10-23'),
        name('2026-10-23', 2),
        name('2027-01-01'),
        name('2025-01-01', 1),
        name('2025-01-01', 2),
        name('2025-01-01', 3),
        `${name('2025-01-01', 4)}.bak`,
        'notes.txt',
        nameOf(1),
      ].sort(),
    );
    expect(readdirSync(stateDir).sort()).toEqual(
      ['audit', 'quota', name('2025-01-01', 5)].sort(),
    );
    expect(readdirSync(quota)).toEqual([name('2025-01-01', 6)]);
    expect(readdirSync(outside).sort()).toEqual(
      [name('2025-01-01', 7), 'target'].sort(),
    );
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('{"v":1}\n');
    // Its own file is empty and goes when it closes.
    result.writer.close();
    expect(readdirSync(audit)).not.toContain(nameOf(1));
  });

  it('keeps a file of a shorter retention only until its last day', () => {
    const stateDir = join(base, 'one-month');
    mkdirSync(stateDir, { mode: 0o700 });
    const audit = join(stateDir, 'audit');
    mkdirSync(audit, { mode: 0o700 });
    place(join(audit, name('2026-09-22')), '2026-09-22');
    place(join(audit, name('2026-09-23')), '2026-09-23');
    const result = openAuditFile({ stateDir, clock, pid, retentionMonths: 1 });
    if (!result.ok) throw new Error(result.code);
    result.writer.sweep();
    expect(readdirSync(audit).sort()).toEqual(
      [name('2026-09-23'), nameOf(1)].sort(),
    );
    result.writer.close();
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
