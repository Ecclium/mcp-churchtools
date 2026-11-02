import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  DayKeyPurpose,
  IsoDate,
  WrappedKey,
} from '@ecclium/mcp-churchtools-plugin-api';
import { dayKeyChecks, quotaContext } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, describe, expect, it } from 'vitest';

import {
  nodePrivateFileSystem,
  PrivateFileError,
  type PrivateFileSystem,
} from '../files/index.js';
import { createFileDayKeys, prepareDayKeyFolder } from './day-keys.js';

// The day keys run on disk, each test in a folder of keys of its own.

const base = mkdtempSync(join(tmpdir(), 'ecclium-day-keys-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

let count = 0;
const freshDir = (): string => {
  count += 1;
  // The operator makes the folder of keys; the purposes come inside.
  const dir = join(base, `k${String(count)}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
};

const pid = process.pid;
const ctx = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const day = '2026-11-03' as IsoDate;
const key = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('the day keys in files', () => {
  it.each(dayKeyChecks)('$name', async ({ run }) => {
    const keysDir = freshDir();
    await run(() => createFileDayKeys({ keysDir, pid }));
  });

  it('keeps one key per tenant, purpose and day as 64 hex digits with 0600', async () => {
    const keysDir = freshDir();
    const keys = createFileDayKeys({ keysDir, pid });
    await keys.wrap(ctx, 'snapshot', day, key);
    await keys.wrap(ctx, 'snapshot', day, key);
    const folder = join(keysDir, 'snapshot');
    expect(readdirSync(folder)).toEqual(['demo-tenant.2026-11-03.key']);
    const text = readFileSync(
      join(folder, 'demo-tenant.2026-11-03.key'),
      'utf8',
    );
    expect(text).toMatch(/^[0-9a-f]{64}$/);
    expect(
      statSync(join(folder, 'demo-tenant.2026-11-03.key')).mode & 0o777,
    ).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it('gives the same key to a second process that writes the day key at the same moment', async () => {
    const keysDir = freshDir();
    const first = createFileDayKeys({ keysDir, pid });
    // The second process loses the race: its link finds the name taken.
    const wrapped = await first.wrap(ctx, 'snapshot', day, key);
    rmSync(join(keysDir, 'snapshot', 'demo-tenant.2026-11-03.key'));
    const racing: PrivateFileSystem = Object.freeze({
      ...nodePrivateFileSystem,
      linkSync: (existing: string, path: string) => {
        writeFileSync(path, readFileSync(existing).fill(0x61), { mode: 0o600 });
        throw Object.assign(new Error('taken'), { code: 'EEXIST' });
      },
    });
    const second = createFileDayKeys({ keysDir, pid, fs: racing });
    const again = await second.wrap(ctx, 'snapshot', day, key);
    // The key of the other process counts: 64 times «a».
    expect(
      readFileSync(
        join(keysDir, 'snapshot', 'demo-tenant.2026-11-03.key'),
        'utf8',
      ),
    ).toBe('a'.repeat(64));
    expect(await first.unwrap(ctx, 'snapshot', again)).toEqual(key);
    await expect(first.unwrap(ctx, 'snapshot', wrapped)).rejects.toThrow(
      'The wrapped key does not open.',
    );
  });

  it('refuses a day key that another process destroyed between its write and the read', async () => {
    const keysDir = freshDir();
    const vanishing: PrivateFileSystem = Object.freeze({
      ...nodePrivateFileSystem,
      linkSync: () => {
        throw Object.assign(new Error('taken'), { code: 'EEXIST' });
      },
    });
    const keys = createFileDayKeys({ keysDir, pid, fs: vanishing });
    await expect(keys.wrap(ctx, 'snapshot', day, key)).rejects.toThrow(
      'A day key is missing.',
    );
  });

  it('refuses a damaged day key', async () => {
    const keysDir = freshDir();
    const keys = createFileDayKeys({ keysDir, pid });
    const wrapped = await keys.wrap(ctx, 'snapshot', day, key);
    const file = join(keysDir, 'snapshot', 'demo-tenant.2026-11-03.key');
    for (const damaged of ['A'.repeat(64), 'g'.repeat(64), '0'.repeat(63)]) {
      rmSync(file);
      writeFileSync(file, damaged, { mode: 0o600 });
      await expect(keys.unwrap(ctx, 'snapshot', wrapped)).rejects.toThrow(
        'A day key is damaged.',
      );
      await expect(keys.wrap(ctx, 'snapshot', day, key)).rejects.toThrow(
        'A day key is damaged.',
      );
    }
  });

  it('gives nothing when the folder of the purpose is missing or empty', async () => {
    const keysDir = freshDir();
    const keys = createFileDayKeys({ keysDir, pid });
    const wrapped = await keys.wrap(ctx, 'snapshot', day, key);
    const elsewhere = createFileDayKeys({ keysDir: freshDir(), pid });
    expect(await elsewhere.unwrap(ctx, 'snapshot', wrapped)).toBeUndefined();
    prepareDayKeyFolder(keysDir, 'queue');
    expect(
      await keys.unwrap(ctx, 'queue', { ...wrapped, purpose: 'queue' }),
    ).toBeUndefined();
  });

  it('refuses a wrapped key of another form', async () => {
    const keys = createFileDayKeys({ keysDir: freshDir(), pid });
    const wrapped = await keys.wrap(ctx, 'snapshot', day, key);
    const forms: unknown[] = [
      { ...wrapped, sealed: `${wrapped.sealed}A` },
      { ...wrapped, sealed: wrapped.sealed.replace(/^./, '+') },
      { ...wrapped, sealed: 5 },
      { ...wrapped, day: 'today' },
      {
        purpose: 'snapshot',
        day,
        get sealed() {
          return wrapped.sealed;
        },
      },
      new Proxy(wrapped, {}),
      undefined,
    ];
    for (const form of forms) {
      await expect(
        keys.unwrap(ctx, 'snapshot', form as WrappedKey),
      ).rejects.toThrow(TypeError);
    }
  });

  it('refuses a tenant that does not fit and a key that is no array of bytes', async () => {
    const keys = createFileDayKeys({ keysDir: freshDir(), pid });
    const bad = quotaContext('Demo', 'service', 'stdio:local-stdio');
    await expect(keys.wrap(bad, 'snapshot', day, key)).rejects.toThrow(
      'The tenant is invalid.',
    );
    await expect(
      keys.wrap(ctx, 'snapshot', day, Array.from(key) as unknown as Uint8Array),
    ).rejects.toThrow(TypeError);
    await expect(
      keys.unwrap(new Proxy(ctx, {}), 'snapshot', {} as WrappedKey),
    ).rejects.toThrow('The tenant is invalid.');
  });

  it('destroys old day keys and old temporary names, and leaves other names and the days that stay', async () => {
    const keysDir = freshDir();
    const keys = createFileDayKeys({ keysDir, pid });
    await keys.wrap(ctx, 'snapshot', '2026-10-01' as IsoDate, key);
    await keys.wrap(ctx, 'snapshot', day, key);
    const folder = join(keysDir, 'snapshot');
    for (const name of [
      '.demo-tenant.2026-10-01.key.12.0123456789abcdef.tmp',
      '.demo-tenant.2026-11-03.key.12.0123456789abcdef.tmp',
      'notes.txt',
      'demo-tenant.2026-10-01.key.bak',
    ]) {
      writeFileSync(join(folder, name), 'x', { mode: 0o600 });
    }
    expect(await keys.destroyBefore('snapshot', '2026-11-02' as IsoDate)).toBe(
      1,
    );
    expect(readdirSync(folder).sort()).toEqual([
      '.demo-tenant.2026-11-03.key.12.0123456789abcdef.tmp',
      'demo-tenant.2026-10-01.key.bak',
      'demo-tenant.2026-11-03.key',
      'notes.txt',
    ]);
    expect(await keys.destroyBefore('queue', day)).toBe(0);
  });

  it('rejects with a code of its own when the folder of keys cannot be used', async () => {
    const keysDir = freshDir();
    const refusing: PrivateFileSystem = Object.freeze({
      ...nodePrivateFileSystem,
      mkdirSync: () => {
        throw Object.assign(new Error('no'), { code: 'EACCES' });
      },
    });
    const keys = createFileDayKeys({ keysDir, pid, fs: refusing });
    await expect(keys.wrap(ctx, 'snapshot', day, key)).rejects.toBeInstanceOf(
      PrivateFileError,
    );
  });

  it('needs an absolute folder of keys and the ID of a process', () => {
    for (const options of [
      { keysDir: 'keys', pid },
      { keysDir: 5, pid },
      { keysDir: '/keys', pid: 0 },
      { keysDir: '/keys', pid: 1.5 },
      { keysDir: '/keys', pid: '1' },
      new Proxy({ keysDir: '/keys', pid }, {}),
    ]) {
      expect(() =>
        createFileDayKeys(
          options as unknown as Parameters<typeof createFileDayKeys>[0],
        ),
      ).toThrow(TypeError);
    }
    expect(Object.isFrozen(createFileDayKeys({ keysDir: '/', pid }))).toBe(
      true,
    );
  });

  it('prepares only the folder of a purpose of a day key', () => {
    const keysDir = freshDir();
    prepareDayKeyFolder(keysDir, 'snapshot');
    prepareDayKeyFolder(keysDir, 'queue');
    expect(readdirSync(keysDir).sort()).toEqual(['queue', 'snapshot']);
    expect(() => {
      prepareDayKeyFolder(keysDir, 'pseudonym' as DayKeyPurpose);
    }).toThrow(TypeError);
  });
});
