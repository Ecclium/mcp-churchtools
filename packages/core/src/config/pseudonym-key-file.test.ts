import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { KeyMaterial } from '../keys/index.js';
import {
  pseudonymKeyFileCodes,
  readPseudonymKeyFile,
} from './pseudonym-key-file.js';
import { tokenFileCodes, type TokenFileSystem } from './token-file.js';

// The reader of the token file has its own tests. These show that a key
// file goes through it and that every one of its reasons keeps a name of
// its own for the key file.

const hex = createHash('sha256').update('key').digest('hex');

const oneFile = (
  content: string,
  stats: { readonly mode?: number; readonly uid?: number } = {},
): TokenFileSystem => {
  const bytes = Buffer.from(content, 'latin1');
  let position = 0;
  return {
    openSync: () => {
      position = 0;
      return 3;
    },
    fstatSync: () => ({
      isFile: () => true,
      uid: stats.uid ?? 1000,
      mode: stats.mode ?? 0o100600,
      size: bytes.length,
    }),
    readSync: (_fd, buffer, offset, length) => {
      const chunk = bytes.subarray(position, position + length);
      buffer.set(chunk, offset);
      position += chunk.length;
      return chunk.length;
    },
    closeSync: () => undefined,
    getuid: () => 1000,
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, O_NOCTTY: 4 },
  };
};

describe('readPseudonymKeyFile', () => {
  it('reads a key of 64 hex digits', () => {
    const read = readPseudonymKeyFile('/path/to/key', oneFile(`${hex}\n`));
    expect(read.ok).toBe(true);
    expect(read.ok && read.value.sameAs(new KeyMaterial(hex))).toBe(true);
  });

  it.each([
    [
      'a relative path',
      'key',
      oneFile(`${hex}\n`),
      'pseudonym_key_file_relative',
    ],
    [
      'rights for others',
      '/path/to/key',
      oneFile(`${hex}\n`, { mode: 0o100604 }),
      'pseudonym_key_file_mode',
    ],
    [
      'another owner',
      '/path/to/key',
      oneFile(`${hex}\n`, { uid: 0 }),
      'pseudonym_key_file_owner',
    ],
    [
      'a second line',
      '/path/to/key',
      oneFile(`${hex}\n\n`),
      'pseudonym_key_file_characters',
    ],
    ['no key', '/path/to/key', oneFile('not-a-key\n'), 'pseudonym_key_invalid'],
  ])('refuses %s with its own code', (_name, path, fs, code) => {
    expect(readPseudonymKeyFile(path, fs)).toEqual({ ok: false, code });
  });

  it('has a code of its own for every reason of the token file', () => {
    expect(pseudonymKeyFileCodes).toHaveLength(tokenFileCodes.length);
    expect(pseudonymKeyFileCodes).toEqual(
      tokenFileCodes.map((code) =>
        code === 'token_invalid'
          ? 'pseudonym_key_invalid'
          : code.replace('token_file_', 'pseudonym_key_file_'),
      ),
    );
    expect(Object.isFrozen(pseudonymKeyFileCodes)).toBe(true);
  });
});
