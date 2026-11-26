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

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  identityOf,
  nodeWriterFileSystem,
  sameIdentity,
  type WriterFileSystem,
  writeTokensFile,
} from './write.js';

const root = mkdtempSync(join(tmpdir(), 'ecclium-token-write-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
let folder = '';
let path = '';
beforeEach(() => {
  counter += 1;
  folder = join(root, `case-${String(counter)}`);
  mkdirSync(folder, { mode: 0o700 });
  chmodSync(folder, 0o700);
  path = join(folder, 'http-tokens.yaml');
});

describe('identityOf and sameIdentity', () => {
  it('tell a missing file, a file and something else apart', () => {
    expect(identityOf(path)).toBe('missing');
    writeFileSync(path, 'a');
    const identity = identityOf(path);
    expect(identity).toMatchObject({ size: 1 });
    expect(identityOf(folder)).toBeUndefined();
    expect(sameIdentity(identity, identityOf(path))).toBe(true);
    expect(sameIdentity('missing', 'missing')).toBe(true);
    expect(sameIdentity('missing', identity)).toBe(false);
    expect(sameIdentity(undefined, undefined)).toBe(false);
  });
});

describe('writeTokensFile', () => {
  it('creates the file with mode 0600 and leaves no temporary name', () => {
    expect(writeTokensFile(path, 'version: 1\ntokens: []\n', 'missing')).toBe(
      'written',
    );
    expect(readFileSync(path, 'utf8')).toBe('version: 1\ntokens: []\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder)).toEqual(['http-tokens.yaml']);
  });

  it('replaces the file it read whole, also one with other rights', () => {
    writeFileSync(path, 'old', { mode: 0o644 });
    chmodSync(path, 0o644);
    const before = identityOf(path);
    if (before === undefined) throw new Error('Expected a file.');
    expect(writeTokensFile(path, 'new\n', before)).toBe('written');
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a file that changed or appeared since the read', () => {
    writeFileSync(path, 'old');
    const before = identityOf(path);
    if (before === undefined) throw new Error('Expected a file.');
    writeFileSync(path, 'other, longer');
    expect(writeTokensFile(path, 'new\n', before)).toBe('changed');
    expect(readFileSync(path, 'utf8')).toBe('other, longer');
    expect(writeTokensFile(path, 'new\n', 'missing')).toBe('changed');
    expect(readdirSync(folder)).toEqual(['http-tokens.yaml']);
  });

  it('refuses a folder that group or others may write, or a link as the folder', () => {
    chmodSync(folder, 0o770);
    expect(writeTokensFile(path, 'new\n', 'missing')).toBe('unsafe');
    chmodSync(folder, 0o757);
    expect(writeTokensFile(path, 'new\n', 'missing')).toBe('unsafe');
    chmodSync(folder, 0o755);
    expect(writeTokensFile(path, 'new\n', 'missing')).toBe('written');
    const link = join(root, `link-${String(counter)}`);
    symlinkSync(folder, link);
    expect(
      writeTokensFile(join(link, 'http-tokens.yaml'), 'x\n', 'missing'),
    ).toBe('unsafe');
  });

  it('refuses a folder of another user', () => {
    const foreign: WriterFileSystem = {
      ...nodeWriterFileSystem,
      getuid: () => (nodeWriterFileSystem.getuid() ?? 0) + 1,
    };
    expect(writeTokensFile(path, 'new\n', 'missing', foreign)).toBe('unsafe');
    expect(readdirSync(folder)).toEqual([]);
  });

  it('gives unavailable for a missing folder, a platform without users and a refused rename', () => {
    expect(
      writeTokensFile(join(folder, 'none', 'tokens.yaml'), 'x\n', 'missing'),
    ).toBe('unavailable');
    expect(
      writeTokensFile(path, 'x\n', 'missing', {
        ...nodeWriterFileSystem,
        getuid: () => undefined,
      }),
    ).toBe('unavailable');
    const refusing: WriterFileSystem = {
      ...nodeWriterFileSystem,
      renameSync: () => {
        throw Object.assign(new Error('refused'), { code: 'EACCES' });
      },
    };
    expect(writeTokensFile(path, 'x\n', 'missing', refusing)).toBe(
      'unavailable',
    );
    expect(readdirSync(folder)).toEqual([]);
  });

  it('refuses a temporary file it did not make, and gives unavailable when it cannot make one', () => {
    const foreignTemporary: WriterFileSystem = {
      ...nodeWriterFileSystem,
      fstatSync: (fd) => {
        const stats = nodeWriterFileSystem.fstatSync(fd);
        return stats.isFile()
          ? {
              ...stats,
              isFile: () => true,
              isDirectory: () => false,
              uid: stats.uid + 1,
            }
          : stats;
      },
    };
    expect(writeTokensFile(path, 'x\n', 'missing', foreignTemporary)).toBe(
      'unsafe',
    );
    const noOpen: WriterFileSystem = {
      ...nodeWriterFileSystem,
      openSync: (target, flags, mode) => {
        if (mode !== undefined) {
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        }
        return nodeWriterFileSystem.openSync(target, flags);
      },
    };
    expect(writeTokensFile(path, 'x\n', 'missing', noOpen)).toBe('unavailable');
    expect(readdirSync(folder)).toEqual([]);
  });

  it('refuses a folder at the name of the file as unsafe', () => {
    const folderAtName: WriterFileSystem = {
      ...nodeWriterFileSystem,
      renameSync: () => {
        throw Object.assign(new Error('folder'), { code: 'EISDIR' });
      },
    };
    expect(writeTokensFile(path, 'x\n', 'missing', folderAtName)).toBe(
      'unsafe',
    );
    expect(readdirSync(folder)).toEqual([]);
  });

  it('counts the file as written when only the flush of the folder fails after the rename', () => {
    let opens = 0;
    const noFlush: WriterFileSystem = {
      ...nodeWriterFileSystem,
      openSync: (target, flags, mode) => {
        // The folder is opened twice: for its check and for its flush.
        if (target === folder) {
          opens += 1;
          if (opens === 2) {
            throw Object.assign(new Error('failed'), { code: 'EIO' });
          }
        }
        return nodeWriterFileSystem.openSync(target, flags, mode);
      },
    };
    expect(writeTokensFile(path, 'new\n', 'missing', noFlush)).toBe('written');
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(readdirSync(folder)).toEqual(['http-tokens.yaml']);
  });

  it('continues a partial write and gives unavailable when a write stops', () => {
    let calls = 0;
    const partial: WriterFileSystem = {
      ...nodeWriterFileSystem,
      writeSync: (fd, buffer, offset, length) => {
        calls += 1;
        return nodeWriterFileSystem.writeSync(
          fd,
          buffer,
          offset,
          Math.min(length, 3),
        );
      },
    };
    expect(writeTokensFile(path, 'version: 1\n', 'missing', partial)).toBe(
      'written',
    );
    expect(calls).toBe(4);
    expect(readFileSync(path, 'utf8')).toBe('version: 1\n');
    const stopping: WriterFileSystem = {
      ...nodeWriterFileSystem,
      writeSync: () => 0,
    };
    rmSync(path);
    expect(writeTokensFile(path, 'x\n', 'missing', stopping)).toBe(
      'unavailable',
    );
    expect(readdirSync(folder)).toEqual([]);
  });
});
