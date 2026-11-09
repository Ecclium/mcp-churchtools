import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type ConfigDirectoryStats,
  type ConfigDirectorySystem,
  configFileReasons,
  type ConfigFileSystem,
  listConfigDirectory,
  maxConfigDirectoryEntries,
  readConfigTextFile,
} from './text-file.js';

// Real files and folders in a temporary folder cover what the disk can
// show: modes, links and contents. Injected functions cover what a test
// cannot build there, such as a folder of another owner. The file of the
// policy, which uses the same reader, has the full set of cases for files.

let root = '';

const folder = (name: string, mode = 0o700): string => {
  const path = join(root, name);
  mkdirSync(path);
  chmodSync(path, mode);
  return path;
};

const file = (path: string, content: string, mode = 0o600): string => {
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ecclium-config-files-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readConfigTextFile', () => {
  it('reads the text of a file up to its limit', () => {
    const path = file(join(root, 'routine.yaml'), 'id: a\n', 0o644);
    expect(readConfigTextFile(path, 6)).toEqual({ ok: true, text: 'id: a\n' });
    expect(readConfigTextFile(path, 5)).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(Object.isFrozen(readConfigTextFile(path, 6))).toBe(true);
  });

  it('refuses a file below a path part that is no folder as unsafe', () => {
    const path = file(join(root, 'plain'), 'x');
    expect(readConfigTextFile(join(path, 'inner.md'), 10)).toEqual({
      ok: false,
      reason: 'unsafe',
    });
  });

  it('refuses a folder, a link and a missing file', () => {
    const inner = folder('inner-folder');
    const target = file(join(root, 'target.md'), 'x');
    const link = join(root, 'link.md');
    symlinkSync(target, link);
    expect(readConfigTextFile(inner, 10)).toEqual({
      ok: false,
      reason: 'not_regular',
    });
    expect(readConfigTextFile(link, 10)).toEqual({
      ok: false,
      reason: 'symlink',
    });
    expect(readConfigTextFile(join(root, 'none.md'), 10)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses %s as a limit',
    (limit) => {
      expect(() => readConfigTextFile('/path/to/file', limit)).toThrow(
        TypeError,
      );
    },
  );

  it('refuses a path that is not a string', () => {
    expect(() =>
      readConfigTextFile(12 as unknown as string, 10, {} as ConfigFileSystem),
    ).toThrow(TypeError);
  });
});

// Folder functions over one folder in memory, with the stats, the names
// and the errors a case needs.
const memoryFolder = (
  options: {
    readonly stats?: Partial<Omit<ConfigDirectoryStats, 'isDirectory'>> & {
      readonly isDirectory?: boolean;
    };
    readonly names?: unknown;
    readonly open?: () => never;
    readonly fstat?: () => never;
    readonly readdir?: () => never;
    readonly link?: boolean | 'fails';
    readonly getuid?: () => number | undefined;
    readonly constants?: ConfigDirectorySystem['constants'];
  } = {},
): ConfigDirectorySystem & { readonly flags: number[] } => {
  const flags: number[] = [];
  return {
    flags,
    openSync: (_path, flag) => {
      flags.push(flag);
      options.open?.();
      return 3;
    },
    fstatSync: () => {
      options.fstat?.();
      return {
        isDirectory: () => options.stats?.isDirectory ?? true,
        uid: options.stats?.uid ?? 1000,
        mode: options.stats?.mode ?? 0o40700,
      };
    },
    closeSync: () => {
      throw new Error('close fails, which changes nothing');
    },
    readdirSync: () => {
      options.readdir?.();
      return (options.names ?? ['b.yaml', 'a.yaml']) as readonly string[];
    },
    lstatSync: () => {
      if (options.link === 'fails') throw new Error('lstat fails');
      return { isSymbolicLink: () => options.link === true };
    },
    getuid: options.getuid ?? (() => 1000),
    constants: options.constants ?? {
      O_RDONLY: 0,
      O_NOFOLLOW: 1,
      O_NONBLOCK: 2,
      O_DIRECTORY: 8,
    },
  };
};

const fsError = (code: string) => (): never => {
  throw Object.assign(new Error(`${code}: /path/to/secret-folder`), { code });
};

describe('listConfigDirectory on disk', () => {
  it('lists the names of a folder, sorted and frozen', () => {
    const path = folder('routines', 0o755);
    file(join(path, 'termin-vorschau.yaml'), 'x');
    file(join(path, 'dienstplan-report.yaml'), 'x');
    folder('routines/prompts');
    const listed = listConfigDirectory(path);
    expect(listed).toEqual({
      ok: true,
      names: ['dienstplan-report.yaml', 'prompts', 'termin-vorschau.yaml'],
    });
    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed.ok && Object.isFrozen(listed.names)).toBe(true);
  });

  it.each([
    ['the group may write', 0o770],
    ['others may write', 0o707],
  ])('refuses a folder %s', (_name, mode) => {
    expect(
      listConfigDirectory(folder(`mode-${mode.toString(8)}`, mode)),
    ).toEqual({ ok: false, reason: 'mode' });
  });

  it('refuses a link to a folder, a file, a missing folder and a relative path', () => {
    const target = folder('target-folder');
    const link = join(root, 'linked-folder');
    symlinkSync(target, link);
    const plain = file(join(root, 'not-a-folder'), 'x');
    expect(listConfigDirectory(link)).toEqual({ ok: false, reason: 'symlink' });
    expect(listConfigDirectory(plain)).toEqual({
      ok: false,
      reason: 'not_directory',
    });
    expect(listConfigDirectory(join(root, 'none'))).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(listConfigDirectory('routines')).toEqual({
      ok: false,
      reason: 'relative',
    });
  });
});

describe('listConfigDirectory with injected functions', () => {
  it('opens without following a link, without blocking and only a folder', () => {
    const fs = memoryFolder();
    expect(listConfigDirectory('/path/to/routines', fs)).toEqual({
      ok: true,
      names: ['a.yaml', 'b.yaml'],
    });
    expect(fs.flags).toEqual([0 | 1 | 2 | 8]);
  });

  it.each<[string, Parameters<typeof memoryFolder>[0], string]>([
    ['a folder of another user', { stats: { uid: 0 } }, 'owner'],
    ['no folder', { stats: { isDirectory: false } }, 'not_directory'],
    ['a failing stat', { fstat: fsError('EIO') }, 'unsafe'],
    ['an unreadable folder', { open: fsError('EACCES') }, 'unreadable'],
    [
      'a file where open says so',
      { open: fsError('ENOTDIR') },
      'not_directory',
    ],
    [
      'a link where open says no folder',
      { open: fsError('ENOTDIR'), link: true },
      'symlink',
    ],
    [
      'no folder when the second look fails',
      { open: fsError('ENOTDIR'), link: 'fails' },
      'not_directory',
    ],
    ['a refused open', { open: fsError('EPERM') }, 'unreadable'],
    ['a link under EMLINK', { open: fsError('EMLINK') }, 'symlink'],
    ['an unknown error of open', { open: fsError('EIO') }, 'unsafe'],
    [
      'an error that is no object',
      {
        open: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case of a thrown value that is no error
          throw 'ENOENT';
        },
      },
      'unsafe',
    ],
    [
      'a folder that goes before it is listed',
      { readdir: fsError('ENOENT') },
      'missing',
    ],
    ['names that are no list', { names: 'a.yaml' }, 'unsafe'],
    ['a name that is no text', { names: ['a.yaml', 1] }, 'unsafe'],
    [
      'too many entries',
      {
        names: Array.from(
          { length: maxConfigDirectoryEntries + 1 },
          (_, index) => `routine-${String(index)}.yaml`,
        ),
      },
      'too_large',
    ],
    [
      'a platform without the ID of the user',
      { getuid: () => undefined },
      'platform',
    ],
    [
      'a platform without O_DIRECTORY',
      { constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 } },
      'platform',
    ],
  ])('refuses %s', (_name, options, reason) => {
    expect(
      listConfigDirectory('/path/to/routines', memoryFolder(options)),
    ).toEqual({ ok: false, reason });
  });

  it('takes exactly the most entries', () => {
    const names = Array.from(
      { length: maxConfigDirectoryEntries },
      (_, index) => `routine-${String(index)}.yaml`,
    );
    const listed = listConfigDirectory(
      '/path/to/routines',
      memoryFolder({ names }),
    );
    expect(listed.ok && listed.names.length).toBe(maxConfigDirectoryEntries);
  });

  it('never names the path or the message of the file system', () => {
    const listed = listConfigDirectory(
      '/path/to/secret-folder',
      memoryFolder({ open: fsError('EIO') }),
    );
    expect(JSON.stringify(listed)).not.toContain('secret-folder');
  });

  it('refuses a path that is not a string', () => {
    expect(() =>
      listConfigDirectory(12 as unknown as string, memoryFolder()),
    ).toThrow(TypeError);
  });
});

describe('configFileReasons', () => {
  it('are frozen and unique', () => {
    expect(Object.isFrozen(configFileReasons)).toBe(true);
    expect(new Set(configFileReasons).size).toBe(configFileReasons.length);
  });
});
