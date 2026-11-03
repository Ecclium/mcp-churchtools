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

import { dayKeyPurposes } from '@ecclium/mcp-churchtools-plugin-api';
import { afterAll, describe, expect, it } from 'vitest';

import { isEventName } from '../logger/index.js';
import {
  auditDirName,
  checkKeysDir,
  checkStateDir,
  isNormalizedAbsolutePath,
  type KeysDirCode,
  keysDirCodes,
  maxKeysDirLength,
  maxStateDirLength,
  quotaDirName,
  type StateDirCode,
  stateDirCodes,
  type StateDirFileSystem,
} from './state-dir.js';

// Real folders in a temporary folder cover what the disk can show: modes,
// links, files in place of folders. Injected file functions cover what a
// test cannot build there, such as a folder of another owner or a platform
// without O_NOFOLLOW.

const path = '/path/to/state';

type Entry =
  | {
      readonly directory?: boolean;
      readonly symlink?: boolean;
      readonly uid?: number;
      readonly mode?: number;
      readonly throws?: boolean;
    }
  | { readonly error: unknown };

interface FakeOptions {
  readonly folder?: Entry;
  readonly audit?: Entry;
  readonly quota?: Entry;
  readonly snapshot?: Entry;
  readonly queue?: Entry;
  readonly getuid?: () => number | undefined;
  readonly constants?: StateDirFileSystem['constants'];
}

interface Fake {
  readonly fs: StateDirFileSystem;
  readonly looked: string[];
}

const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: lstat '${path}'`), { code });

/** File functions over the folder in memory, recording what the check reads. */
const fake = (options: FakeOptions = {}): Fake => {
  const looked: string[] = [];
  const fs: StateDirFileSystem = {
    lstatSync: (target) => {
      looked.push(target);
      const missing = { error: fsError('ENOENT') };
      const entry = target.endsWith(`/${auditDirName}`)
        ? (options.audit ?? missing)
        : target.endsWith(`/${quotaDirName}`)
          ? (options.quota ?? missing)
          : target.endsWith('/snapshot')
            ? (options.snapshot ?? missing)
            : target.endsWith('/queue')
              ? (options.queue ?? missing)
              : (options.folder ?? {});
      if ('error' in entry) throw entry.error;
      return {
        isDirectory: () => {
          if (entry.throws === true) throw new Error(target);
          return entry.directory ?? true;
        },
        isSymbolicLink: () => entry.symlink ?? false,
        uid: entry.uid ?? 1000,
        mode: entry.mode ?? 0o40700,
      };
    },
    getuid: options.getuid ?? (() => 1000),
    constants: options.constants ?? {
      O_NOFOLLOW: 1,
      O_DIRECTORY: 2,
      O_NOCTTY: 4,
    },
  };
  return { fs, looked };
};

const codeOf = (options: FakeOptions, value = path): string =>
  ((result) => (result.ok ? 'ok' : result.code))(
    checkStateDir(value, fake(options).fs),
  );

const keysPath = '/path/to/keys';

const keysCodeOf = (options: FakeOptions, value = keysPath): string =>
  ((result) => (result.ok ? 'ok' : result.code))(
    checkKeysDir(value, fake(options).fs),
  );

describe('isNormalizedAbsolutePath', () => {
  it.each(['/', '/srv', '/path/to/state', '/a b/c', `/${'a'.repeat(959)}`])(
    'takes %j',
    (value) => {
      expect(isNormalizedAbsolutePath(value)).toBe(true);
    },
  );

  it.each([
    '',
    'state',
    './state',
    '~/state',
    '/path/to/state/',
    '//path/to/state',
    '/path//to/state',
    '/path/./state',
    '/path/../state',
    '/path/to/state/.',
    '/path/to/state/..',
  ])('refuses %j', (value) => {
    expect(isNormalizedAbsolutePath(value)).toBe(false);
  });
});

describe('checkStateDir with file functions', () => {
  it('passes a folder of the user with 0700 and no folder audit or quota yet', () => {
    const { fs, looked } = fake();
    expect(checkStateDir(path, fs)).toEqual({ ok: true });
    expect(looked).toEqual([
      path,
      `${path}/${auditDirName}`,
      `${path}/${quotaDirName}`,
    ]);
  });

  it('passes a folder audit that passes the same checks', () => {
    expect(codeOf({ audit: { mode: 0o40700 } })).toBe('ok');
  });

  it('refuses the platform before the form of the path', () => {
    const { fs, looked } = fake({ getuid: () => undefined });
    expect(checkStateDir('path/to/state', fs)).toEqual({
      ok: false,
      code: 'state_dir_platform',
    });
    expect(looked).toEqual([]);
  });

  it('refuses a relative path without looking at the disk', () => {
    const { fs, looked } = fake();
    expect(checkStateDir('path/to/state', fs)).toEqual({
      ok: false,
      code: 'state_dir_relative',
    });
    expect(looked).toEqual([]);
  });

  // An umlaut takes two bytes in UTF-8: 479 of them and the slash are 959
  // bytes, 480 are 961.
  it('counts the length of the path in bytes', () => {
    expect(codeOf({}, `/${'\u00e4'.repeat(479)}`)).toBe('ok');
    const { fs, looked } = fake();
    expect(checkStateDir(`/${'\u00e4'.repeat(480)}`, fs)).toMatchObject({
      code: 'state_dir_too_long',
    });
    expect(looked).toEqual([]);
  });

  it.each(['/path/to/state/', '/path//to/state', '/path/./to/state'])(
    'refuses %j as not normalised without looking at the disk',
    (value) => {
      const { fs, looked } = fake();
      expect(checkStateDir(value, fs)).toMatchObject({
        code: 'state_dir_not_normalized',
      });
      expect(looked).toEqual([]);
    },
  );

  it.each([
    ['no user ID', { getuid: () => undefined }],
    ['no O_NOFOLLOW', { constants: { O_DIRECTORY: 2, O_NOCTTY: 4 } }],
    ['no O_DIRECTORY', { constants: { O_NOFOLLOW: 1, O_NOCTTY: 4 } }],
    ['no O_NOCTTY', { constants: { O_NOFOLLOW: 1, O_DIRECTORY: 2 } }],
  ] as const)(
    'refuses the platform with %s before looking',
    (_name, options) => {
      const { fs, looked } = fake(options);
      expect(checkStateDir(path, fs)).toMatchObject({
        code: 'state_dir_platform',
      });
      expect(looked).toEqual([]);
    },
  );

  it.each([
    [{ folder: { error: fsError('ENOENT') } }, 'state_dir_missing'],
    [{ folder: { error: fsError('ENOTDIR') } }, 'state_dir_unsafe'],
    [{ folder: { error: fsError('EACCES') } }, 'state_dir_unsafe'],
    [{ folder: { error: 'ENOENT' } }, 'state_dir_unsafe'],
    [
      { folder: { error: new Proxy(fsError('ENOENT'), {}) } },
      'state_dir_unsafe',
    ],
    [{ folder: { symlink: true } }, 'state_dir_symlink'],
    [{ folder: { symlink: true, directory: false } }, 'state_dir_symlink'],
    [{ folder: { directory: false } }, 'state_dir_not_directory'],
    [{ folder: { uid: 0 } }, 'state_dir_owner'],
    [{ folder: { mode: 0o40701 } }, 'state_dir_mode'],
    [{ folder: { mode: 0o40710 } }, 'state_dir_mode'],
    [{ folder: { mode: 0o40740 } }, 'state_dir_mode'],
    [{ folder: { throws: true } }, 'state_dir_unsafe'],
    [{ audit: { error: fsError('EACCES') } }, 'audit_dir_unsafe'],
    [{ audit: { symlink: true } }, 'audit_dir_symlink'],
    [{ audit: { directory: false } }, 'audit_dir_not_directory'],
    [{ audit: { uid: 0 } }, 'audit_dir_owner'],
    [{ audit: { mode: 0o40750 } }, 'audit_dir_mode'],
    [{ audit: { throws: true } }, 'audit_dir_unsafe'],
    [{ quota: { error: fsError('EACCES') } }, 'quota_dir_unsafe'],
    [{ quota: { symlink: true } }, 'quota_dir_symlink'],
    [{ quota: { directory: false } }, 'quota_dir_not_directory'],
    [{ quota: { uid: 0 } }, 'quota_dir_owner'],
    [{ quota: { mode: 0o40750 } }, 'quota_dir_mode'],
    [{ quota: { throws: true } }, 'quota_dir_unsafe'],
    [{ audit: { mode: 0o40750 }, quota: { uid: 0 } }, 'audit_dir_mode'],
  ] as const)('refuses %j with %s', (options, code) => {
    expect(codeOf(options)).toBe(code);
  });

  it('passes a folder of root to root', () => {
    expect(codeOf({ folder: { uid: 0 }, getuid: () => 0 })).toBe('ok');
  });

  it('keeps the sticky and set-ID bits out of the check of the mode', () => {
    expect(codeOf({ folder: { mode: 0o41700 } })).toBe('ok');
    expect(codeOf({ folder: { mode: 0o42700 } })).toBe('ok');
  });

  it('looks at the folders audit and quota of the root folder without a double slash', () => {
    const { fs, looked } = fake({ folder: { uid: 0 }, getuid: () => 0 });
    expect(checkStateDir('/', fs)).toEqual({ ok: true });
    expect(looked).toEqual(['/', '/audit', '/quota']);
  });

  it('gives frozen results without a prototype', () => {
    const passed = checkStateDir(path, fake().fs);
    const refused = checkStateDir('state', fake().fs);
    for (const result of [passed, refused]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.getPrototypeOf(result)).toBeNull();
    }
  });

  it('throws for a path that is no string', () => {
    expect(() => checkStateDir(1 as unknown as string, fake().fs)).toThrow(
      new TypeError('The path of the folder of state must be a string.'),
    );
  });

  it('gives no part of an error message or path in a refusal', () => {
    const result = checkStateDir(
      path,
      fake({ folder: { error: fsError('EACCES') } }).fs,
    );
    expect(JSON.stringify(result)).not.toContain('path');
    expect(JSON.stringify(result)).not.toContain('lstat');
  });
});

describe('checkStateDir on the disk', () => {
  const base = mkdtempSync(join(tmpdir(), 'ecclium-state-dir-'));
  const fresh = (name: string, mode = 0o700): string => {
    const folder = join(base, name);
    mkdirSync(folder);
    chmodSync(folder, mode);
    return folder;
  };

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('passes a folder with 0700', () => {
    expect(checkStateDir(fresh('good'))).toEqual({ ok: true });
  });

  it('passes a folder with a folder audit with 0700', () => {
    const folder = fresh('with-audit');
    mkdirSync(join(folder, auditDirName), { mode: 0o700 });
    chmodSync(join(folder, auditDirName), 0o700);
    expect(checkStateDir(folder)).toEqual({ ok: true });
  });

  it('refuses a missing folder', () => {
    expect(checkStateDir(join(base, 'missing'))).toMatchObject({
      code: 'state_dir_missing',
    });
  });

  it('refuses a folder with 0755', () => {
    expect(checkStateDir(fresh('open', 0o755))).toMatchObject({
      code: 'state_dir_mode',
    });
  });

  it('refuses a link to a good folder', () => {
    const target = fresh('target');
    const link = join(base, 'link');
    symlinkSync(target, link);
    expect(checkStateDir(link)).toMatchObject({ code: 'state_dir_symlink' });
  });

  it('refuses a file in place of the folder', () => {
    const file = join(base, 'file');
    writeFileSync(file, '', { mode: 0o600 });
    expect(checkStateDir(file)).toMatchObject({
      code: 'state_dir_not_directory',
    });
  });

  it('refuses a folder audit that is a link to a good folder', () => {
    const folder = fresh('audit-link');
    symlinkSync(fresh('audit-target'), join(folder, auditDirName));
    expect(checkStateDir(folder)).toMatchObject({ code: 'audit_dir_symlink' });
  });

  it('refuses a folder audit with 0755', () => {
    const folder = fresh('audit-open');
    mkdirSync(join(folder, auditDirName));
    chmodSync(join(folder, auditDirName), 0o755);
    expect(checkStateDir(folder)).toMatchObject({ code: 'audit_dir_mode' });
  });

  it('refuses a folder quota that is a link to a good folder, and one with 0755', () => {
    const linked = fresh('quota-link');
    symlinkSync(fresh('quota-target'), join(linked, quotaDirName));
    expect(checkStateDir(linked)).toMatchObject({ code: 'quota_dir_symlink' });
    const open = fresh('quota-open');
    mkdirSync(join(open, quotaDirName));
    chmodSync(join(open, quotaDirName), 0o755);
    expect(checkStateDir(open)).toMatchObject({ code: 'quota_dir_mode' });
  });

  it('refuses a file named audit', () => {
    const folder = fresh('audit-file');
    writeFileSync(join(folder, auditDirName), '', { mode: 0o600 });
    expect(checkStateDir(folder)).toMatchObject({
      code: 'audit_dir_not_directory',
    });
  });
});

describe('stateDirCodes', () => {
  it('is frozen and has each code once', () => {
    expect(Object.isFrozen(stateDirCodes)).toBe(true);
    expect(new Set(stateDirCodes).size).toBe(stateDirCodes.length);
  });

  it('fit the name of a log event behind a prefix', () => {
    for (const code of stateDirCodes) {
      expect(isEventName(`config_${code}`), code).toBe(true);
    }
  });

  it('keep a path of the longest length below PATH_MAX of macOS', () => {
    // audit-YYYY-MM-DD-hhmmss-<pid up to 10>-<number up to 10>.jsonl
    const file = `audit-2026-10-23-055230-${'9'.repeat(10)}-${'9'.repeat(10)}.jsonl`;
    const longest = `/${'a'.repeat(maxStateDirLength - 1)}/${auditDirName}/${file}`;
    expect(longest.length).toBeLessThan(1024);
  });

  it.each([...stateDirCodes])(
    'are each given by a case of the check: %s',
    (code) => {
      const cases: Record<StateDirCode, () => string> = {
        state_dir_relative: () => codeOf({}, 'state'),
        state_dir_too_long: () => codeOf({}, `/${'\u00e4'.repeat(500)}`),
        state_dir_not_normalized: () => codeOf({}, `${path}/`),
        state_dir_platform: () => codeOf({ getuid: () => undefined }),
        state_dir_missing: () =>
          codeOf({ folder: { error: fsError('ENOENT') } }),
        state_dir_symlink: () => codeOf({ folder: { symlink: true } }),
        state_dir_not_directory: () => codeOf({ folder: { directory: false } }),
        state_dir_owner: () => codeOf({ folder: { uid: 7 } }),
        state_dir_mode: () => codeOf({ folder: { mode: 0o40707 } }),
        state_dir_unsafe: () => codeOf({ folder: { error: fsError('EIO') } }),
        audit_dir_symlink: () => codeOf({ audit: { symlink: true } }),
        audit_dir_not_directory: () => codeOf({ audit: { directory: false } }),
        audit_dir_owner: () => codeOf({ audit: { uid: 7 } }),
        audit_dir_mode: () => codeOf({ audit: { mode: 0o40707 } }),
        audit_dir_unsafe: () => codeOf({ audit: { error: fsError('EIO') } }),
        quota_dir_symlink: () => codeOf({ quota: { symlink: true } }),
        quota_dir_not_directory: () => codeOf({ quota: { directory: false } }),
        quota_dir_owner: () => codeOf({ quota: { uid: 7 } }),
        quota_dir_mode: () => codeOf({ quota: { mode: 0o40707 } }),
        quota_dir_unsafe: () => codeOf({ quota: { error: fsError('EIO') } }),
      };
      expect(cases[code]()).toBe(code);
    },
  );
});

// The folder of keys gets the checks of the folder of state with codes of
// its own (ADR 0031), and looks at the folders of the purposes of the day
// keys instead of audit and quota.
describe('checkKeysDir with file functions', () => {
  it('passes a folder of the user with 0700 and looks at the folder of each purpose', () => {
    const { fs, looked } = fake();
    expect(checkKeysDir(keysPath, fs)).toEqual({ ok: true });
    expect(looked).toEqual([
      keysPath,
      ...dayKeyPurposes.map((purpose) => `${keysPath}/${purpose}`),
    ]);
  });

  it('passes folders of the purposes that pass the same checks', () => {
    expect(keysCodeOf({ snapshot: {}, queue: { mode: 0o40700 } })).toBe('ok');
  });

  it('refuses the platform before the form of the path, without looking', () => {
    const { fs, looked } = fake({ constants: { O_NOFOLLOW: 1 } });
    expect(checkKeysDir('keys', fs)).toEqual({
      ok: false,
      code: 'keys_dir_platform',
    });
    expect(looked).toEqual([]);
  });

  it.each([
    ['keys', 'keys_dir_relative'],
    [`${keysPath}/`, 'keys_dir_not_normalized'],
    ['/path//to/keys', 'keys_dir_not_normalized'],
    [`/${'\u00e4'.repeat(448)}`, 'keys_dir_too_long'],
  ])('refuses %j with %s without looking at the disk', (value, code) => {
    const { fs, looked } = fake();
    expect(checkKeysDir(value, fs)).toMatchObject({ code });
    expect(looked).toEqual([]);
  });

  // An umlaut takes two bytes in UTF-8: 447 of them and the slash are 895
  // bytes, 448 are 897.
  it('counts the length of the path in bytes', () => {
    expect(keysCodeOf({}, `/${'\u00e4'.repeat(447)}`)).toBe('ok');
    expect(keysCodeOf({}, `/${'a'.repeat(maxKeysDirLength - 1)}`)).toBe('ok');
    expect(keysCodeOf({}, `/${'a'.repeat(maxKeysDirLength)}`)).toBe(
      'keys_dir_too_long',
    );
  });

  it('gives frozen results without a prototype and names no path', () => {
    const refused = checkKeysDir(
      keysPath,
      fake({ folder: { error: fsError('EACCES') } }).fs,
    );
    for (const result of [checkKeysDir(keysPath, fake().fs), refused]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.getPrototypeOf(result)).toBeNull();
    }
    expect(JSON.stringify(refused)).not.toContain('path');
  });

  it('throws for a path that is no string', () => {
    expect(() => checkKeysDir(1 as unknown as string, fake().fs)).toThrow(
      new TypeError('The path of the folder of keys must be a string.'),
    );
  });

  it('looks at the folders of the root folder without a double slash', () => {
    const { fs, looked } = fake({ folder: { uid: 0 }, getuid: () => 0 });
    expect(checkKeysDir('/', fs)).toEqual({ ok: true });
    expect(looked).toEqual(['/', '/snapshot', '/queue']);
  });

  it('reports the folder of the snapshots before the one of the queue', () => {
    expect(keysCodeOf({ snapshot: { mode: 0o40750 }, queue: { uid: 0 } })).toBe(
      'snapshot_keys_dir_mode',
    );
  });
});

describe('checkKeysDir on the disk', () => {
  const base = mkdtempSync(join(tmpdir(), 'ecclium-keys-dir-'));
  const fresh = (name: string, mode = 0o700): string => {
    const folder = join(base, name);
    mkdirSync(folder);
    chmodSync(folder, mode);
    return folder;
  };

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('passes a folder with 0700 and a folder snapshot with 0700', () => {
    const folder = fresh('good');
    mkdirSync(join(folder, 'snapshot'), { mode: 0o700 });
    chmodSync(join(folder, 'snapshot'), 0o700);
    expect(checkKeysDir(folder)).toEqual({ ok: true });
  });

  it('refuses a missing folder, an open one and a link', () => {
    expect(checkKeysDir(join(base, 'missing'))).toMatchObject({
      code: 'keys_dir_missing',
    });
    expect(checkKeysDir(fresh('open', 0o755))).toMatchObject({
      code: 'keys_dir_mode',
    });
    const link = join(base, 'link');
    symlinkSync(fresh('target'), link);
    expect(checkKeysDir(link)).toMatchObject({ code: 'keys_dir_symlink' });
  });

  it('refuses a folder queue that is a link and a file named snapshot', () => {
    const linked = fresh('queue-link');
    symlinkSync(fresh('queue-target'), join(linked, 'queue'));
    expect(checkKeysDir(linked)).toMatchObject({
      code: 'queue_keys_dir_symlink',
    });
    const file = fresh('snapshot-file');
    writeFileSync(join(file, 'snapshot'), '', { mode: 0o600 });
    expect(checkKeysDir(file)).toMatchObject({
      code: 'snapshot_keys_dir_not_directory',
    });
  });
});

describe('keysDirCodes', () => {
  it('is frozen, has each code once and shares none with the folder of state', () => {
    expect(Object.isFrozen(keysDirCodes)).toBe(true);
    expect(new Set(keysDirCodes).size).toBe(keysDirCodes.length);
    for (const code of keysDirCodes) {
      expect(stateDirCodes as readonly string[]).not.toContain(code);
    }
  });

  it('fit the name of a log event behind a prefix', () => {
    for (const code of keysDirCodes) {
      expect(isEventName(`config_${code}`), code).toBe(true);
    }
  });

  // .<tenant>.<YYYY-MM-DD>.key.<pid>.<16 hex>.tmp, the temporary name of a
  // day key that is being written, with the longest tenant and pid.
  it('keep the path of the longest day key below PATH_MAX of macOS', () => {
    const name = `.${'a'.repeat(63)}.2026-11-03.key.${'9'.repeat(10)}.${'f'.repeat(16)}.tmp`;
    const longest = `/${'a'.repeat(maxKeysDirLength - 1)}/snapshot/${name}`;
    expect(longest.length).toBeLessThan(1024);
    expect(
      `/${'a'.repeat(maxStateDirLength - 1)}/snapshot/${name}`.length,
    ).toBeGreaterThan(1024);
  });

  it.each([...keysDirCodes])(
    'are each given by a case of the check: %s',
    (code) => {
      const cases: Record<KeysDirCode, () => string> = {
        keys_dir_platform: () => keysCodeOf({ getuid: () => undefined }),
        keys_dir_relative: () => keysCodeOf({}, 'keys'),
        keys_dir_not_normalized: () => keysCodeOf({}, `${keysPath}/.`),
        keys_dir_too_long: () => keysCodeOf({}, `/${'a'.repeat(900)}`),
        keys_dir_missing: () =>
          keysCodeOf({ folder: { error: fsError('ENOENT') } }),
        keys_dir_symlink: () => keysCodeOf({ folder: { symlink: true } }),
        keys_dir_not_directory: () =>
          keysCodeOf({ folder: { directory: false } }),
        keys_dir_owner: () => keysCodeOf({ folder: { uid: 7 } }),
        keys_dir_mode: () => keysCodeOf({ folder: { mode: 0o40770 } }),
        keys_dir_unsafe: () => keysCodeOf({ folder: { throws: true } }),
        snapshot_keys_dir_symlink: () =>
          keysCodeOf({ snapshot: { symlink: true } }),
        snapshot_keys_dir_not_directory: () =>
          keysCodeOf({ snapshot: { directory: false } }),
        snapshot_keys_dir_owner: () => keysCodeOf({ snapshot: { uid: 7 } }),
        snapshot_keys_dir_mode: () =>
          keysCodeOf({ snapshot: { mode: 0o40707 } }),
        snapshot_keys_dir_unsafe: () =>
          keysCodeOf({ snapshot: { error: fsError('EIO') } }),
        queue_keys_dir_symlink: () => keysCodeOf({ queue: { symlink: true } }),
        queue_keys_dir_not_directory: () =>
          keysCodeOf({ queue: { directory: false } }),
        queue_keys_dir_owner: () => keysCodeOf({ queue: { uid: 7 } }),
        queue_keys_dir_mode: () => keysCodeOf({ queue: { mode: 0o40707 } }),
        queue_keys_dir_unsafe: () => keysCodeOf({ queue: { throws: true } }),
      };
      expect(cases[code]()).toBe(code);
    },
  );
});
