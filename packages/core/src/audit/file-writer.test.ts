import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  maxNameAttempts,
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
  readonly getuid?: () => number | undefined;
  readonly constants?: AuditFileSystem['constants'];
}

interface Fake {
  readonly fs: AuditFileSystem;
  readonly calls: string[];
  readonly closed: number[];
}

/**
 * File functions in memory: a folder audit with descriptor 10 and new
 * files from descriptor 11 up. A hook replaces one function; returning
 * undefined falls back to the default.
 */
const fake = (hooks: Hooks = {}): Fake => {
  const calls: string[] = [];
  const closed: number[] = [];
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
    writeSync: () => 0,
    closeSync: (fd) => {
      closed.push(fd);
      hooks.close?.(fd);
    },
    getuid: hooks.getuid ?? (() => 1000),
    constants: hooks.constants ?? fakeConstants,
  };
  return { fs, calls, closed };
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
    expect(result.writer.counts()).toEqual({ closed: false });
    result.writer.close();
    result.writer.close();
    expect(closed).toEqual([folderFd, 11]);
    expect(result.writer.counts()).toEqual({ closed: true });
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
