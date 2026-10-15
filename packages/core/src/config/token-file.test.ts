import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
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

import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '../http/index.js';
import { isEventName } from '../logger/index.js';
import {
  maxTokenFileBytes,
  readTokenFile,
  type TokenFileCode,
  tokenFileCodes,
  type TokenFileResult,
  type TokenFileStats,
  type TokenFileSystem,
} from './token-file.js';

// Real files in a temporary folder cover what the disk can show: modes,
// links, folders, devices and contents. Injected file functions cover what
// a test cannot build there, such as a file of another owner, a file that
// grows after the check or a platform without O_NOFOLLOW. A FIFO needs
// mkfifo, so tests/token-file.test.mts covers it in a child process.

const identity = (value: string): string => value;
const asSecret = (value: string): Secret => new Secret(value);

/** A token of visible ASCII, new on every call. */
const token = (): string => makeCanary('token').value;

// Distinct bits, so that a missing flag changes the sum.
const fakeConstants = Object.freeze({
  O_RDONLY: 1,
  O_NOFOLLOW: 2,
  O_NONBLOCK: 4,
  O_NOCTTY: 8,
});
const fakeUid = 1000;
const fakeFd = 42;

interface FakeOptions {
  readonly content?: Uint8Array;
  readonly stats?: Partial<Omit<TokenFileStats, 'isFile'>> & {
    readonly isFile?: boolean;
  };
  readonly open?: () => never;
  readonly fstat?: () => never;
  readonly read?: (
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
  readonly close?: () => void;
  readonly getuid?: () => number | undefined;
  readonly constants?: TokenFileSystem['constants'];
}

interface Fake {
  readonly fs: TokenFileSystem;
  readonly flags: number[];
  readonly closed: number[];
  readonly buffers: Uint8Array[];
}

/** File functions over a content in memory, recording what the reader does. */
const fake = (options: FakeOptions = {}): Fake => {
  const content = options.content ?? Buffer.from(`${token()}\n`, 'latin1');
  const flags: number[] = [];
  const closed: number[] = [];
  const buffers: Uint8Array[] = [];
  const state = { position: 0 };
  const fs: TokenFileSystem = {
    openSync: (_path, flag) => {
      flags.push(flag);
      options.open?.();
      return fakeFd;
    },
    fstatSync: () => {
      options.fstat?.();
      return {
        isFile: () => options.stats?.isFile ?? true,
        uid: options.stats?.uid ?? fakeUid,
        mode: options.stats?.mode ?? 0o100600,
        size: options.stats?.size ?? content.length,
      };
    },
    readSync: (_fd, buffer, offset, length) => {
      buffers.push(buffer);
      if (options.read) return options.read(buffer, offset, length);
      const chunk = content.subarray(state.position, state.position + length);
      buffer.set(chunk, offset);
      state.position += chunk.length;
      return chunk.length;
    },
    closeSync: (fd) => {
      closed.push(fd);
      options.close?.();
    },
    getuid: options.getuid ?? (() => fakeUid),
    constants: options.constants ?? fakeConstants,
  };
  return { fs, flags, closed, buffers };
};

/** An error as the file functions of Node.js throw it, with a code. */
const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: open '/path/to/token-file'`), { code });

const refusedWith = (
  result: TokenFileResult<unknown>,
  code: TokenFileCode,
): void => {
  expect(result).toEqual({ ok: false, code });
  expect(Object.keys(result)).toEqual(['ok', 'code']);
  expect(Object.getPrototypeOf(result)).toBeNull();
  expect(Object.isFrozen(result)).toBe(true);
};

describe('readTokenFile on disk', () => {
  let directory = '';

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'ecclium-token-file-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** Writes a file with the given mode and returns its path. */
  const place = (content: string | Uint8Array, mode = 0o600): string => {
    const path = join(directory, `token-${randomUUID()}`);
    writeFileSync(
      path,
      typeof content === 'string' ? Buffer.from(content, 'latin1') : content,
    );
    chmodSync(path, mode);
    return path;
  };

  it.each([
    ['a line feed', '\n', 0o600],
    ['CR LF', '\r\n', 0o600],
    ['no line ending', '', 0o400],
    ['a line feed and mode 0700', '\n', 0o700],
  ])('read a token with %s', (_, ending, mode) => {
    const value = token();
    const result = readTokenFile(place(`${value}${ending}`, mode), identity);
    expect(result).toEqual({ ok: true, value });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['a line feed', '\n'],
    ['CR LF', '\r\n'],
  ])('read the longest token a Secret takes, with %s', (_, ending) => {
    const value = 'a'.repeat(4096);
    const result = readTokenFile(place(`${value}${ending}`), asSecret);
    expect(result.ok).toBe(true);
    expect(maxTokenFileBytes).toBe(4098);
  });

  it('hand the value to wrap and give back what wrap returns', () => {
    const value = token();
    const wrapped = { wrapped: true };
    const seen: string[] = [];
    const result = readTokenFile(place(`${value}\n`), (given) => {
      seen.push(given);
      return wrapped;
    });
    expect(seen).toEqual([value]);
    expect(result.ok && result.value).toBe(wrapped);
  });

  it.each([
    ['a lone CR', 'abc\r'],
    ['a second line feed', 'abc\n\n'],
    ['a line feed before CR LF', 'abc\n\r\n'],
    ['a space', 'ab c\n'],
    ['a space at the end', 'abc \n'],
    ['a tab', '\tabc\n'],
    ['a NUL byte', 'ab\0c\n'],
    ['DEL', 'ab\x7fc\n'],
    ['a byte above ASCII', 'ab\xe4c\n'],
    ['a line ending inside', 'ab\ncd\n'],
  ])('refuse a token with %s', (_, content) => {
    refusedWith(
      readTokenFile(place(content), identity),
      'token_file_characters',
    );
  });

  it.each([
    ['empty', ''],
    ['only a line feed', '\n'],
    ['only CR LF', '\r\n'],
  ])('refuse a file that is %s', (_, content) => {
    refusedWith(readTokenFile(place(content), identity), 'token_file_empty');
  });

  it.each([
    ['UTF-8', [0xef, 0xbb, 0xbf], 'latin1'],
    ['UTF-16 little-endian', [0xff, 0xfe], 'utf16le'],
    ['UTF-16 big-endian', [0xfe, 0xff], 'utf16be'],
  ] as const)(
    'refuse a byte order mark of %s instead of dropping it',
    (_, mark, encoding) => {
      const text = `${token()}\n`;
      const body =
        encoding === 'utf16be'
          ? Buffer.from(text, 'utf16le').swap16()
          : Buffer.from(text, encoding);
      const content = Buffer.concat([Buffer.from(mark), body]);
      refusedWith(readTokenFile(place(content), identity), 'token_file_bom');
    },
  );

  it.each([
    ['a lone 0xEF', [0xef, 0x61, 0x62, 0x0a]],
    ['0xEF 0xBB without 0xBF', [0xef, 0xbb, 0x61, 0x0a]],
    ['a lone 0xFF', [0xff, 0x61, 0x0a]],
  ])('refuse %s at the start as characters, not as a mark', (_, bytes) => {
    refusedWith(
      readTokenFile(place(Buffer.from(bytes)), identity),
      'token_file_characters',
    );
  });

  // The rule takes 0x21 to 0x7E, both ends included.
  it('read a token that starts with ! and ends with ~', () => {
    const value = `!${token()}~`;
    expect(readTokenFile(place(`${value}\n`), identity)).toEqual({
      ok: true,
      value,
    });
  });

  it.each([
    ['one byte too many', 'a'.repeat(maxTokenFileBytes + 1)],
    ['CR LF after the longest file', `${'a'.repeat(4097)}\r\n`],
    ['far too many bytes', 'a'.repeat(100_000)],
  ])('refuse %s', (_, content) => {
    refusedWith(
      readTokenFile(place(content), identity),
      'token_file_too_large',
    );
  });

  it.each([
    ['a token one character too long', `${'a'.repeat(4097)}\n`],
    ['a token without line ending at the limit', 'a'.repeat(4098)],
    ['the placeholder of a Secret', 'xxREDACTEDxx\n'],
  ])('refuse %s with the RangeError of Secret', (_, content) => {
    refusedWith(readTokenFile(place(content), asSecret), 'token_invalid');
  });

  it.each([0o644, 0o640, 0o604, 0o660, 0o606, 0o601])(
    'refuse mode %o',
    (mode) => {
      refusedWith(
        readTokenFile(place(`${token()}\n`, mode), identity),
        'token_file_mode',
      );
    },
  );

  it('refuse a link as the last part of the path, even to a good file', () => {
    const target = place(`${token()}\n`);
    const link = join(directory, `link-${randomUUID()}`);
    symlinkSync(target, link);
    refusedWith(readTokenFile(link, identity), 'token_file_symlink');
  });

  it('refuse a link whose target is missing', () => {
    const link = join(directory, `dangling-${randomUUID()}`);
    symlinkSync(join(directory, 'nothing'), link);
    refusedWith(readTokenFile(link, identity), 'token_file_symlink');
  });

  // O_NOFOLLOW checks only the last part. The folders above the file are
  // trusted (ADR 0055); this case shows the limit.
  it('read through a link in a folder above the file', () => {
    const folder = join(directory, `folder-${randomUUID()}`);
    mkdirSync(folder);
    const value = token();
    writeFileSync(join(folder, 'token'), `${value}\n`);
    chmodSync(join(folder, 'token'), 0o600);
    const link = join(directory, `folder-link-${randomUUID()}`);
    symlinkSync(folder, link);
    expect(readTokenFile(join(link, 'token'), identity)).toEqual({
      ok: true,
      value,
    });
  });

  it('refuse a missing file', () => {
    refusedWith(
      readTokenFile(join(directory, `missing-${randomUUID()}`), identity),
      'token_file_missing',
    );
  });

  it.each([
    ['a folder', () => directory],
    ['a character device', () => '/dev/null'],
  ])('refuse %s', (_, path) => {
    refusedWith(readTokenFile(path(), identity), 'token_file_not_regular');
  });

  it('refuse a path through a file as unsafe', () => {
    const file = place(`${token()}\n`);
    refusedWith(
      readTokenFile(join(file, 'token'), identity),
      'token_file_unsafe',
    );
  });

  it.each(['token', './token', '../token', ''])(
    'refuse the relative path %j',
    (path) => {
      refusedWith(readTokenFile(path, identity), 'token_file_relative');
    },
  );
});

describe('readTokenFile with injected file functions', () => {
  it('open with O_RDONLY, O_NOFOLLOW, O_NONBLOCK and O_NOCTTY', () => {
    const { fs, flags } = fake();
    expect(readTokenFile('/token', identity, fs).ok).toBe(true);
    expect(flags).toEqual([1 | 2 | 4 | 8]);
  });

  it.each(['O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_NOCTTY'] as const)(
    'stop before opening when %s is missing',
    (name) => {
      const { fs, flags } = fake({
        constants: { ...fakeConstants, [name]: undefined },
      });
      refusedWith(readTokenFile('/token', identity, fs), 'token_file_platform');
      expect(flags).toEqual([]);
    },
  );

  it('stop before opening when the platform has no user ID', () => {
    const { fs, flags } = fake({ getuid: () => undefined });
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_platform');
    expect(flags).toEqual([]);
  });

  it('refuse a file of another owner', () => {
    const { fs } = fake({ stats: { uid: fakeUid + 1 } });
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_owner');
  });

  it('refuse a file of root for a user that is not root', () => {
    const { fs } = fake({ stats: { uid: 0 } });
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_owner');
  });

  it('refuse by the size from fstat before reading', () => {
    const { fs, buffers } = fake({ stats: { size: maxTokenFileBytes + 1 } });
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_too_large');
    expect(buffers).toEqual([]);
  });

  it('refuse a file that grew after fstat', () => {
    const { fs } = fake({
      content: Buffer.alloc(100_000, 0x61),
      stats: { size: 10 },
    });
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_too_large');
  });

  it('read a file that arrives one byte at a time', () => {
    const value = token();
    const content = Buffer.from(`${value}\r\n`, 'latin1');
    const state = { position: 0 };
    const { fs } = fake({
      content,
      read: (buffer, offset) => {
        const byte = content[state.position];
        if (byte === undefined) return 0;
        buffer[offset] = byte;
        state.position += 1;
        return 1;
      },
    });
    expect(readTokenFile('/token', identity, fs)).toEqual({ ok: true, value });
  });

  it.each([
    ['a negative count', -1],
    ['a fraction', 0.5],
    ['more than it asked for', maxTokenFileBytes + 2],
    ['not a number', Number.NaN],
  ])('refuse a read that returns %s', (_, count) => {
    const { fs } = fake({ read: () => count });
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_unsafe');
  });

  it.each([
    ['ENOENT', 'token_file_missing'],
    ['ELOOP', 'token_file_symlink'],
    ['EMLINK', 'token_file_symlink'],
    ['EACCES', 'token_file_unreadable'],
    ['EPERM', 'token_file_unreadable'],
    ['ENOTDIR', 'token_file_unsafe'],
    ['ENXIO', 'token_file_unsafe'],
    ['toString', 'token_file_unsafe'],
  ] as const)('map the error %s of open to %s', (code, expected) => {
    const { fs, closed } = fake({
      open: () => {
        throw fsError(code);
      },
    });
    refusedWith(readTokenFile('/token', identity, fs), expected);
    expect(closed).toEqual([]);
  });

  it.each([
    ['a string', () => 'ENOENT'],
    ['null', () => null],
    ['an error without a code', () => new Error('open failed')],
    [
      'a code behind a getter',
      () =>
        Object.defineProperty(new Error('open failed'), 'code', {
          get: () => 'ENOENT',
        }),
    ],
    ['an inherited code', () => Object.create({ code: 'ENOENT' }) as object],
    ['a proxy', () => new Proxy(fsError('ENOENT'), {})],
  ])('treat %s thrown by open as unsafe', (_, thrown) => {
    const { fs } = fake({
      open: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- open may throw anything
        throw thrown();
      },
    });
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_unsafe');
  });

  it.each([
    [
      'fstat',
      {
        fstat: () => {
          throw fsError('EIO');
        },
      },
    ],
    [
      'read',
      {
        read: () => {
          throw fsError('EISDIR');
        },
      },
    ],
  ])('refuse a file whose %s throws, and close it', (_, options) => {
    const { fs, closed } = fake(options);
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_unsafe');
    expect(closed).toEqual([fakeFd]);
  });

  it('close the file once after a read', () => {
    const { fs, closed } = fake();
    expect(readTokenFile('/token', identity, fs).ok).toBe(true);
    expect(closed).toEqual([fakeFd]);
  });

  it('close the file once after a refusal', () => {
    const { fs, closed } = fake({ stats: { mode: 0o100644 } });
    refusedWith(readTokenFile('/token', identity, fs), 'token_file_mode');
    expect(closed).toEqual([fakeFd]);
  });

  it('keep the result when close throws', () => {
    const value = token();
    const { fs } = fake({
      content: Buffer.from(`${value}\n`, 'latin1'),
      close: () => {
        throw fsError('EIO');
      },
    });
    expect(readTokenFile('/token', identity, fs)).toEqual({ ok: true, value });
  });

  it.each([
    ['a token it read', `${'b'.repeat(20)}\n`, true],
    ['a token it refused', 'bbbb bbbb\n', false],
  ])('wipe the buffer after %s', (_, content, ok) => {
    const { fs, buffers } = fake({ content: Buffer.from(content, 'latin1') });
    expect(readTokenFile('/token', identity, fs).ok).toBe(ok);
    expect(buffers.length).toBeGreaterThan(0);
    for (const buffer of buffers) {
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    }
  });

  it.each([
    ['a TypeError', () => new TypeError('wrong')],
    ['an Error', () => new Error('wrong')],
    ['a string', () => 'wrong'],
  ])('treat %s from wrap as unsafe', (_, thrown) => {
    const { fs } = fake();
    const wrap = (): never => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- wrap may throw anything
      throw thrown();
    };
    refusedWith(readTokenFile('/token', wrap, fs), 'token_file_unsafe');
  });

  it('give no part of an error message or path in a refusal', () => {
    const canary = makeCanary('token').value;
    const { fs } = fake({
      open: () => {
        throw Object.assign(new Error(`ENOENT: open '/${canary}'`), {
          code: 'ENOENT',
          path: `/${canary}`,
        });
      },
    });
    const result = readTokenFile(`/${canary}`, identity, fs);
    refusedWith(result, 'token_file_missing');
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  // A pattern that looks for a bad byte matches only on a refused token,
  // so both cases count: the one read and the one refused.
  it.each([
    ['a token it read', (value: string) => `${value}\n`, true],
    ['a token it refused for a space', (value: string) => `${value} \n`, false],
    ['a token it refused for a tab', (value: string) => `\t${value}\n`, false],
  ])('leave %s out of the statics of regular expressions', (_, content, ok) => {
    const value = token();
    const { fs } = fake({ content: Buffer.from(content(value), 'latin1') });
    expect(/primed/.exec('primed')).not.toBeNull();
    expect(readTokenFile('/token', identity, fs).ok).toBe(ok);
    const statics = RegExp as unknown as Record<string, unknown>;
    for (const name of [
      '$_',
      'input',
      'lastMatch',
      '$&',
      'leftContext',
      'rightContext',
    ]) {
      expect(String(statics[name]), name).not.toContain(value);
    }
  });

  it.each([
    [
      'a path that is no string',
      () => readTokenFile(42 as unknown as string, identity),
    ],
    [
      'a wrap that is no function',
      () => readTokenFile('/token', 'wrap' as unknown as typeof identity),
    ],
  ])('throw a TypeError for %s', (_, call) => {
    expect(call).toThrow(TypeError);
  });
});

describe('tokenFileCodes', () => {
  it('is frozen and has each code once', () => {
    expect(Object.isFrozen(tokenFileCodes)).toBe(true);
    expect(new Set(tokenFileCodes).size).toBe(tokenFileCodes.length);
  });

  // The configuration reports a code as the log event config_<code>.
  it('fit the name of a log event behind a prefix', () => {
    for (const code of tokenFileCodes) {
      expect(isEventName(`config_${code}`), code).toBe(true);
    }
  });

  it('are each given by one case of the reader', () => {
    const disk = mkdtempSync(join(tmpdir(), 'ecclium-token-codes-'));
    try {
      const file = (content: string, mode = 0o600): string => {
        const path = join(disk, randomUUID());
        writeFileSync(path, Buffer.from(content, 'latin1'));
        chmodSync(path, mode);
        return path;
      };
      const link = join(disk, 'link');
      symlinkSync(file('abc\n'), link);
      const results: TokenFileResult<unknown>[] = [
        readTokenFile('token', identity),
        readTokenFile('/token', identity, fake({ getuid: () => undefined }).fs),
        readTokenFile(join(disk, 'missing'), identity),
        readTokenFile(link, identity),
        readTokenFile(
          '/token',
          identity,
          fake({
            open: () => {
              throw fsError('EACCES');
            },
          }).fs,
        ),
        readTokenFile(disk, identity),
        readTokenFile('/token', identity, fake({ stats: { uid: 1 } }).fs),
        readTokenFile(file('abc\n', 0o640), identity),
        readTokenFile(file('a'.repeat(5000)), identity),
        readTokenFile(file('\n'), identity),
        readTokenFile(file('\xef\xbb\xbfabc\n'), identity),
        readTokenFile(file('a b\n'), identity),
        readTokenFile(join(file('abc\n'), 'x'), identity),
        readTokenFile(file('xxREDACTEDxx\n'), asSecret),
      ];
      const codes = results.map((result) => (result.ok ? 'ok' : result.code));
      expect(codes).toEqual([...tokenFileCodes]);
    } finally {
      rmSync(disk, { recursive: true, force: true });
    }
  });
});
