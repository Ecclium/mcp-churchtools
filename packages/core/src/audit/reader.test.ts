import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { maxLineLength } from '../logger/index.js';
import {
  type AuditLine,
  type AuditReadFileSystem,
  auditFolderCodes,
  openAuditFolder,
  readChunkSize,
} from './reader.js';

// Real folders and files in a temporary folder cover what the disk can
// show: modes, links, names and lines. Injected file functions, which
// wrap those of node:fs, cover what a test cannot build there, such as a
// failed read or a folder of another owner.

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const nameOf = (number: number, day = '2026-10-31'): string =>
  `audit-${day}-120000-4242-${String(number)}.jsonl`;

const base = mkdtempSync(join(tmpdir(), 'ecclium-audit-reader-'));
let folders = 0;

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A new private folder of state with a private folder audit. */
const makeState = (): { stateDir: string; auditDir: string } => {
  folders += 1;
  const stateDir = join(base, `state-${String(folders)}`);
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const auditDir = join(stateDir, 'audit');
  mkdirSync(auditDir, { mode: 0o700 });
  chmodSync(auditDir, 0o700);
  return { stateDir, auditDir };
};

/** Writes a private file into the folder audit. */
const put = (auditDir: string, name: string, content: string | Uint8Array) => {
  const path = join(auditDir, name);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

const realFs: AuditReadFileSystem = {
  openSync: (path, flags) => openSync(path, flags),
  fstatSync,
  lstatSync,
  readSync,
  closeSync,
  readdirSync: (path) => readdirSync(path),
  getuid: () => process.getuid?.(),
  constants,
};

const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: /path/to/state/audit`), { code });

/** Opens the folder and reads one file, with all its lines. */
const linesOf = (
  stateDir: string,
  name: string,
  fs: AuditReadFileSystem = realFs,
): { outcome: string; lines: AuditLine[] } => {
  const opened = openAuditFolder({ stateDir, fs });
  if (!opened.ok) throw new Error(opened.code);
  const lines: AuditLine[] = [];
  const outcome = opened.folder.read(name, (line) => lines.push(line));
  return { outcome, lines };
};

describe('openAuditFolder on the disk', () => {
  it('lists the audit files sorted and counts the other entries', () => {
    const { stateDir, auditDir } = makeState();
    put(auditDir, nameOf(2), '');
    put(auditDir, nameOf(1), '');
    put(auditDir, nameOf(3, '2026-10-30'), '');
    // A name of another form, a day that does not exist and a folder.
    put(auditDir, 'notes.txt', '');
    put(auditDir, nameOf(1, '2026-02-30'), '');
    mkdirSync(join(auditDir, 'sub'));

    const opened = openAuditFolder({ stateDir });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.folder.names).toEqual([
      nameOf(3, '2026-10-30'),
      nameOf(1),
      nameOf(2),
    ]);
    expect(opened.folder.others).toBe(3);
    expect(Object.isFrozen(opened.folder.names)).toBe(true);
  });

  it('refuses a missing folder audit and creates nothing', () => {
    const { stateDir, auditDir } = makeState();
    rmSync(auditDir, { recursive: true });

    expect(openAuditFolder({ stateDir })).toEqual({
      ok: false,
      code: 'audit_folder_missing',
    });
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('refuses a link, a file and an open folder in place of audit', () => {
    const link = makeState();
    const elsewhere = join(base, `elsewhere-${String(folders)}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    rmSync(link.auditDir, { recursive: true });
    symlinkSync(elsewhere, link.auditDir);

    const file = makeState();
    rmSync(file.auditDir, { recursive: true });
    writeFileSync(file.auditDir, '', { mode: 0o600 });

    const open = makeState();
    chmodSync(open.auditDir, 0o755);

    for (const { stateDir } of [link, file, open]) {
      expect(openAuditFolder({ stateDir })).toEqual({
        ok: false,
        code: 'audit_folder_unsafe',
      });
    }
  });

  it('throws for a folder of state that is no absolute normalised path', () => {
    for (const stateDir of ['relative', '/path/to/state/', 42]) {
      expect(() =>
        openAuditFolder({ stateDir: stateDir as string, fs: realFs }),
      ).toThrow(TypeError);
    }
  });

  it('knows its codes', () => {
    expect(auditFolderCodes).toEqual([
      'audit_read_platform',
      'audit_folder_missing',
      'audit_folder_unsafe',
      'audit_folder_unavailable',
    ]);
    expect(Object.isFrozen(auditFolderCodes)).toBe(true);
  });
});

describe('the lines of a file', () => {
  it('splits at the line break and hashes the bytes of each line', () => {
    const { stateDir, auditDir } = makeState();
    put(auditDir, nameOf(1), '{"a":1}\n{"b":2}~\n\n{"c":3}\n{"rest');

    const { outcome, lines } = linesOf(stateDir, nameOf(1));

    expect(outcome).toBe('read');
    expect(lines).toEqual([
      {
        number: 1,
        hash: sha256('{"a":1}'),
        text: '{"a":1}',
        tooLong: false,
        piece: false,
      },
      {
        number: 2,
        hash: sha256('{"b":2}~'),
        text: '{"b":2}~',
        tooLong: false,
        piece: true,
      },
      { number: 3, hash: sha256(''), text: '', tooLong: false, piece: false },
      {
        number: 4,
        hash: sha256('{"c":3}'),
        text: '{"c":3}',
        tooLong: false,
        piece: false,
      },
    ]);
    expect(lines.every((line) => Object.isFrozen(line))).toBe(true);
  });

  it('gives no text for bytes outside printable ASCII, but their hash', () => {
    const { stateDir, auditDir } = makeState();
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('{"a":1}\r\n'),
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('{"b":2}\nä\n'),
    ]);
    put(auditDir, nameOf(1), bytes);

    const { lines } = linesOf(stateDir, nameOf(1));

    expect(lines.map((line) => line.text)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(lines[0]?.hash).toBe(sha256('{"a":1}\r'));
    expect(lines[1]?.hash).toBe(
      sha256(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode('{"b":2}'),
        ]),
      ),
    );
    expect(lines[2]?.hash).toBe(sha256(new Uint8Array([0xc3, 0xa4])));
  });

  it('reads lines across the pieces it reads and marks a line too long', () => {
    const { stateDir, auditDir } = makeState();
    const long = 'x'.repeat(readChunkSize + 10);
    const longest = 'y'.repeat(maxLineLength);
    const tooLong = `${'z'.repeat(maxLineLength)}~`;
    put(auditDir, nameOf(1), `${long}\n${longest}\n${tooLong}\n`);

    const { lines } = linesOf(stateDir, nameOf(1));

    expect(lines).toEqual([
      {
        number: 1,
        hash: sha256(long),
        text: undefined,
        tooLong: true,
        piece: false,
      },
      {
        number: 2,
        hash: sha256(longest),
        text: longest,
        tooLong: false,
        piece: false,
      },
      {
        number: 3,
        hash: sha256(tooLong),
        text: undefined,
        tooLong: true,
        piece: true,
      },
    ]);
  });

  it('reads an empty file and a file without a line break as no line', () => {
    const { stateDir, auditDir } = makeState();
    put(auditDir, nameOf(1), '');
    put(auditDir, nameOf(2), '{"rest":true}');

    expect(linesOf(stateDir, nameOf(1))).toEqual({
      outcome: 'read',
      lines: [],
    });
    expect(linesOf(stateDir, nameOf(2))).toEqual({
      outcome: 'read',
      lines: [],
    });
  });
});

describe('the checks of a file on the disk', () => {
  it('reads nothing of a name it did not list or of a file that went', () => {
    const { stateDir, auditDir } = makeState();
    const path = put(auditDir, nameOf(1), '{"a":1}\n');
    const opened = openAuditFolder({ stateDir });
    if (!opened.ok) throw new Error(opened.code);
    unlinkSync(path);

    const seen: AuditLine[] = [];
    expect(opened.folder.read(nameOf(1), (line) => seen.push(line))).toBe(
      'gone',
    );
    expect(opened.folder.read(nameOf(9), (line) => seen.push(line))).toBe(
      'gone',
    );
    expect(opened.folder.read('notes.txt', (line) => seen.push(line))).toBe(
      'gone',
    );
    expect(seen).toEqual([]);
  });

  it('refuses a link, a folder, an open file and a file with two links', () => {
    const { stateDir, auditDir } = makeState();
    const target = put(auditDir, 'target.txt', '{"a":1}\n');
    symlinkSync(target, join(auditDir, nameOf(1)));
    mkdirSync(join(auditDir, nameOf(2)), { mode: 0o700 });
    const open = put(auditDir, nameOf(3), '{"a":1}\n');
    chmodSync(open, 0o644);
    const linked = put(auditDir, nameOf(4), '{"a":1}\n');
    linkSync(linked, join(base, `outside-${String(folders)}`));

    for (const number of [1, 2, 3, 4]) {
      expect(linesOf(stateDir, nameOf(number))).toEqual({
        outcome: 'unsafe',
        lines: [],
      });
    }
  });

  it('stops when the folder audit is no longer the one opened', () => {
    const { stateDir, auditDir } = makeState();
    put(auditDir, nameOf(1), '{"a":1}\n');
    const opened = openAuditFolder({ stateDir });
    if (!opened.ok) throw new Error(opened.code);
    renameSync(auditDir, join(stateDir, 'old'));
    mkdirSync(auditDir, { mode: 0o700 });
    put(auditDir, nameOf(1), '{"b":2}\n');

    expect(opened.folder.read(nameOf(1), () => undefined)).toBe('moved');
  });

  it('ends as unreadable when the callback throws', () => {
    const { stateDir, auditDir } = makeState();
    put(auditDir, nameOf(1), '{"a":1}\n');
    const opened = openAuditFolder({ stateDir });
    if (!opened.ok) throw new Error(opened.code);

    expect(
      opened.folder.read(nameOf(1), () => {
        throw new Error('callback');
      }),
    ).toBe('unreadable');
  });
});

describe('openAuditFolder with file functions', () => {
  const stateDir = '/path/to/state';
  const folderStats = {
    isFile: () => false,
    isDirectory: () => true,
    uid: 501,
    mode: 0o40700,
    nlink: 2,
    dev: 1,
    ino: 10,
  };
  const fileStats = {
    isFile: () => true,
    isDirectory: () => false,
    uid: 501,
    mode: 0o100600,
    nlink: 1,
    dev: 1,
    ino: 11,
  };
  const content = new TextEncoder().encode('{"a":1}\n');

  /** File functions for one folder with one file, and what to change. */
  const fake = (
    changes: Partial<AuditReadFileSystem> = {},
  ): AuditReadFileSystem => ({
    openSync: (path) => (path.endsWith('/audit') ? 7 : 8),
    fstatSync: (fd) => (fd === 7 ? folderStats : fileStats),
    lstatSync: (path) => (path.endsWith('/audit') ? folderStats : fileStats),
    readSync: (() => {
      let done = false;
      return (_fd, buffer) => {
        if (done) return 0;
        done = true;
        buffer.set(content);
        return content.length;
      };
    })(),
    closeSync: () => undefined,
    readdirSync: () => [nameOf(1)],
    getuid: () => 501,
    constants,
    ...changes,
  });

  it('reads the file of the fake folder', () => {
    expect(linesOf(stateDir, nameOf(1), fake()).lines).toHaveLength(1);
  });

  it('refuses a platform without the flags or the ID of the user', () => {
    for (const changes of [
      { getuid: () => undefined },
      { constants: { ...constants, O_NOFOLLOW: undefined } },
      { constants: { ...constants, O_DIRECTORY: undefined } },
      { constants: { ...constants, O_NOCTTY: undefined } },
      { constants: { ...constants, O_NONBLOCK: undefined } },
      { constants: { ...constants, O_RDONLY: undefined } },
    ]) {
      expect(openAuditFolder({ stateDir, fs: fake(changes) })).toEqual({
        ok: false,
        code: 'audit_read_platform',
      });
    }
  });

  it('tells the reason an open of the folder fails', () => {
    const cases: [unknown, string][] = [
      [fsError('ENOENT'), 'audit_folder_missing'],
      [fsError('ELOOP'), 'audit_folder_unsafe'],
      [fsError('ENOTDIR'), 'audit_folder_unsafe'],
      [fsError('EMLINK'), 'audit_folder_unsafe'],
      [fsError('EACCES'), 'audit_folder_unavailable'],
      ['not an error', 'audit_folder_unavailable'],
      [null, 'audit_folder_unavailable'],
      [new Proxy({ code: 'ENOENT' }, {}), 'audit_folder_unavailable'],
    ];
    for (const [thrown, code] of cases) {
      const fs = fake({
        openSync: () => {
          throw thrown;
        },
      });
      expect(openAuditFolder({ stateDir, fs })).toEqual({ ok: false, code });
    }
  });

  it('refuses a folder of another owner, with rights for others or no folder', () => {
    for (const stats of [
      { ...folderStats, uid: 502 },
      { ...folderStats, mode: 0o40750 },
      { ...folderStats, isDirectory: () => false },
    ]) {
      const fs = fake({ fstatSync: (fd) => (fd === 7 ? stats : fileStats) });
      expect(openAuditFolder({ stateDir, fs })).toEqual({
        ok: false,
        code: 'audit_folder_unsafe',
      });
    }
  });

  it('gives unavailable when fstat or readdir fails, and ignores close', () => {
    const fstat = fake({
      fstatSync: () => {
        throw fsError('EIO');
      },
      closeSync: () => {
        throw fsError('EBADF');
      },
    });
    const readdir = fake({
      readdirSync: () => {
        throw fsError('EACCES');
      },
    });
    for (const fs of [fstat, readdir]) {
      expect(openAuditFolder({ stateDir, fs })).toEqual({
        ok: false,
        code: 'audit_folder_unavailable',
      });
    }
  });

  it('refuses a folder whose path leads elsewhere after the listing', () => {
    for (const lstat of [
      () => ({ ...folderStats, ino: 99 }),
      () => ({ ...folderStats, dev: 99 }),
      () => ({ ...folderStats, isDirectory: () => false }),
      () => {
        throw fsError('ENOENT');
      },
    ]) {
      const fs = fake({ lstatSync: lstat });
      expect(openAuditFolder({ stateDir, fs })).toEqual({
        ok: false,
        code: 'audit_folder_unsafe',
      });
    }
  });

  it('builds the path of the folder audit for the root as the folder of state', () => {
    const paths: string[] = [];
    const fs = fake({
      openSync: (path) => {
        paths.push(path);
        return 7;
      },
    });
    openAuditFolder({ stateDir: '/', fs });
    expect(paths).toEqual(['/audit']);
  });

  it('tells the outcome when a check of a file fails', () => {
    const cases: [Partial<AuditReadFileSystem>, string][] = [
      [
        {
          lstatSync: (path) => {
            if (path.endsWith('/audit')) return folderStats;
            throw fsError('EACCES');
          },
        },
        'unreadable',
      ],
      [
        {
          openSync: (path) => {
            if (path.endsWith('/audit')) return 7;
            throw fsError('ENOENT');
          },
        },
        'gone',
      ],
      [
        {
          openSync: (path) => {
            if (path.endsWith('/audit')) return 7;
            throw fsError('ELOOP');
          },
        },
        'unsafe',
      ],
      [
        {
          openSync: (path) => {
            if (path.endsWith('/audit')) return 7;
            throw fsError('EMLINK');
          },
        },
        'unsafe',
      ],
      [
        {
          openSync: (path) => {
            if (path.endsWith('/audit')) return 7;
            throw fsError('EACCES');
          },
        },
        'unreadable',
      ],
      [
        {
          fstatSync: (fd) => {
            if (fd === 7) return folderStats;
            throw fsError('EIO');
          },
        },
        'unreadable',
      ],
      [
        {
          fstatSync: (fd) =>
            fd === 7 ? folderStats : { ...fileStats, uid: 502 },
        },
        'unsafe',
      ],
      [
        {
          fstatSync: (fd) =>
            fd === 7 ? folderStats : { ...fileStats, nlink: 2 },
        },
        'unsafe',
      ],
      [
        {
          fstatSync: (fd) =>
            fd === 7 ? folderStats : { ...fileStats, dev: 2 },
        },
        'unsafe',
      ],
      [
        {
          fstatSync: (fd) =>
            fd === 7 ? folderStats : { ...fileStats, ino: 2 },
        },
        'unsafe',
      ],
      [
        {
          fstatSync: (fd) =>
            fd === 7 ? folderStats : { ...fileStats, isFile: () => false },
        },
        'unsafe',
      ],
      [
        {
          readSync: () => {
            throw fsError('EIO');
          },
        },
        'unreadable',
      ],
      [{ readSync: () => -1 }, 'unreadable'],
      [{ readSync: () => readChunkSize + 1 }, 'unreadable'],
      [{ readSync: () => 0.5 }, 'unreadable'],
    ];
    for (const [changes, outcome] of cases) {
      expect(linesOf(stateDir, nameOf(1), fake(changes)).outcome).toBe(outcome);
    }
  });

  it('closes the file and ignores a failed close', () => {
    const closed: number[] = [];
    const fs = fake({
      closeSync: (fd) => {
        closed.push(fd);
        if (fd === 8) throw fsError('EBADF');
      },
    });
    expect(linesOf(stateDir, nameOf(1), fs).outcome).toBe('read');
    expect(closed).toEqual([7, 8]);
  });
});
