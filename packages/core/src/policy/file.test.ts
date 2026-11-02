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

import type { TokenFileStats } from '../config/token-file.js';
import { defaultPolicy } from './check.js';
import {
  maxPolicyFileBytes,
  policyCodes,
  type PolicyFileSystem,
  readPolicyFile,
} from './file.js';

// Real files in a temporary folder cover what the disk can show: modes,
// links, folders and contents. Injected file functions cover what a test
// cannot build there, such as a file of another owner, a file that grows
// after the check or a platform without O_NOFOLLOW.

const policyText = [
  '# Policy of the parish',
  'schema: policy.v1',
  'interactive:',
  '  readBudgetPerDay: 150',
  '  targets:',
  '    - target: { kind: wiki_category, id: 12, name: Berichte }',
  '      tools: [ct_wiki_page_create]',
  '      maxPerDay: 4',
  '',
].join('\n');

let folder = '';

const file = (name: string, content: string | Uint8Array, mode = 0o600) => {
  const path = join(folder, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'ecclium-policy-'));
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('readPolicyFile on disk', () => {
  it('reads, parses and checks a policy', () => {
    const result = readPolicyFile(file('policy.yaml', policyText));
    expect(result).toMatchObject({
      ok: true,
      policy: { interactive: { readBudgetPerDay: 150 } },
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('takes a file that others may read', () => {
    expect(
      readPolicyFile(file('readable.yaml', 'schema: policy.v1\n', 0o644)),
    ).toEqual({ ok: true, policy: defaultPolicy });
  });

  it.each([
    ['the group may write', 0o620],
    ['others may write', 0o602],
  ])('refuses a file %s', (_name, mode) => {
    expect(
      readPolicyFile(file(`mode-${mode.toString(8)}.yaml`, policyText, mode)),
    ).toEqual({ ok: false, code: 'policy_file_mode' });
  });

  it('refuses a relative path, a missing file, a link and a folder', () => {
    expect(readPolicyFile('policy.yaml')).toEqual({
      ok: false,
      code: 'policy_file_relative',
    });
    expect(readPolicyFile(join(folder, 'missing.yaml'))).toEqual({
      ok: false,
      code: 'policy_file_missing',
    });
    const target = file('target.yaml', policyText);
    const link = join(folder, 'link.yaml');
    symlinkSync(target, link);
    expect(readPolicyFile(link)).toEqual({
      ok: false,
      code: 'policy_file_symlink',
    });
    const inner = join(folder, 'inner');
    mkdirSync(inner, { mode: 0o700 });
    expect(readPolicyFile(inner)).toEqual({
      ok: false,
      code: 'policy_file_not_regular',
    });
  });

  it('takes a file of exactly 256 KiB and refuses one byte more', () => {
    const text = (size: number) =>
      `schema: policy.v1\n${'#'.repeat(size - 19)}\n`;
    expect(text(maxPolicyFileBytes)).toHaveLength(maxPolicyFileBytes);
    expect(
      readPolicyFile(file('largest.yaml', text(maxPolicyFileBytes))).ok,
    ).toBe(true);
    expect(
      readPolicyFile(file('too-large.yaml', text(maxPolicyFileBytes + 1))),
    ).toEqual({ ok: false, code: 'policy_file_too_large' });
  });

  it.each([
    ['UTF-8', [0xef, 0xbb, 0xbf]],
    ['UTF-16 in little endian', [0xff, 0xfe]],
    ['UTF-16 in big endian', [0xfe, 0xff]],
  ])('refuses a byte order mark of %s', (name, mark) => {
    const content = new Uint8Array([
      ...mark,
      ...new TextEncoder().encode('schema: policy.v1\n'),
    ]);
    expect(readPolicyFile(file(`bom-${name}.yaml`, content))).toEqual({
      ok: false,
      code: 'policy_file_bom',
    });
  });

  it('refuses bytes that are no UTF-8', () => {
    const content = new Uint8Array([
      ...new TextEncoder().encode('schema: policy.v1\n# '),
      0xc3,
      0x28,
      0x0a,
    ]);
    expect(readPolicyFile(file('latin.yaml', content))).toEqual({
      ok: false,
      code: 'policy_file_encoding',
    });
  });

  it('passes on the line of a problem of YAML and the field of the check', () => {
    expect(
      readPolicyFile(file('syntax.yaml', 'schema: policy.v1\nschema: x\n')),
    ).toEqual({ ok: false, code: 'policy_yaml_syntax', line: 2 });
    expect(
      readPolicyFile(
        file(
          'field.yaml',
          'schema: policy.v1\ninteractive: { readBudgetPerDay: 1001 }\n',
        ),
      ),
    ).toEqual({
      ok: false,
      code: 'policy_invalid',
      field: 'interactive.readBudgetPerDay',
    });
  });

  it('never names the path or a value', () => {
    const result = readPolicyFile(
      file('secret-name.yaml', 'schema: policy.v1\nunknownKey: value\n'),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /secret-name|unknownKey|value|ecclium-policy/u,
    );
  });

  it('refuses a path that is not a string', () => {
    expect(() => readPolicyFile(12 as unknown as string)).toThrow(TypeError);
  });
});

// Distinct bits, so that a missing flag changes the sum.
const fakeConstants = Object.freeze({
  O_RDONLY: 1,
  O_NOFOLLOW: 2,
  O_NONBLOCK: 4,
  O_NOCTTY: 8,
});
const fakeUid = 1000;

interface FakeOptions {
  readonly content?: Uint8Array;
  readonly stats?: Partial<Omit<TokenFileStats, 'isFile'>>;
  readonly open?: () => never;
  readonly fstat?: () => never;
  readonly read?: (length: number) => number;
  readonly close?: () => never;
  readonly getuid?: () => number | undefined;
  readonly constants?: PolicyFileSystem['constants'];
  /** The most bytes one read returns. */
  readonly chunk?: number;
}

/** File functions over a content in memory, recording the flags of open. */
const fake = (options: FakeOptions = {}) => {
  const content =
    options.content ?? new TextEncoder().encode('schema: policy.v1\n');
  const flags: number[] = [];
  let position = 0;
  const fs: PolicyFileSystem = {
    openSync: (_path, flag) => {
      flags.push(flag);
      options.open?.();
      return 42;
    },
    fstatSync: () => {
      options.fstat?.();
      return {
        isFile: () => true,
        uid: fakeUid,
        mode: 0o100600,
        size: content.length,
        ...options.stats,
      };
    },
    readSync: (_fd, buffer, offset, length) => {
      if (options.read !== undefined) return options.read(length);
      const count = Math.min(
        length,
        options.chunk ?? length,
        content.length - position,
      );
      buffer.set(content.subarray(position, position + count), offset);
      position += count;
      return count;
    },
    closeSync: () => {
      options.close?.();
    },
    getuid: options.getuid ?? (() => fakeUid),
    constants: options.constants ?? fakeConstants,
  };
  return { fs, flags };
};

describe('readPolicyFile with injected file functions', () => {
  it('opens without following a link, without blocking and without a terminal', () => {
    const { fs, flags } = fake();
    expect(readPolicyFile('/policy.yaml', fs)).toEqual({
      ok: true,
      policy: defaultPolicy,
    });
    expect(flags).toEqual([1 | 2 | 4 | 8]);
  });

  it('reads a file that comes in small pieces', () => {
    const { fs } = fake({
      content: new TextEncoder().encode(policyText),
      chunk: 7,
    });
    expect(readPolicyFile('/policy.yaml', fs).ok).toBe(true);
  });

  it.each([
    [
      'without O_NOFOLLOW',
      { constants: { ...fakeConstants, O_NOFOLLOW: undefined } },
    ],
    [
      'without O_RDONLY',
      { constants: { ...fakeConstants, O_RDONLY: undefined } },
    ],
    [
      'without O_NONBLOCK',
      { constants: { ...fakeConstants, O_NONBLOCK: undefined } },
    ],
    [
      'without O_NOCTTY',
      { constants: { ...fakeConstants, O_NOCTTY: undefined } },
    ],
    ['without the ID of the user', { getuid: () => undefined }],
  ])('stops on a platform %s', (_name, options: FakeOptions) => {
    expect(readPolicyFile('/policy.yaml', fake(options).fs)).toEqual({
      ok: false,
      code: 'policy_file_platform',
    });
  });

  it.each([
    ['ENOENT', 'policy_file_missing'],
    ['ELOOP', 'policy_file_symlink'],
    ['EMLINK', 'policy_file_symlink'],
    ['EACCES', 'policy_file_unreadable'],
    ['EPERM', 'policy_file_unreadable'],
    ['ENOTDIR', 'policy_file_unsafe'],
  ])('reads the error %s of open as %s', (code, expected) => {
    const open = (): never => {
      throw Object.assign(new Error('/the/path'), { code });
    };
    expect(readPolicyFile('/policy.yaml', fake({ open }).fs)).toEqual({
      ok: false,
      code: expected,
    });
  });

  it.each([
    ['no object', 'boom'],
    ['null', null],
    ['a proxy', new Proxy({ code: 'ENOENT' }, {})],
  ])('reads an error of open that is %s as unsafe', (_name, thrown) => {
    const open = (): never => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- open may throw anything
      throw thrown;
    };
    expect(readPolicyFile('/policy.yaml', fake({ open }).fs)).toEqual({
      ok: false,
      code: 'policy_file_unsafe',
    });
  });

  it.each([
    ['of another owner', { stats: { uid: fakeUid + 1 } }, 'policy_file_owner'],
    [
      'that says it is too large',
      { stats: { size: maxPolicyFileBytes + 1 } },
      'policy_file_too_large',
    ],
    [
      'that grows after the check',
      {
        content: new Uint8Array(maxPolicyFileBytes + 10),
        stats: { size: 10 },
      },
      'policy_file_too_large',
    ],
    ['whose read returns -1', { read: () => -1 }, 'policy_file_unsafe'],
    [
      'whose read returns half a byte',
      { read: () => 0.5 },
      'policy_file_unsafe',
    ],
    [
      'whose read returns more than it was asked',
      { read: (length: number) => length + 1 },
      'policy_file_unsafe',
    ],
    [
      'whose stat throws',
      {
        fstat: (): never => {
          throw new Error('/the/path');
        },
      },
      'policy_file_unsafe',
    ],
  ])('refuses a file %s', (_name, options: FakeOptions, code) => {
    expect(readPolicyFile('/policy.yaml', fake(options).fs)).toEqual({
      ok: false,
      code,
    });
  });

  it('refuses a file that is no regular file', () => {
    const { fs } = fake();
    const notRegular: PolicyFileSystem = {
      ...fs,
      fstatSync: (fd) => ({ ...fs.fstatSync(fd), isFile: () => false }),
    };
    expect(readPolicyFile('/policy.yaml', notRegular)).toEqual({
      ok: false,
      code: 'policy_file_not_regular',
    });
  });

  it('keeps its result when the file does not close', () => {
    const close = (): never => {
      throw new Error('/the/path');
    };
    expect(readPolicyFile('/policy.yaml', fake({ close }).fs)).toEqual({
      ok: true,
      policy: defaultPolicy,
    });
  });
});

describe('the codes of a policy', () => {
  it('are frozen, unique and name no path', () => {
    expect(Object.isFrozen(policyCodes)).toBe(true);
    expect(new Set(policyCodes).size).toBe(policyCodes.length);
    for (const code of policyCodes) expect(code).toMatch(/^policy_[a-z_]+$/u);
  });
});
