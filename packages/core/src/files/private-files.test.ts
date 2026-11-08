import {
  chmodSync,
  linkSync,
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

import {
  destroyPrivateFile,
  listPrivateFolder,
  nodePrivateFileSystem,
  preparePrivateFolder,
  PrivateFileError,
  privateFileCodes,
  type PrivateFileStats,
  type PrivateFileSystem,
  readPrivateFile,
  removePrivateFolder,
  writePrivateFileOnce,
} from './index.js';

// The files run on disk in a temporary folder of their own. A fake file
// system replaces single functions for what a test cannot build there,
// such as a file of another owner or a system that refuses.

const base = mkdtempSync(join(tmpdir(), 'ecclium-private-files-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

let count = 0;
const fresh = (): string => {
  count += 1;
  const folder = join(base, `f${String(count)}`);
  preparePrivateFolder(folder);
  return folder;
};

const withFs = (changes: Partial<PrivateFileSystem>): PrivateFileSystem =>
  Object.freeze({ ...nodePrivateFileSystem, ...changes });

const systemError = (code: string): Error =>
  Object.assign(new Error('from the system'), { code });

// Whether a descriptor belongs to a folder, for a fake that fails only the
// flush of the folder.
const isFolderFd = (fd: number): boolean =>
  nodePrivateFileSystem.fstatSync(fd).isDirectory();

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof PrivateFileError) return error.code;
    throw error;
  }
  throw new Error('expected a PrivateFileError');
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const pid = process.pid;

// Stats as a fake fstat or lstat gives them, from real ones with changes.
const changed = (
  stats: PrivateFileStats,
  changes: Partial<
    Pick<PrivateFileStats, 'uid' | 'mode' | 'nlink' | 'size'>
  > & { readonly file?: boolean; readonly directory?: boolean },
): PrivateFileStats => ({
  isFile: () => changes.file ?? stats.isFile(),
  isDirectory: () => changes.directory ?? stats.isDirectory(),
  isSymbolicLink: () => stats.isSymbolicLink(),
  uid: changes.uid ?? stats.uid,
  mode: changes.mode ?? stats.mode,
  nlink: changes.nlink ?? stats.nlink,
  size: changes.size ?? stats.size,
});

describe('PrivateFileError', () => {
  it('carries a code and a fixed message, frozen', () => {
    const error = new PrivateFileError('unsafe');
    expect(error.message).toBe('A private file failed.');
    expect(error.name).toBe('PrivateFileError');
    expect(error.code).toBe('unsafe');
    expect(Object.isFrozen(error)).toBe(true);
    expect(privateFileCodes).toEqual(['platform', 'unavailable', 'unsafe']);
  });
});

describe('preparePrivateFolder', () => {
  it('creates a folder with 0700 and accepts it again', () => {
    const folder = join(base, 'made');
    preparePrivateFolder(folder);
    preparePrivateFolder(folder);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it('refuses a folder with rights for others, a file and a link', () => {
    const open = join(base, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(
      code(() => {
        preparePrivateFolder(open);
      }),
    ).toBe('unsafe');
    const file = join(base, 'file');
    writeFileSync(file, '');
    expect(
      code(() => {
        preparePrivateFolder(file);
      }),
    ).toBe('unsafe');
    const link = join(base, 'link');
    symlinkSync(fresh(), link);
    expect(
      code(() => {
        preparePrivateFolder(link);
      }),
    ).toBe('unsafe');
  });

  it('refuses a platform without the flags or the ID of the user', () => {
    expect(
      code(() => {
        preparePrivateFolder(
          join(base, 'x'),
          withFs({
            constants: {
              ...nodePrivateFileSystem.constants,
              O_NOFOLLOW: undefined,
            },
          }),
        );
      }),
    ).toBe('platform');
    expect(
      code(() => {
        preparePrivateFolder(
          join(base, 'x'),
          withFs({ getuid: () => undefined }),
        );
      }),
    ).toBe('platform');
  });

  it('turns every refusal of the system into a code', () => {
    const folder = fresh();
    expect(
      code(() => {
        preparePrivateFolder(
          join(base, 'y'),
          withFs({
            mkdirSync: () => {
              throw systemError('EACCES');
            },
          }),
        );
      }),
    ).toBe('unavailable');
    for (const [error, expected] of [
      ['ENOTDIR', 'unsafe'],
      ['EMLINK', 'unsafe'],
      ['EACCES', 'unavailable'],
    ] as const) {
      expect(
        code(() => {
          preparePrivateFolder(
            folder,
            withFs({
              openSync: () => {
                throw systemError(error);
              },
            }),
          );
        }),
      ).toBe(expected);
    }
    expect(
      code(() => {
        preparePrivateFolder(
          folder,
          withFs({
            fstatSync: () => {
              throw systemError('EIO');
            },
          }),
        );
      }),
    ).toBe('unavailable');
    expect(
      code(() => {
        preparePrivateFolder(
          folder,
          withFs({
            fstatSync: (fd) =>
              changed(nodePrivateFileSystem.fstatSync(fd), {
                uid: process.getuid?.() === 0 ? 1 : 0,
              }),
          }),
        );
      }),
    ).toBe('unsafe');
  });

  it('reads an error that is no object or a proxy as no code', () => {
    expect(
      code(() => {
        preparePrivateFolder(
          join(base, 'z'),
          withFs({
            mkdirSync: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- a value of any kind, as a system may throw
              throw 'refused';
            },
          }),
        );
      }),
    ).toBe('unavailable');
    expect(
      code(() => {
        preparePrivateFolder(
          join(base, 'z'),
          withFs({
            mkdirSync: () => {
              throw new Proxy(systemError('EEXIST'), {});
            },
          }),
        );
      }),
    ).toBe('unavailable');
  });

  it('gives up the descriptor of the folder even when closing it fails', () => {
    const folder = fresh();
    let closed = 0;
    expect(() => {
      preparePrivateFolder(
        folder,
        withFs({
          closeSync: (fd) => {
            closed += 1;
            nodePrivateFileSystem.closeSync(fd);
            throw systemError('EIO');
          },
        }),
      );
    }).not.toThrow();
    expect(closed).toBe(1);
  });
});

describe('writePrivateFileOnce and readPrivateFile', () => {
  it('writes a file with 0600 once, keeps the first and leaves no temporary name', () => {
    const folder = fresh();
    expect(writePrivateFileOnce(folder, 'a.key', bytes('first'), { pid })).toBe(
      'written',
    );
    expect(
      writePrivateFileOnce(folder, 'a.key', bytes('second'), { pid }),
    ).toBe('exists');
    expect(readFileSync(join(folder, 'a.key'), 'utf8')).toBe('first');
    expect(statSync(join(folder, 'a.key')).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder)).toEqual(['a.key']);
    expect(new TextDecoder().decode(readPrivateFile(folder, 'a.key', 64))).toBe(
      'first',
    );
  });

  it('writes an empty file and in the root folder of a path', () => {
    const folder = fresh();
    expect(
      writePrivateFileOnce(folder, 'empty', new Uint8Array(), { pid }),
    ).toBe('written');
    expect(readPrivateFile(folder, 'empty', 0)).toEqual(new Uint8Array());
    // The root is no private folder of a test, so it is refused there.
    expect(code(() => readPrivateFile('/', 'a.key', 64))).toBe('unsafe');
  });

  it('gives undefined for a file that is not there', () => {
    expect(readPrivateFile(fresh(), 'none.key', 64)).toBeUndefined();
  });

  it('refuses a name that is no plain name of a file', () => {
    const folder = fresh();
    for (const name of ['', '.hidden', '../up', 'a/b', 'x'.repeat(129), 5]) {
      expect(() =>
        writePrivateFileOnce(folder, name as string, bytes('x'), { pid }),
      ).toThrow(TypeError);
      expect(() => readPrivateFile(folder, name as string, 64)).toThrow(
        TypeError,
      );
    }
  });

  it('refuses a file with rights for others, a link, a larger file and one with three names', () => {
    const folder = fresh();
    writeFileSync(join(folder, 'open'), 'x', { mode: 0o644 });
    chmodSync(join(folder, 'open'), 0o644);
    expect(code(() => readPrivateFile(folder, 'open', 64))).toBe('unsafe');
    writeFileSync(join(folder, 'big'), 'xx', { mode: 0o600 });
    expect(code(() => readPrivateFile(folder, 'big', 1))).toBe('unsafe');
    symlinkSync(join(folder, 'big'), join(folder, 'link'));
    expect(code(() => readPrivateFile(folder, 'link', 64))).toBe('unsafe');
    writeFileSync(join(folder, 'many'), 'x', { mode: 0o600 });
    linkSync(join(folder, 'many'), join(folder, 'many2'));
    expect(new TextDecoder().decode(readPrivateFile(folder, 'many', 64))).toBe(
      'x',
    );
    linkSync(join(folder, 'many'), join(folder, 'many3'));
    expect(code(() => readPrivateFile(folder, 'many', 64))).toBe('unsafe');
    mkdirSync(join(folder, 'dir'), { mode: 0o700 });
    expect(code(() => readPrivateFile(folder, 'dir', 64))).toBe('unsafe');
  });

  it('refuses a folder that is missing, a link or open for others', () => {
    expect(code(() => readPrivateFile(join(base, 'gone'), 'a', 64))).toBe(
      'unavailable',
    );
    const link = join(base, 'folder-link');
    symlinkSync(fresh(), link);
    expect(code(() => readPrivateFile(link, 'a', 64))).toBe('unsafe');
    const folder = fresh();
    chmodSync(folder, 0o750);
    expect(
      code(() => writePrivateFileOnce(folder, 'a', bytes('x'), { pid })),
    ).toBe('unsafe');
    expect(
      code(() =>
        readPrivateFile(
          fresh(),
          'a',
          64,
          withFs({
            lstatSync: () => {
              throw systemError('EACCES');
            },
          }),
        ),
      ),
    ).toBe('unsafe');
  });

  it('turns every refusal of the system while reading into a code', () => {
    const folder = fresh();
    writePrivateFileOnce(folder, 'a', bytes('abc'), { pid });
    for (const [error, expected] of [
      ['ELOOP', 'unsafe'],
      ['EACCES', 'unavailable'],
    ] as const) {
      expect(
        code(() =>
          readPrivateFile(
            folder,
            'a',
            64,
            withFs({
              openSync: () => {
                throw systemError(error);
              },
            }),
          ),
        ),
      ).toBe(expected);
    }
    expect(
      code(() =>
        readPrivateFile(
          folder,
          'a',
          64,
          withFs({
            fstatSync: () => {
              throw systemError('EIO');
            },
          }),
        ),
      ),
    ).toBe('unavailable');
    expect(
      code(() =>
        readPrivateFile(
          folder,
          'a',
          64,
          withFs({
            readSync: () => {
              throw systemError('EIO');
            },
          }),
        ),
      ),
    ).toBe('unavailable');
    // A file that shrank or grew while it was read.
    expect(
      code(() =>
        readPrivateFile(folder, 'a', 64, withFs({ readSync: () => 0 })),
      ),
    ).toBe('unavailable');
    expect(
      code(() =>
        readPrivateFile(
          folder,
          'a',
          64,
          withFs({ readSync: (_fd, _buffer, _offset, length) => length }),
        ),
      ),
    ).toBe('unavailable');
    expect(
      code(() =>
        readPrivateFile(
          folder,
          'a',
          64,
          withFs({
            fstatSync: (fd) =>
              changed(nodePrivateFileSystem.fstatSync(fd), { nlink: 0 }),
          }),
        ),
      ),
    ).toBe('unsafe');
  });

  it('turns every refusal of the system while writing into a code and removes the temporary name', () => {
    const folder = fresh();
    const failing = (changes: Partial<PrivateFileSystem>): string =>
      code(() =>
        writePrivateFileOnce(folder, 'a', bytes('x'), {
          pid,
          fs: withFs(changes),
        }),
      );
    expect(
      failing({
        openSync: () => {
          throw systemError('EACCES');
        },
      }),
    ).toBe('unavailable');
    expect(
      failing({
        fstatSync: (fd) =>
          changed(nodePrivateFileSystem.fstatSync(fd), { file: false }),
      }),
    ).toBe('unsafe');
    expect(failing({ writeSync: () => 0 })).toBe('unavailable');
    expect(
      failing({
        writeSync: () => {
          throw systemError('ENOSPC');
        },
      }),
    ).toBe('unavailable');
    expect(
      failing({
        linkSync: () => {
          throw systemError('EPERM');
        },
      }),
    ).toBe('unavailable');
    expect(readdirSync(folder)).toEqual([]);
    // A temporary name that cannot be removed is left to the destruction.
    expect(
      writePrivateFileOnce(folder, 'b', bytes('y'), {
        pid,
        fs: withFs({
          unlinkSync: () => {
            throw systemError('EPERM');
          },
        }),
      }),
    ).toBe('written');
    expect(
      readdirSync(folder).filter((name) => name.startsWith('.b.')),
    ).toHaveLength(1);
  });

  it('writes a file in parts when the system takes fewer bytes at once', () => {
    const folder = fresh();
    expect(
      writePrivateFileOnce(folder, 'parts', bytes('abcdef'), {
        pid,
        fs: withFs({
          writeSync: (fd, buffer, offset, _length, position) =>
            nodePrivateFileSystem.writeSync(fd, buffer, offset, 1, position),
        }),
      }),
    ).toBe('written');
    expect(readFileSync(join(folder, 'parts'), 'utf8')).toBe('abcdef');
  });

  it('flushes the folder after the link, and not for a name that is taken', () => {
    const folder = fresh();
    const calls: string[] = [];
    const folders = new Set<number>();
    const fs = withFs({
      openSync: (path, flags, mode) => {
        const fd = nodePrivateFileSystem.openSync(path, flags, mode);
        if (path === folder) folders.add(fd);
        calls.push(path === folder ? 'open folder' : 'open file');
        return fd;
      },
      fsyncSync: (fd) => {
        calls.push(folders.has(fd) ? 'fsync folder' : 'fsync file');
        nodePrivateFileSystem.fsyncSync(fd);
      },
      closeSync: (fd) => {
        folders.delete(fd);
        nodePrivateFileSystem.closeSync(fd);
      },
      linkSync: (existing, path) => {
        calls.push('link');
        nodePrivateFileSystem.linkSync(existing, path);
      },
    });
    expect(writePrivateFileOnce(folder, 'a', bytes('x'), { pid, fs })).toBe(
      'written',
    );
    expect(calls).toEqual([
      'open file',
      'fsync file',
      'link',
      'open folder',
      'fsync folder',
    ]);
    // The writer that gave the name flushed the folder.
    calls.length = 0;
    expect(writePrivateFileOnce(folder, 'a', bytes('y'), { pid, fs })).toBe(
      'exists',
    );
    expect(calls).toEqual(['open file', 'fsync file', 'link']);
  });

  it('fails when the folder does not open or flush after the link, and leaves the file under its name', () => {
    const folder = fresh();
    const failing = (name: string, changes: Partial<PrivateFileSystem>) =>
      code(() =>
        writePrivateFileOnce(folder, name, bytes(name), {
          pid,
          fs: withFs(changes),
        }),
      );
    expect(
      failing('a', {
        openSync: (path, flags, mode) => {
          if (path === folder) throw systemError('EMFILE');
          return nodePrivateFileSystem.openSync(path, flags, mode);
        },
      }),
    ).toBe('unavailable');
    expect(
      failing('b', {
        fsyncSync: (fd) => {
          if (isFolderFd(fd)) throw systemError('EIO');
          nodePrivateFileSystem.fsyncSync(fd);
        },
      }),
    ).toBe('unavailable');
    // No temporary name stays, and a second try finds the first file.
    expect(readdirSync(folder)).toEqual(['a', 'b']);
    expect(writePrivateFileOnce(folder, 'b', bytes('c'), { pid })).toBe(
      'exists',
    );
    expect(readFileSync(join(folder, 'b'), 'utf8')).toBe('b');
  });

  it('takes a file system that cannot flush a folder', () => {
    const folder = fresh();
    for (const refusal of ['EINVAL', 'ENOTSUP']) {
      expect(
        writePrivateFileOnce(folder, refusal, bytes('x'), {
          pid,
          fs: withFs({
            fsyncSync: (fd) => {
              if (isFolderFd(fd)) throw systemError(refusal);
              nodePrivateFileSystem.fsyncSync(fd);
            },
          }),
        }),
      ).toBe('written');
    }
    expect(readdirSync(folder)).toEqual(['EINVAL', 'ENOTSUP']);
  });
});

describe('listPrivateFolder', () => {
  it('lists the names sorted, and none for a folder that is not there', () => {
    const folder = fresh();
    writePrivateFileOnce(folder, 'b', bytes('2'), { pid });
    writePrivateFileOnce(folder, 'a', bytes('1'), { pid });
    expect(listPrivateFolder(folder)).toEqual(['a', 'b']);
    expect(Object.isFrozen(listPrivateFolder(folder))).toBe(true);
    expect(listPrivateFolder(join(base, 'none'))).toEqual([]);
  });

  it('refuses a folder that is a link or does not list', () => {
    const link = join(base, 'list-link');
    symlinkSync(fresh(), link);
    expect(code(() => listPrivateFolder(link))).toBe('unsafe');
    expect(
      code(() =>
        listPrivateFolder(
          fresh(),
          withFs({
            readdirSync: () => {
              throw systemError('EIO');
            },
          }),
        ),
      ),
    ).toBe('unavailable');
    expect(
      code(() =>
        listPrivateFolder(
          fresh(),
          withFs({
            lstatSync: () => {
              throw systemError('EACCES');
            },
          }),
        ),
      ),
    ).toBe('unsafe');
  });
});

describe('destroyPrivateFile', () => {
  const temporaryName = '.a.key.1.0000000000000000.tmp';

  it('writes zeros over the file, removes its name and leaves a second name with zeros', () => {
    const folder = fresh();
    writePrivateFileOnce(folder, 'a.key', bytes('secret'), { pid });
    linkSync(join(folder, 'a.key'), join(folder, temporaryName));
    expect(destroyPrivateFile(folder, 'a.key', 64)).toBe(true);
    expect(readdirSync(folder)).toEqual([temporaryName]);
    expect(readFileSync(join(folder, temporaryName))).toEqual(Buffer.alloc(6));
    expect(destroyPrivateFile(folder, temporaryName, 64)).toBe(true);
    expect(readdirSync(folder)).toEqual([]);
    expect(destroyPrivateFile(folder, 'a.key', 64)).toBe(false);
  });

  it('refuses a name that is neither a plain nor a temporary name', () => {
    const folder = fresh();
    for (const name of [
      '..',
      './x',
      '.',
      'a/b',
      '.a.key',
      '.a.key.1.000.tmp',
      `.${'x'.repeat(129)}.1.0000000000000000.tmp`,
      5,
    ]) {
      expect(() => destroyPrivateFile(folder, name as string, 64)).toThrow(
        TypeError,
      );
    }
  });

  it('removes a file with rights for others after zeros, a file without the right to write and a larger one without zeros', () => {
    const folder = fresh();
    writeFileSync(join(folder, 'open'), 'x', { mode: 0o644 });
    chmodSync(join(folder, 'open'), 0o644);
    linkSync(join(folder, 'open'), join(folder, 'open2'));
    expect(destroyPrivateFile(folder, 'open', 64)).toBe(true);
    expect(readFileSync(join(folder, 'open2'))).toEqual(Buffer.alloc(1));
    writeFileSync(join(folder, 'locked'), 'y', { mode: 0o400 });
    chmodSync(join(folder, 'locked'), 0o400);
    expect(destroyPrivateFile(folder, 'locked', 64)).toBe(true);
    writeFileSync(join(folder, 'big'), 'xx', { mode: 0o600 });
    linkSync(join(folder, 'big'), join(folder, 'big2'));
    expect(destroyPrivateFile(folder, 'big', 1)).toBe(true);
    expect(readFileSync(join(folder, 'big2'), 'utf8')).toBe('xx');
    expect(readdirSync(folder).sort()).toEqual(['big2', 'open2']);
  });

  it('removes a link without touching its target, and refuses a folder and an entry of another user', () => {
    const folder = fresh();
    writeFileSync(join(folder, 'target'), 'keep', { mode: 0o600 });
    symlinkSync(join(folder, 'target'), join(folder, 'link'));
    expect(destroyPrivateFile(folder, 'link', 64)).toBe(true);
    expect(readFileSync(join(folder, 'target'), 'utf8')).toBe('keep');
    mkdirSync(join(folder, 'dir'), { mode: 0o700 });
    expect(code(() => destroyPrivateFile(folder, 'dir', 64))).toBe('unsafe');
    expect(
      code(() =>
        destroyPrivateFile(
          folder,
          'target',
          64,
          withFs({
            lstatSync: (path) => {
              const stats = nodePrivateFileSystem.lstatSync(path);
              return path.endsWith('/target')
                ? changed(stats, { uid: (process.getuid?.() ?? 0) + 1 })
                : stats;
            },
          }),
        ),
      ),
    ).toBe('unsafe');
    expect(readFileSync(join(folder, 'target'), 'utf8')).toBe('keep');
  });

  it('removes the name when zeros cannot be written, and reports a name that cannot be removed', () => {
    const folder = fresh();
    const removed = (changes: Partial<PrivateFileSystem>): boolean => {
      writePrivateFileOnce(folder, 'a', bytes('x'), { pid });
      return destroyPrivateFile(folder, 'a', 64, withFs(changes));
    };
    expect(
      removed({
        openSync: (path, flags, mode) => {
          if (path.endsWith('/a')) throw systemError('EACCES');
          return nodePrivateFileSystem.openSync(path, flags, mode);
        },
      }),
    ).toBe(true);
    expect(
      removed({
        fstatSync: () => {
          throw systemError('EIO');
        },
      }),
    ).toBe(true);
    expect(
      removed({
        fstatSync: (fd) =>
          changed(nodePrivateFileSystem.fstatSync(fd), { file: false }),
      }),
    ).toBe(true);
    expect(removed({ writeSync: () => 0 })).toBe(true);
    expect(
      removed({
        fsyncSync: () => {
          throw systemError('EIO');
        },
      }),
    ).toBe(true);
    expect(readdirSync(folder)).toEqual([]);
    writePrivateFileOnce(folder, 'a', bytes('x'), { pid });
    expect(
      code(() =>
        destroyPrivateFile(
          folder,
          'a',
          64,
          withFs({
            unlinkSync: () => {
              throw systemError('EPERM');
            },
          }),
        ),
      ),
    ).toBe('unavailable');
    expect(
      code(() =>
        destroyPrivateFile(
          folder,
          'a',
          64,
          withFs({
            lstatSync: (path) => {
              if (path.endsWith('/a')) throw systemError('EIO');
              return nodePrivateFileSystem.lstatSync(path);
            },
          }),
        ),
      ),
    ).toBe('unavailable');
    // A name another process removed in between is gone all the same.
    expect(
      destroyPrivateFile(
        folder,
        'a',
        64,
        withFs({
          unlinkSync: (path) => {
            nodePrivateFileSystem.unlinkSync(path);
            throw systemError('ENOENT');
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('removePrivateFolder', () => {
  it('removes an empty folder, and counts a folder that is not there as removed', () => {
    const folder = fresh();
    removePrivateFolder(folder);
    expect(() => statSync(folder)).toThrow();
    removePrivateFolder(folder);
    // Another process removed it between the look and the removal.
    const raced = fresh();
    removePrivateFolder(
      raced,
      withFs({
        rmdirSync: (path) => {
          nodePrivateFileSystem.rmdirSync(path);
          throw systemError('ENOENT');
        },
      }),
    );
    expect(() => statSync(raced)).toThrow();
  });

  it('refuses a link, a file and a folder that is not empty, and keeps them', () => {
    const target = fresh();
    const link = join(base, 'remove-link');
    symlinkSync(target, link);
    expect(
      code(() => {
        removePrivateFolder(link);
      }),
    ).toBe('unsafe');
    expect(statSync(target).isDirectory()).toBe(true);
    const full = fresh();
    const file = join(full, 'file');
    writeFileSync(file, 'x', { mode: 0o600 });
    expect(
      code(() => {
        removePrivateFolder(file);
      }),
    ).toBe('unsafe');
    expect(
      code(() => {
        removePrivateFolder(full);
      }),
    ).toBe('unavailable');
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('turns every refusal of the system into a code', () => {
    const folder = fresh();
    expect(
      code(() => {
        removePrivateFolder(
          folder,
          withFs({
            lstatSync: () => {
              throw systemError('EACCES');
            },
          }),
        );
      }),
    ).toBe('unavailable');
    expect(
      code(() => {
        removePrivateFolder(
          folder,
          withFs({
            rmdirSync: () => {
              throw systemError('EBUSY');
            },
          }),
        );
      }),
    ).toBe('unavailable');
    expect(statSync(folder).isDirectory()).toBe(true);
  });
});
