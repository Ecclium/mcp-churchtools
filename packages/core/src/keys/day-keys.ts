/**
 * The day keys of the free core (ADR 0031): one random key of 256 bits per
 * tenant, purpose and UTC day, kept as a file in the folder of keys that
 * `ECCLIUM_KEYS_DIR` names, at `<folder>/<purpose>/<tenant>.<day>.key`, as
 * 64 hex digits. The folder is not the folder of state and is never backed
 * up, so that a backup of snapshots and queue never holds the keys that
 * open them.
 *
 * Where it stands in the way of a write: before the snapshot of a write is
 * saved, the key of that one snapshot is encrypted here with the day key
 * of the day (`wrap`), and `ecclium undo` opens it again (`unwrap`). Once
 * the retention of the snapshots is over, `destroyBefore` destroys the day
 * keys of the days before, and every snapshot of those days can no longer
 * be read, whatever copy of it exists (crypto-shredding).
 *
 * A day key comes into being with the first `wrap` of its day: written
 * once, given its name with `link` (files/), so that two processes that
 * wrap on the same new day end with the same key. It is never changed,
 * only destroyed: zeros over the file, then its name removed. Keys stay in
 * the memory of the process only while one key is wrapped or opened, as
 * bytes that are erased afterwards, never as text.
 *
 * @packageDocumentation
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  dataKeyLength,
  type DayKeyPurpose,
  dayKeyPurposes,
  isIsoDate,
  type IsoDate,
  type KeyProvider,
  type TenantContext,
  type WrappedKey,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  destroyPrivateFile,
  listPrivateFolder,
  nodePrivateFileSystem,
  preparePrivateFolder,
  type PrivateFileSystem,
  readPrivateFile,
  writePrivateFileOnce,
} from '../files/index.js';
import { isTenantId } from '../logger/index.js';
import { infoOf } from './info.js';

/** The day keys of a provider: the part of the port that they serve. */
export type DayKeys = Pick<KeyProvider, 'wrap' | 'unwrap' | 'destroyBefore'>;

/** What {@link createFileDayKeys} needs. */
export interface FileDayKeysOptions {
  /** The checked folder of keys, an absolute normalised path. */
  readonly keysDir: string;
  /** The ID of the process, part of the temporary names. */
  readonly pid: number;
  /** The file functions, only for tests. */
  readonly fs?: PrivateFileSystem;
}

// The first part of the additional data of every wrapped key: the version
// of the format. Purpose, tenant and day follow as parts of their own, so
// that a key wrapped for one of them never opens for another.
const label = 'ecclium/day-key/v1';

// A day key as a file: 64 hex digits, nothing else.
const keyFileBytes = 2 * dataKeyLength;

// 12 bytes of nonce, the key and 16 bytes of tag of AES-256-GCM.
const nonceLength = 12;
const tagLength = 16;

// The names in the folder of a purpose: a day key, and the temporary name
// of a writer that stopped before it removed it.
const keyName = /^([a-z0-9][a-z0-9-]{0,62})\.(\d{4}-\d{2}-\d{2})\.key$/;
const temporaryName =
  /^\.([a-z0-9][a-z0-9-]{0,62})\.(\d{4}-\d{2}-\d{2})\.key\.\d{1,10}\.[0-9a-f]{16}\.tmp$/;

const sealedPattern = /^[A-Za-z0-9_-]{80}$/;

const hexDigits = '0123456789abcdef';

// The key as hex digits, without making a string of it.
const toHex = (key: Uint8Array): Uint8Array => {
  const out = new Uint8Array(key.length * 2);
  for (const [index, byte] of key.entries()) {
    out[2 * index] = hexDigits.charCodeAt(byte >> 4);
    out[2 * index + 1] = hexDigits.charCodeAt(byte & 0x0f);
  }
  return out;
};

const nibble = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
};

// The key from hex digits in lower case, or undefined for anything else.
const fromHex = (hex: Uint8Array): Uint8Array | undefined => {
  if (hex.length !== keyFileBytes) return undefined;
  const key = new Uint8Array(dataKeyLength);
  let high = 0;
  for (const [position, code] of hex.entries()) {
    const value = nibble(code);
    if (value < 0) {
      key.fill(0);
      return undefined;
    }
    if (position % 2 === 0) {
      high = value;
    } else {
      key[position >> 1] = (high << 4) | value;
    }
  }
  return key;
};

// An own data property of a plain object, never through a getter or a
// proxy, which could give another value on every read.
const ownData = (target: unknown, key: string): unknown => {
  if (typeof target !== 'object' || target === null || isProxy(target)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

const tenantOf = (ctx: TenantContext): string => {
  const tenantId = ownData(ctx, 'tenantId');
  if (!isTenantId(tenantId)) throw new TypeError('The tenant is invalid.');
  return tenantId;
};

const checkPurpose = (purpose: unknown): DayKeyPurpose => {
  if (!(dayKeyPurposes as readonly unknown[]).includes(purpose)) {
    throw new TypeError('The purpose is no purpose of a day key.');
  }
  return purpose as DayKeyPurpose;
};

const checkDay = (day: unknown): IsoDate => {
  if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
  return day;
};

const aadOf = (purpose: DayKeyPurpose, tenant: string, day: IsoDate) =>
  infoOf([label, purpose, tenant, day]);

/**
 * Prepares the folder of a purpose in the folder of keys, for the start:
 * creates it with 0700 if it is missing and checks it.
 *
 * @param keysDir - The checked folder of keys.
 * @param purpose - What the day keys in it are for.
 * @param fs - The file functions, only for tests.
 * @throws {PrivateFileError} When the folder cannot be used.
 * @throws {TypeError} For a purpose that is none of a day key.
 * @example
 * ```ts
 * prepareDayKeyFolder('/srv/ecclium-keys', 'snapshot');
 * ```
 */
export function prepareDayKeyFolder(
  keysDir: string,
  purpose: DayKeyPurpose,
  fs: PrivateFileSystem = nodePrivateFileSystem,
): void {
  // The checked folder of keys is never the root, which is no folder of
  // the user, and a doubled slash would not matter on its own either.
  preparePrivateFolder(`${keysDir}/${checkPurpose(purpose)}`, fs);
}

/**
 * Makes the day keys of the free core over the folder of keys. Every
 * promise rejects with a `TypeError` for a tenant, purpose, day or key
 * that does not fit, with a `PrivateFileError` when the folder or a file
 * cannot be used, and `unwrap` with an `Error` for a key that does not
 * open.
 *
 * @param options - The folder of keys, the ID of the process and, for
 *   tests, the file functions.
 * @returns The day keys, frozen. They hold no key, only the folder.
 * @throws {TypeError} When the folder or the ID of the process is invalid.
 * @example
 * ```ts
 * const dayKeys = createFileDayKeys({ keysDir, pid: process.pid });
 * const wrapped = await dayKeys.wrap(ctx, 'snapshot', today, keyOfTheSnapshot);
 * ```
 */
export function createFileDayKeys(options: FileDayKeysOptions): DayKeys {
  const keysDir = ownData(options, 'keysDir');
  const pid = ownData(options, 'pid');
  const fs = (ownData(options, 'fs') ??
    nodePrivateFileSystem) as PrivateFileSystem;
  if (
    typeof keysDir !== 'string' ||
    !keysDir.startsWith('/') ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  ) {
    throw new TypeError('The day keys need a folder of keys and a process.');
  }
  const folderOf = (purpose: DayKeyPurpose): string => `${keysDir}/${purpose}`;

  // The day key, read; with create, made first if it is missing. Another
  // process may make it at the same moment: then its key counts, and this
  // one is erased unwritten.
  const dayKey = (
    purpose: DayKeyPurpose,
    tenant: string,
    day: IsoDate,
    create: boolean,
  ): Uint8Array | undefined => {
    const folder = folderOf(purpose);
    const name = `${tenant}.${day}.key`;
    if (create) {
      preparePrivateFolder(folder, fs);
    } else if (listPrivateFolder(folder, fs).length === 0) {
      return undefined;
    }
    const read = (): Uint8Array | undefined => {
      const bytes = readPrivateFile(folder, name, keyFileBytes, fs);
      if (bytes === undefined) return undefined;
      const key = fromHex(bytes);
      bytes.fill(0);
      if (key === undefined) throw new Error('A day key is damaged.');
      return key;
    };
    const existing = read();
    if (existing !== undefined || !create) return existing;
    const fresh = new Uint8Array(randomBytes(dataKeyLength));
    const hex = toHex(fresh);
    try {
      const outcome = writePrivateFileOnce(folder, name, hex, { pid, fs });
      if (outcome === 'written') return fresh;
    } finally {
      hex.fill(0);
    }
    fresh.fill(0);
    return read();
  };

  const wrap = (
    ctx: TenantContext,
    purpose: DayKeyPurpose,
    day: IsoDate,
    key: Uint8Array,
  ): WrappedKey => {
    const tenant = tenantOf(ctx);
    const checkedPurpose = checkPurpose(purpose);
    const checkedDay = checkDay(day);
    if (!(key instanceof Uint8Array) || key.length !== dataKeyLength) {
      throw new TypeError('The key to wrap must have 32 bytes.');
    }
    const plain = Uint8Array.from(key);
    const kek = dayKey(checkedPurpose, tenant, checkedDay, true);
    // Missing only when another process destroyed it between its write
    // and the read here.
    if (kek === undefined) throw new Error('A day key is missing.');
    try {
      const nonce = randomBytes(nonceLength);
      const cipher = createCipheriv('aes-256-gcm', kek, nonce, {
        authTagLength: tagLength,
      });
      cipher.setAAD(aadOf(checkedPurpose, tenant, checkedDay));
      const sealed = Buffer.concat([
        nonce,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return Object.freeze({
        purpose: checkedPurpose,
        day: checkedDay,
        sealed: sealed.toString('base64url'),
      });
    } finally {
      kek.fill(0);
      plain.fill(0);
    }
  };

  const unwrap = (
    ctx: TenantContext,
    purpose: DayKeyPurpose,
    wrapped: WrappedKey,
  ): Uint8Array | undefined => {
    const tenant = tenantOf(ctx);
    const checkedPurpose = checkPurpose(purpose);
    const day = checkDay(ownData(wrapped, 'day'));
    const sealed = ownData(wrapped, 'sealed');
    if (
      ownData(wrapped, 'purpose') !== checkedPurpose ||
      typeof sealed !== 'string' ||
      !sealedPattern.test(sealed)
    ) {
      throw new TypeError('The wrapped key does not fit.');
    }
    // 80 signs of base64url without padding are always the 60 bytes of
    // nonce, key and tag.
    const bytes = Buffer.from(sealed, 'base64url');
    const kek = dayKey(checkedPurpose, tenant, day, false);
    if (kek === undefined) return undefined;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        kek,
        bytes.subarray(0, nonceLength),
        { authTagLength: tagLength },
      );
      decipher.setAAD(aadOf(checkedPurpose, tenant, day));
      decipher.setAuthTag(bytes.subarray(nonceLength + dataKeyLength));
      const opened = decipher.update(
        bytes.subarray(nonceLength, nonceLength + dataKeyLength),
      );
      try {
        decipher.final();
      } catch {
        opened.fill(0);
        throw new Error('The wrapped key does not open.');
      }
      const key = new Uint8Array(opened);
      opened.fill(0);
      return key;
    } finally {
      kek.fill(0);
    }
  };

  const destroyBefore = (purpose: DayKeyPurpose, day: IsoDate): number => {
    const folder = folderOf(checkPurpose(purpose));
    const cut = checkDay(day);
    let destroyed = 0;
    for (const name of listPrivateFolder(folder, fs)) {
      const key = keyName.exec(name);
      const temporary = key === null ? temporaryName.exec(name) : null;
      const found = key ?? temporary;
      // A name of another form is not a day key and stays. The second
      // group is the day in both forms.
      if (found === null || String(found[2]) >= cut) continue;
      if (destroyPrivateFile(folder, name, keyFileBytes, fs) && key !== null) {
        destroyed += 1;
      }
    }
    return destroyed;
  };

  // Every refusal is a rejected promise, as for a provider that keeps its
  // day keys elsewhere: what the executor throws rejects the promise.
  return Object.freeze({
    __proto__: null,
    wrap: (
      ctx: TenantContext,
      purpose: DayKeyPurpose,
      day: IsoDate,
      key: Uint8Array,
    ): Promise<WrappedKey> =>
      new Promise((resolve) => {
        resolve(wrap(ctx, purpose, day, key));
      }),
    unwrap: (
      ctx: TenantContext,
      purpose: DayKeyPurpose,
      wrapped: WrappedKey,
    ): Promise<Uint8Array | undefined> =>
      new Promise((resolve) => {
        resolve(unwrap(ctx, purpose, wrapped));
      }),
    destroyBefore: (purpose: DayKeyPurpose, day: IsoDate): Promise<number> =>
      new Promise((resolve) => {
        resolve(destroyBefore(purpose, day));
      }),
  });
}
