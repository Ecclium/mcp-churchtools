import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import {
  assertNoCanary,
  assertPlanted,
  makeCanaries,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Secret } from '../http/index.js';
import { isEventName } from '../logger/index.js';
import {
  type ConfigProblemCode,
  configProblemCodes,
  type ConfigWarningCode,
  configWarningCodes,
} from './codes.js';
import {
  type ConfigResult,
  loadAuditConfig,
  loadConfig,
  maxReportedProblems,
  type Transport,
} from './load.js';
import type { StateDirFileSystem } from './state-dir.js';
import type { TokenFileStats, TokenFileSystem } from './token-file.js';
import {
  tokenVariableName,
  trustStoreVariableNames,
  unsupportedVariableNames,
  variableNames,
  variables,
  variableSchemas,
} from './variables.js';

// The loader gets the environment as a record and the token file through
// file functions in memory, so almost no test here touches the real
// environment or the disk. The token variable is always written as a
// computed key: a literal assignment of a long value to it is what the
// secret scan of this repository stops.

type Environment = Record<string, string | undefined>;

const address = 'https://example.church.tools';
const tokenPath = '/path/to/token-file';

/** A token of visible ASCII, new on every call. */
const token = (): string => makeCanary('token').value;

interface MemoryFiles {
  readonly fs: TokenFileSystem;
  readonly opened: string[];
}

/** File functions over one file in memory: by default a good token file. */
const memoryFiles = (
  content = `${token()}\n`,
  options: {
    readonly stats?: Partial<Omit<TokenFileStats, 'isFile'>> & {
      readonly isFile?: boolean;
    };
    readonly open?: () => never;
    readonly getuid?: () => number | undefined;
  } = {},
): MemoryFiles => {
  const bytes = Buffer.from(content, 'latin1');
  const opened: string[] = [];
  const state = { position: 0 };
  const fs: TokenFileSystem = {
    openSync: (path) => {
      opened.push(path);
      options.open?.();
      state.position = 0;
      return 3;
    },
    fstatSync: () => ({
      isFile: () => options.stats?.isFile ?? true,
      uid: options.stats?.uid ?? 1000,
      mode: options.stats?.mode ?? 0o100600,
      size: options.stats?.size ?? bytes.length,
    }),
    readSync: (_fd, buffer, offset, length) => {
      const chunk = bytes.subarray(state.position, state.position + length);
      buffer.set(chunk, offset);
      state.position += chunk.length;
      return chunk.length;
    },
    closeSync: () => undefined,
    getuid: options.getuid ?? (() => 1000),
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, O_NOCTTY: 4 },
  };
  return { fs, opened };
};

const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: open '${tokenPath}'`), { code });

const failingOpen = (code: string): TokenFileSystem =>
  memoryFiles(undefined, {
    open: () => {
      throw fsError(code);
    },
  }).fs;

/** The address and a token file: the smallest configuration that loads. */
const valid = (): Environment => ({
  ECCLIUM_CHURCHTOOLS_URL: address,
  ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
});

const stateDirPath = '/path/to/state';

/** What lstat finds at a path: a folder with these fields, or an error. */
type Entry =
  | {
      readonly directory?: boolean;
      readonly symlink?: boolean;
      readonly uid?: number;
      readonly mode?: number;
    }
  | { readonly error: string };

interface MemoryFolder {
  readonly fs: StateDirFileSystem;
  readonly looked: string[];
}

/**
 * File functions over the folder of state in memory: by default a folder
 * of the user with 0700 and no folder audit yet.
 */
const memoryFolder = (
  options: {
    readonly folder?: Entry;
    readonly audit?: Entry;
    readonly quota?: Entry;
    readonly getuid?: () => number | undefined;
  } = {},
): MemoryFolder => {
  const looked: string[] = [];
  const entryOf = (path: string): Entry =>
    path.endsWith('/audit')
      ? (options.audit ?? { error: 'ENOENT' })
      : path.endsWith('/quota')
        ? (options.quota ?? { error: 'ENOENT' })
        : (options.folder ?? {});
  const fs: StateDirFileSystem = {
    lstatSync: (path) => {
      looked.push(path);
      const entry = entryOf(path);
      if ('error' in entry) {
        throw Object.assign(new Error(`${entry.error}: lstat '${path}'`), {
          code: entry.error,
        });
      }
      return {
        isDirectory: () => entry.directory ?? true,
        isSymbolicLink: () => entry.symlink ?? false,
        uid: entry.uid ?? 1000,
        mode: entry.mode ?? 0o40700,
      };
    },
    getuid: options.getuid ?? (() => 1000),
    constants: { O_NOFOLLOW: 1, O_DIRECTORY: 2, O_NOCTTY: 4 },
  };
  return { fs, looked };
};

const load = (
  environment: Environment,
  transport: Transport = 'stdio',
  files: TokenFileSystem = memoryFiles().fs,
  execArgv?: readonly string[],
  folders: StateDirFileSystem = memoryFolder().fs,
): ConfigResult =>
  loadConfig({
    environment,
    transport,
    execArgv,
    tokenFiles: files,
    stateDirFiles: folders,
  });

/** A good configuration with a folder of state. */
const withStateDir = (
  value: string,
  folders: StateDirFileSystem = memoryFolder().fs,
  transport: Transport = 'stdio',
): ConfigResult =>
  load(
    { ...valid(), ECCLIUM_STATE_DIR: value },
    transport,
    memoryFiles().fs,
    undefined,
    folders,
  );

/** The options of the start alone, with a good configuration. */
const started = (execArgv: readonly string[]): ConfigResult =>
  load(valid(), 'stdio', memoryFiles().fs, execArgv);

/** The problems as [code] or [code, variable]. */
const problems = (result: ConfigResult): string[][] =>
  result.report.problems.map(({ code, variable }) =>
    variable === undefined ? [code] : [code, variable],
  );

const codes = (result: ConfigResult): string[] =>
  result.report.problems.map((problem) => problem.code);

const setting = (result: ConfigResult, key: string) =>
  result.report.settings.find((entry) => entry.key === key);

const invalidSources = 'The configuration sources are invalid.';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig with a good configuration', () => {
  it('loads the defaults from the address and a token file', () => {
    const result = load(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ ...result.config, churchtoolsToken: undefined }).toEqual({
      transport: 'stdio',
      churchtoolsOrigin: address,
      churchtoolsToken: undefined,
      tokenSource: 'file',
      churchtoolsRequestsPerMinute: 300,
      readOnly: true,
      redaction: 'standard',
      toolsets: [],
      stateDir: undefined,
      auditRetentionMonths: 12,
      stdioSubject: 'local-stdio',
      logLevel: 'info',
    });
    expect(Object.hasOwn(result.config, 'stateDir')).toBe(true);
    expect(result.config.churchtoolsToken).toBeInstanceOf(Secret);
    expect(result.report.problems).toEqual([]);
    expect(result.report.omittedProblems).toBe(0);
    expect(result.report.warnings).toEqual([]);
  });

  it('reports each setting once, in a fixed order, with its origin', () => {
    const result = load(valid());
    expect(
      result.report.settings.map(({ key, variable, origin, shown }) => [
        key,
        variable,
        origin,
        shown,
      ]),
    ).toEqual([
      [
        'churchtoolsOrigin',
        'ECCLIUM_CHURCHTOOLS_URL',
        'environment',
        { kind: 'origin', host: 'example.church.tools', port: '' },
      ],
      [
        'churchtoolsToken',
        'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
        'file',
        { kind: 'hidden' },
      ],
      [
        'churchtoolsRequestsPerMinute',
        'ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE',
        'default',
        { kind: 'integer', value: 300 },
      ],
      [
        'readOnly',
        'ECCLIUM_READ_ONLY',
        'default',
        { kind: 'boolean', value: true },
      ],
      [
        'redaction',
        'ECCLIUM_REDACTION',
        'default',
        { kind: 'choice', value: 'standard' },
      ],
      ['toolsets', 'ECCLIUM_TOOLSETS', 'default', { kind: 'list', values: [] }],
      ['stateDir', 'ECCLIUM_STATE_DIR', 'unset', { kind: 'none' }],
      [
        'auditRetentionMonths',
        'ECCLIUM_AUDIT_RETENTION_MONTHS',
        'default',
        { kind: 'integer', value: 12 },
      ],
      [
        'stdioSubject',
        'ECCLIUM_STDIO_SUBJECT',
        'default',
        { kind: 'choice', value: 'local-stdio' },
      ],
      [
        'logLevel',
        'ECCLIUM_LOG_LEVEL',
        'default',
        { kind: 'choice', value: 'info' },
      ],
    ]);
  });

  it('takes every variable as given', () => {
    const result = load({
      ...valid(),
      ECCLIUM_CHURCHTOOLS_URL: 'https://demo.example:8443/',
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_REDACTION: 'off',
      ECCLIUM_TOOLSETS: 'wiki,persons',
      ECCLIUM_STATE_DIR: stateDirPath,
      ECCLIUM_STDIO_SUBJECT: 'local-operator-2',
      ECCLIUM_LOG_LEVEL: 'debug',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      churchtoolsOrigin: 'https://demo.example:8443',
      readOnly: false,
      redaction: 'off',
      toolsets: ['persons', 'wiki'],
      stateDir: stateDirPath,
      stdioSubject: 'local-operator-2',
      logLevel: 'debug',
    });
    expect(setting(result, 'churchtoolsOrigin')?.shown).toEqual({
      kind: 'origin',
      host: 'demo.example',
      port: '8443',
    });
    expect(result.report.warnings).toEqual([
      'redaction_off',
      'persons_toolset_enabled',
    ]);
    expect(Object.isFrozen(result.config.toolsets)).toBe(true);
    expect(setting(result, 'toolsets')?.shown).toEqual({
      kind: 'list',
      values: ['persons', 'wiki'],
    });
  });

  it('names the environment as origin even for the default value', () => {
    const result = load({ ...valid(), ECCLIUM_READ_ONLY: 'true' });
    expect(setting(result, 'readOnly')?.origin).toBe('environment');
  });

  it('reads the token from the environment over stdio, with a warning', () => {
    const result = load({
      ECCLIUM_CHURCHTOOLS_URL: address,
      [tokenVariableName]: token(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.tokenSource).toBe('environment');
    expect(result.config.churchtoolsToken).toBeInstanceOf(Secret);
    expect(result.report.warnings).toEqual(['token_from_environment']);
    expect(setting(result, 'churchtoolsToken')).toMatchObject({
      variable: tokenVariableName,
      origin: 'environment',
      shown: { kind: 'hidden' },
    });
  });

  it('loads over http without the rules of stdio', () => {
    const result = load(valid(), 'http');
    expect(result.ok && result.config.transport).toBe('http');
  });
});

describe('loadConfig and the folder of state', () => {
  it('leaves the folder unset without looking at the disk', () => {
    const folder = memoryFolder();
    const result = load(
      valid(),
      'stdio',
      memoryFiles().fs,
      undefined,
      folder.fs,
    );
    expect(result.ok && result.config.stateDir).toBeUndefined();
    expect(setting(result, 'stateDir')).toMatchObject({
      variable: 'ECCLIUM_STATE_DIR',
      origin: 'unset',
      shown: { kind: 'none' },
    });
    expect(folder.looked).toEqual([]);
  });

  it('takes a checked folder and looks at it and at its folders audit and quota', () => {
    const folder = memoryFolder({ audit: { mode: 0o40700 } });
    const result = withStateDir(stateDirPath, folder.fs);
    expect(result.ok && result.config.stateDir).toBe(stateDirPath);
    expect(setting(result, 'stateDir')).toMatchObject({
      origin: 'environment',
      shown: { kind: 'path', value: stateDirPath },
    });
    expect(folder.looked).toEqual([
      stateDirPath,
      `${stateDirPath}/audit`,
      `${stateDirPath}/quota`,
    ]);
  });

  it('refuses the folder and keeps its path out of the report', () => {
    const result = withStateDir(
      stateDirPath,
      memoryFolder({ folder: { mode: 0o40755 } }).fs,
    );
    expect(result.ok).toBe(false);
    expect(problems(result)).toEqual([['state_dir_mode', 'ECCLIUM_STATE_DIR']]);
    expect(setting(result, 'stateDir')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
    expect(JSON.stringify(result.report)).not.toContain(stateDirPath);
  });

  it.each([
    ['an empty value', '', [['empty_value', 'ECCLIUM_STATE_DIR']]],
    [
      'a value of 961 characters',
      `/${'a'.repeat(960)}`,
      [['value_too_long', 'ECCLIUM_STATE_DIR']],
    ],
  ])('refuses %s without looking at the disk', (_name, value, expected) => {
    const folder = memoryFolder();
    expect(problems(withStateDir(value, folder.fs))).toEqual(expected);
    expect(folder.looked).toEqual([]);
  });

  it('takes a path of 960 characters', () => {
    const value = `/${'a'.repeat(959)}`;
    expect(withStateDir(value).ok).toBe(true);
  });

  it('refuses the folder over http without looking at the disk', () => {
    const folder = memoryFolder();
    const result = withStateDir(stateDirPath, folder.fs, 'http');
    expect(problems(result)).toEqual([['stdio_only', 'ECCLIUM_STATE_DIR']]);
    expect(folder.looked).toEqual([]);
  });

  it('reports the folder after the toolsets and before the subject', () => {
    const result = load({
      ...valid(),
      ECCLIUM_STDIO_SUBJECT: 'Local',
      ECCLIUM_STATE_DIR: 'state',
      ECCLIUM_TOOLSETS: 'yes',
    });
    expect(problems(result)).toEqual([
      ['invalid_toolsets', 'ECCLIUM_TOOLSETS'],
      ['state_dir_relative', 'ECCLIUM_STATE_DIR'],
      ['subject_invalid', 'ECCLIUM_STDIO_SUBJECT'],
    ]);
  });

  describe('on the disk', () => {
    const base = mkdtempSync(join(tmpdir(), 'ecclium-load-state-'));

    afterAll(() => {
      rmSync(base, { recursive: true, force: true });
    });

    const loadFromDisk = (value: string): ConfigResult =>
      loadConfig({
        environment: { ...valid(), ECCLIUM_STATE_DIR: value },
        transport: 'stdio',
        tokenFiles: memoryFiles().fs,
      });

    it('checks the real folder when no file functions are given', () => {
      expect(problems(loadFromDisk(join(base, 'missing')))).toEqual([
        ['state_dir_missing', 'ECCLIUM_STATE_DIR'],
      ]);
    });

    it('creates nothing, not even the folder audit', () => {
      const folder = join(base, 'state');
      mkdirSync(folder, { mode: 0o700 });
      expect(loadFromDisk(folder).ok).toBe(true);
      expect(existsSync(join(folder, 'audit'))).toBe(false);
    });
  });
});

describe('loadConfig and its sources', () => {
  it('never reads process.env', () => {
    vi.stubEnv('ECCLIUM_READ_ONLY', 'false');
    vi.stubEnv('ECCLIUM_REDACTION', 'off');
    const result = load(valid());
    expect(result.ok && result.config.readOnly).toBe(true);
    expect(result.ok && result.config.redaction).toBe('standard');
    expect(result.report.warnings).toEqual([]);
  });

  it('ignores values on Object.prototype', () => {
    const prototype = Object.prototype as Record<string, unknown>;
    const polluted = {
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_REDACTION: 'off',
      ECCLIUM_TOOLSETS: 'persons',
      ECCLIUM_CHURCHTOOLS_URL: address,
    };
    const result = (() => {
      try {
        Object.assign(prototype, polluted);
        return load({ ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath });
      } finally {
        for (const key of Object.keys(polluted)) {
          Reflect.deleteProperty(prototype, key);
        }
      }
    })();
    expect(codes(result)).toEqual(['url_missing']);
    for (const entry of result.report.settings) {
      expect(entry.origin, entry.key).not.toBe('environment');
    }
  });

  it('ignores inherited values', () => {
    const environment = Object.assign(
      Object.create({ ECCLIUM_REDACTION: 'off' }) as Environment,
      valid(),
    );
    const result = load(environment);
    expect(result.ok && result.config.redaction).toBe('standard');
    expect(setting(result, 'redaction')?.origin).toBe('default');
  });

  it('takes a record without a prototype', () => {
    const environment = Object.assign(
      Object.create(null) as Environment,
      valid(),
    );
    expect(load(environment).ok).toBe(true);
  });

  it('counts an own undefined as unset, but the string undefined as a value', () => {
    const unset = load({ ...valid(), ECCLIUM_READ_ONLY: undefined });
    expect(unset.ok && unset.config.readOnly).toBe(true);
    expect(setting(unset, 'readOnly')?.origin).toBe('default');
    expect(
      problems(load({ ...valid(), ECCLIUM_READ_ONLY: 'undefined' })),
    ).toEqual([['value_too_long', 'ECCLIUM_READ_ONLY']]);
  });

  it('refuses a getter on a variable with the prefix without calling it', () => {
    const getter = vi.fn(() => 'false');
    const environment = Object.defineProperty(valid(), 'ECCLIUM_READ_ONLY', {
      get: getter,
      enumerable: true,
    });
    expect(() => load(environment)).toThrow(invalidSources);
    expect(getter).not.toHaveBeenCalled();
  });

  it('never touches a variable without the prefix', () => {
    const getter = vi.fn(() => '/usr/bin');
    const environment = Object.defineProperty(valid(), 'PATH', {
      get: getter,
      enumerable: true,
    });
    expect(load(environment).ok).toBe(true);
    expect(getter).not.toHaveBeenCalled();
  });

  it('refuses a proxy, also a revoked one, without running a trap', () => {
    const trap = vi.fn();
    const traps: ProxyHandler<object> = {
      get: trap,
      has: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
    };
    expect(() => load(new Proxy<Environment>(valid(), traps))).toThrow(
      invalidSources,
    );
    const { proxy, revoke } = Proxy.revocable(valid(), {});
    revoke();
    expect(() => load(proxy)).toThrow(invalidSources);
    expect(() =>
      loadConfig(
        new Proxy<Parameters<typeof loadConfig>[0]>(
          { environment: valid(), transport: 'stdio' },
          traps,
        ),
      ),
    ).toThrow(invalidSources);
    expect(trap).not.toHaveBeenCalled();
  });

  it.each([
    ['an array', []],
    ['a map', new Map([['ECCLIUM_READ_ONLY', 'true']])],
    ['a set', new Set(['ECCLIUM_READ_ONLY'])],
    ['null', null],
    ['a string', 'ECCLIUM_READ_ONLY=true'],
    ['a boxed string', Object('ECCLIUM_READ_ONLY=true') as object],
  ])('refuses %s as the environment', (_, environment) => {
    expect(() =>
      loadConfig({
        environment: environment as unknown as Environment,
        transport: 'stdio',
      }),
    ).toThrow(invalidSources);
  });

  it.each([
    ['a number', 1],
    ['a symbol', Symbol('value')],
    ['an object', { value: 'true' }],
  ])(
    'refuses %s under a name with the prefix, with a fixed message',
    (_, value) => {
      const environment = {
        ...valid(),
        ECCLIUM_READ_ONLY: value,
      } as unknown as Environment;
      expect(() => load(environment)).toThrow(new TypeError(invalidSources));
    },
  );

  it('ignores a value that is no string under another name', () => {
    const environment = { ...valid(), OTHER: 1 } as unknown as Environment;
    expect(load(environment).ok).toBe(true);
  });

  it.each(['HTTP', undefined])('refuses the transport %j', (transport) => {
    expect(() =>
      loadConfig({
        environment: valid(),
        transport: transport as unknown as Transport,
      }),
    ).toThrow('The transport is unknown.');
  });

  it('refuses sources with a getter or that are no record', () => {
    const getter = vi.fn(() => valid());
    const sources = Object.defineProperty(
      { transport: 'stdio' as const },
      'environment',
      { get: getter, enumerable: true },
    ) as unknown as Parameters<typeof loadConfig>[0];
    expect(() => loadConfig(sources)).toThrow(invalidSources);
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      loadConfig(null as unknown as Parameters<typeof loadConfig>[0]),
    ).toThrow(invalidSources);
    expect(() =>
      loadConfig({
        environment: valid(),
        transport: 'stdio',
        tokenFiles: 'fs' as unknown as TokenFileSystem,
      }),
    ).toThrow(invalidSources);
    expect(() =>
      loadConfig({
        environment: valid(),
        transport: 'stdio',
        stateDirFiles: 'fs' as unknown as StateDirFileSystem,
      }),
    ).toThrow(invalidSources);
  });

  it('never changes the environment', () => {
    const environment = Object.freeze({
      ...valid(),
      ECCLIUM_REDACTION: 'off',
    });
    const before = { ...environment };
    expect(load(environment).ok).toBe(true);
    expect(environment).toEqual(before);
  });

  it('reads no value of 10 000 other variables', () => {
    const getter = vi.fn(() => 'value');
    const environment = valid();
    for (let index = 0; index < 10_000; index += 1) {
      Object.defineProperty(environment, `OTHER_${String(index)}`, {
        get: getter,
        enumerable: true,
      });
    }
    expect(load(environment).ok).toBe(true);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('loadConfig and the names of variables', () => {
  it('refuses an unknown name with the prefix and names it', () => {
    expect(problems(load({ ...valid(), ECCLIUM_REDONLY: 'true' }))).toEqual([
      ['unknown_variable', 'ECCLIUM_REDONLY'],
    ]);
  });

  it.each(['ecclium_read_only', 'Ecclium_Read_Only', 'ECCLIUM_read_only'])(
    'refuses the name %s in the wrong case and names the right one',
    (name) => {
      const result = load({ ...valid(), [name]: 'false' });
      expect(problems(result)).toEqual([
        ['miscased_variable', 'ECCLIUM_READ_ONLY'],
      ]);
      expect(setting(result, 'readOnly')?.origin).toBe('default');
    },
  );

  it('refuses a weaker twin in the wrong case next to the exact name', () => {
    const result = load({
      ...valid(),
      ECCLIUM_REDACTION: 'standard',
      ecclium_redaction: 'off',
    });
    expect(result.ok).toBe(false);
    expect(problems(result)).toEqual([
      ['miscased_variable', 'ECCLIUM_REDACTION'],
    ]);
  });

  // Only a to z become capitals: a long s or a dotless i must not turn a
  // lookalike name into a known one.
  it('folds the case in ASCII only', () => {
    const lookalike = load({
      ...valid(),
      ['ECCLIUM_\u017fEARCH_TOOLS']: 'true',
    });
    expect(problems(lookalike)).toEqual([['unknown_variable']]);
    const prefix = load({ ...valid(), ['eccl\u0131um_read_only']: 'false' });
    expect(prefix.ok && prefix.config.readOnly).toBe(true);
  });

  it('refuses a name with a lookalike letter without naming it', () => {
    expect(
      problems(load({ ...valid(), ['ECCLIUM_RED\u0410CTION']: 'off' })),
    ).toEqual([['unknown_variable']]);
  });

  // A typo in the prefix itself goes unnoticed; the safe defaults remain.
  it('ignores a name whose prefix is wrong', () => {
    const result = load({
      ...valid(),
      ECLIUM_READ_ONLY: 'false',
      ['\u0415CCLIUM_REDACTION']: 'off',
    });
    expect(result.ok && result.config.readOnly).toBe(true);
    expect(result.ok && result.config.redaction).toBe('standard');
  });

  it.each([
    'ECCLIUM_SPIKE_TOKEN_FILE',
    'ECCLIUM_NETNS',
    'ECCLIUM_NETWORK_PROOF_CHILD',
    'ECCLIUM_TENANT',
    'ECCLIUM_MODE',
    'ECCLIUM_TRANSPORT',
    'ECCLIUM_ACTOR',
  ])('refuses %s, which is no variable of the server', (name) => {
    expect(problems(load({ ...valid(), [name]: 'x' }))).toEqual([
      ['unknown_variable', name],
    ]);
  });

  it('refuses each name of a later phase as not yet supported', () => {
    expect(unsupportedVariableNames).toEqual([
      'ECCLIUM_WRITE_CONFIRMATION',
      'ECCLIUM_EGRESS',
      'ECCLIUM_EGRESS_ALLOW_LAN',
      'ECCLIUM_ALLOWED_HOSTS',
    ]);
    for (const name of unsupportedVariableNames) {
      expect(problems(load({ ...valid(), [name]: 'x' })), name).toEqual([
        ['unsupported_variable', name],
      ]);
      expect(
        problems(load({ ...valid(), [name.toLowerCase()]: 'x' })),
        name,
      ).toEqual([['unsupported_variable', name]]);
    }
  });

  it('names an unknown name of 64 characters after the prefix', () => {
    const name = `ECCLIUM_${'A'.repeat(63)}9`;
    expect(problems(load({ ...valid(), [name]: 'x' }))).toEqual([
      ['unknown_variable', name],
    ]);
  });

  it.each([
    ['a canary', () => `ECCLIUM_${token()}`],
    ['65 capitals', () => `ECCLIUM_${'A'.repeat(65)}`],
    ['a space', () => 'ECCLIUM_FOO BAR'],
    ['small letters', () => 'ECCLIUM_foo'],
    ['the bare prefix', () => 'ECCLIUM_'],
    ['a million characters', () => `ECCLIUM_${'A'.repeat(1_000_000)}`],
  ])('refuses an unknown name with %s without naming it', (_, name) => {
    expect(problems(load({ ...valid(), [name()]: 'x' }))).toEqual([
      ['unknown_variable'],
    ]);
  });

  it('ignores the proxy variables of other tools', () => {
    const result = load({
      ...valid(),
      HTTPS_PROXY: 'http://proxy.example:3128',
      HTTP_PROXY: 'http://proxy.example:3128',
      NO_PROXY: 'demo.example',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(result.ok).toBe(true);
    expect(result.report.warnings).toEqual([]);
  });
});

describe('loadConfig and the values of variables', () => {
  it.each([
    'TRUE',
    'True',
    ' true',
    'true ',
    'true\n',
    'true\r',
    'yes',
    '1',
    'on',
  ])('refuses the boolean %j', (value) => {
    const result = load({ ...valid(), ECCLIUM_READ_ONLY: value });
    expect(problems(result)).toEqual([['invalid_choice', 'ECCLIUM_READ_ONLY']]);
    expect(setting(result, 'readOnly')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  // Only an empty list of toolsets is valid, as none (ADR 0062).
  it.each(variableNames.filter((name) => name !== 'ECCLIUM_TOOLSETS'))(
    'refuses an empty %s and applies no default',
    (name) => {
      const environment =
        name === tokenVariableName
          ? { ECCLIUM_CHURCHTOOLS_URL: address, [name]: '' }
          : { ...valid(), [name]: '' };
      expect(problems(load(environment))).toEqual([['empty_value', name]]);
    },
  );

  it.each([
    ['1', 1],
    ['300', 300],
    ['500', 500],
    ['42', 42],
  ])('takes %j requests per minute', (value, number) => {
    const result = load({
      ...valid(),
      ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE: value,
    });
    expect(result.ok && result.config.churchtoolsRequestsPerMinute).toBe(
      number,
    );
    expect(setting(result, 'churchtoolsRequestsPerMinute')).toMatchObject({
      origin: 'environment',
      shown: { kind: 'integer', value: number },
    });
  });

  it('defaults to 300 requests per minute', () => {
    const result = load(valid());
    expect(result.ok && result.config.churchtoolsRequestsPerMinute).toBe(300);
    expect(setting(result, 'churchtoolsRequestsPerMinute')).toMatchObject({
      origin: 'default',
      shown: { kind: 'integer', value: 300 },
    });
  });

  it.each([
    '0',
    '501',
    '030',
    '3e2',
    ' 30',
    '30 ',
    '-1',
    '+1',
    '1.5',
    'abc',
    '999',
  ])('refuses %j requests per minute without showing the value', (value) => {
    const result = load({
      ...valid(),
      ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE: value,
    });
    expect(problems(result)).toEqual([
      ['invalid_integer', 'ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE'],
    ]);
    expect(setting(result, 'churchtoolsRequestsPerMinute')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  it.each(['1000', '0300', ' 300', '300 '])(
    'refuses %j requests per minute as too long',
    (value) => {
      expect(
        problems(
          load({ ...valid(), ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE: value }),
        ),
      ).toEqual([
        ['value_too_long', 'ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE'],
      ]);
    },
  );

  it.each([
    ['ECCLIUM_REDACTION', ['Standard', 'STANDARD', 'Off', 'off ', 'none']],
    ['ECCLIUM_LOG_LEVEL', ['DEBUG', 'trace', 'Info', 'warn ', 'all']],
  ])('refuses each wrong choice for %s', (name, values) => {
    for (const value of values) {
      expect(problems(load({ ...valid(), [name]: value })), value).toEqual([
        ['invalid_choice', name],
      ]);
    }
  });

  // The length is checked first, so no pattern runs on a huge value and
  // the statics of regular expressions keep what they held.
  it('refuses a huge value in every variable before any pattern', () => {
    const huge = 'x'.repeat(1_000_000);
    const environment = Object.fromEntries(
      variableNames.map((name) => [name, huge]),
    );
    expect(/primed/.exec('primed')).not.toBeNull();
    const result = load(environment);
    expect((RegExp as unknown as Record<string, unknown>).input).toBe('primed');
    for (const name of variableNames) {
      expect(problems(result), name).toContainEqual(['value_too_long', name]);
    }
  });

  it.each([
    ['ECCLIUM_STDIO_SUBJECT', 'a'.repeat(32), 'a'.repeat(33)],
    [
      'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
      `/${'a'.repeat(4095)}`,
      `/${'a'.repeat(4096)}`,
    ],
  ])('takes %s at its bound and refuses one more', (name, longest, tooLong) => {
    expect(load({ ...valid(), [name]: longest }).ok).toBe(true);
    expect(problems(load({ ...valid(), [name]: tooLong }))).toEqual([
      ['value_too_long', name],
    ]);
  });

  it.each([
    'max.mustermann@example.org',
    'Max',
    'local stdio',
    'a.b',
    '-abc',
    '1abc',
    'a_b',
    'local\0x',
  ])('refuses the subject %j', (subject) => {
    expect(
      problems(load({ ...valid(), ECCLIUM_STDIO_SUBJECT: subject })),
    ).toEqual([['subject_invalid', 'ECCLIUM_STDIO_SUBJECT']]);
  });

  it('refuses the placeholder of the audit as subject', () => {
    expect(
      problems(load({ ...valid(), ECCLIUM_STDIO_SUBJECT: 'invalid' })),
    ).toEqual([['subject_reserved', 'ECCLIUM_STDIO_SUBJECT']]);
  });
});

describe('loadConfig and the address', () => {
  it('refuses a missing address and an empty one apart', () => {
    expect(
      problems(load({ ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath })),
    ).toEqual([['url_missing', 'ECCLIUM_CHURCHTOOLS_URL']]);
    expect(problems(load({ ...valid(), ECCLIUM_CHURCHTOOLS_URL: '' }))).toEqual(
      [['empty_value', 'ECCLIUM_CHURCHTOOLS_URL']],
    );
  });

  it.each([
    ['url_too_long', `https://${'a'.repeat(300)}.example`],
    ['url_invalid', 'demo.example'],
    ['url_not_https', 'http://demo.example'],
    ['url_credentials', 'https://user@demo.example'],
    ['url_path', 'https://demo.example/api'],
    ['url_ip_address', 'https://192.0.2.1'],
    ['url_trailing_dot', 'https://demo.example.'],
    ['url_localhost', 'https://demo.localhost'],
    ['url_single_label', 'https://intranet'],
    ['url_host', 'https://my_host.example'],
    ['url_port', 'https://demo.example:0'],
    ['url_not_canonical', 'https://DEMO.example'],
    ['url_not_canonical', ' https://demo.example'],
  ])('passes on %s for %j', (code, value) => {
    const result = load({ ...valid(), ECCLIUM_CHURCHTOOLS_URL: value });
    expect(problems(result)).toEqual([[code, 'ECCLIUM_CHURCHTOOLS_URL']]);
    expect(setting(result, 'churchtoolsOrigin')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  it('shows no part of the credentials of an address', () => {
    const [user = '', password = ''] = makeCanary('email').cores;
    const result = load({
      ...valid(),
      ECCLIUM_CHURCHTOOLS_URL: `https://${user}:${password}@demo.example`,
    });
    expect(codes(result)).toEqual(['url_credentials']);
    expect(JSON.stringify(result)).not.toContain(user);
    expect(JSON.stringify(result)).not.toContain(password);
  });
});

describe('loadConfig and the token', () => {
  it('refuses a configuration without a token', () => {
    const result = load({ ECCLIUM_CHURCHTOOLS_URL: address });
    expect(problems(result)).toEqual([
      ['token_missing', 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE'],
    ]);
    expect(setting(result, 'churchtoolsToken')).toMatchObject({
      variable: 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
      origin: 'missing',
      shown: { kind: 'none' },
    });
  });

  it('refuses a file and an environment token together without opening the file', () => {
    const files = memoryFiles();
    const result = load(
      { ...valid(), [tokenVariableName]: token() },
      'stdio',
      files.fs,
    );
    expect(problems(result)).toEqual([['token_conflict', tokenVariableName]]);
    expect(files.opened).toEqual([]);
    expect(setting(result, 'churchtoolsToken')?.origin).toBe('invalid');
  });

  it('refuses an environment token over http, alone and with a file', () => {
    expect(
      problems(
        load(
          { ECCLIUM_CHURCHTOOLS_URL: address, [tokenVariableName]: token() },
          'http',
        ),
      ),
    ).toEqual([['stdio_only', tokenVariableName]]);
    expect(
      problems(load({ ...valid(), [tokenVariableName]: token() }, 'http')),
    ).toEqual([
      ['stdio_only', tokenVariableName],
      ['token_conflict', tokenVariableName],
    ]);
  });

  it.each([
    ['a space', 'tok en'],
    ['the placeholder', 'xREDACTEDx'],
  ])('refuses an environment token with %s', (_, value) => {
    expect(
      problems(
        load({ ECCLIUM_CHURCHTOOLS_URL: address, [tokenVariableName]: value }),
      ),
    ).toEqual([['token_invalid', tokenVariableName]]);
  });

  it('refuses an environment token longer than a Secret takes by its length', () => {
    expect(
      problems(
        load({
          ECCLIUM_CHURCHTOOLS_URL: address,
          [tokenVariableName]: 'a'.repeat(4097),
        }),
      ),
    ).toEqual([['value_too_long', tokenVariableName]]);
  });

  it('reports only the empty environment token next to a good file', () => {
    expect(problems(load({ ...valid(), [tokenVariableName]: '' }))).toEqual([
      ['empty_value', tokenVariableName],
    ]);
  });

  it.each(['~/token', './token', 'token'])(
    'refuses the relative path %j of the token file',
    (path) => {
      expect(
        problems(load({ ...valid(), ECCLIUM_CHURCHTOOLS_TOKEN_FILE: path })),
      ).toEqual([['token_file_relative', 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE']]);
    },
  );

  it('refuses a path with NUL as unsafe, on the real file functions', () => {
    const canary = makeCanary('email').cores[0] ?? '';
    const result = loadConfig({
      environment: {
        ...valid(),
        ECCLIUM_CHURCHTOOLS_TOKEN_FILE: `/abs\0${canary}`,
      },
      transport: 'stdio',
    });
    expect(problems(result)).toEqual([
      ['token_file_unsafe', 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE'],
    ]);
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  // A typo in the name of the file variable leaves the environment token,
  // which then counts with a warning: the conflict check cannot see it.
  it('uses the environment token when the file variable has a typo', () => {
    const result = load({
      ECCLIUM_CHURCHTOOLS_URL: address,
      ECLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
      [tokenVariableName]: token(),
    });
    expect(result.ok && result.config.tokenSource).toBe('environment');
    expect(result.report.warnings).toEqual(['token_from_environment']);
  });
});

describe('loadConfig and refused settings', () => {
  it.each(['https://proxy.example:3128', ''])(
    'refuses the proxy variable set to %j',
    (value) => {
      expect(
        problems(load({ ...valid(), ECCLIUM_EGRESS_PROXY: value })),
      ).toEqual([['proxy_unsupported', 'ECCLIUM_EGRESS_PROXY']]);
      expect(
        problems(load({ ...valid(), ecclium_egress_proxy: value })),
      ).toEqual([['proxy_unsupported', 'ECCLIUM_EGRESS_PROXY']]);
    },
  );

  it.each(['stdio', 'http'] as const)(
    'refuses strict redaction over %s',
    (transport) => {
      expect(
        problems(load({ ...valid(), ECCLIUM_REDACTION: 'strict' }, transport)),
      ).toEqual([['redaction_strict_unsupported', 'ECCLIUM_REDACTION']]);
    },
  );

  it('allows redaction off over stdio only, with a warning', () => {
    const overHttp = load({ ...valid(), ECCLIUM_REDACTION: 'off' }, 'http');
    expect(problems(overHttp)).toEqual([['stdio_only', 'ECCLIUM_REDACTION']]);
    expect(overHttp.report.warnings).toEqual([]);
    const overStdio = load({ ...valid(), ECCLIUM_REDACTION: 'off' });
    expect(overStdio.ok).toBe(true);
    expect(overStdio.report.warnings).toEqual(['redaction_off']);
  });

  it('refuses a subject over http', () => {
    expect(
      problems(
        load({ ...valid(), ECCLIUM_STDIO_SUBJECT: 'local-stdio' }, 'http'),
      ),
    ).toEqual([['stdio_only', 'ECCLIUM_STDIO_SUBJECT']]);
  });

  it('refuses NODE_TLS_REJECT_UNAUTHORIZED=0 and nothing else of it', () => {
    expect(
      problems(load({ ...valid(), NODE_TLS_REJECT_UNAUTHORIZED: '0' })),
    ).toEqual([['tls_check_disabled', 'NODE_TLS_REJECT_UNAUTHORIZED']]);
    for (const value of ['1', '', 'false']) {
      expect(
        load({ ...valid(), NODE_TLS_REJECT_UNAUTHORIZED: value }).ok,
        value,
      ).toBe(true);
    }
  });

  // Windows reads the name without regard to case, so every spelling
  // counts, also where it has no effect.
  it.each(['node_tls_reject_unauthorized', 'Node_Tls_Reject_Unauthorized'])(
    'refuses %s=0 as well',
    (name) => {
      expect(problems(load({ ...valid(), [name]: '0' }))).toEqual([
        ['tls_check_disabled', 'NODE_TLS_REJECT_UNAUTHORIZED'],
      ]);
      expect(load({ ...valid(), [name]: '1' }).ok).toBe(true);
    },
  );

  // Every section of NODE_DEBUG writes past the logger to stderr: undici
  // the address, path and query of each request, stream the bytes of
  // answers and of the input over stdio, net the host. Any pattern with
  // more than blanks counts, also one that names no section today.
  it.each([
    'undici',
    'fetch',
    'websocket',
    'UNDICI',
    'stream',
    'STREAM',
    'str*',
    'net',
    'net,stream',
    'http,tls',
    'http, fetch ',
    '*',
    ',x',
    ' module ',
    'unknown-section',
  ])('refuses NODE_DEBUG=%j', (value) => {
    expect(problems(load({ ...valid(), NODE_DEBUG: value }))).toEqual([
      ['debug_output_enabled', 'NODE_DEBUG'],
    ]);
  });

  it.each(['', ' ', ',', ' , ', '\t'])('accepts NODE_DEBUG=%j', (value) => {
    expect(load({ ...valid(), NODE_DEBUG: value }).ok).toBe(true);
  });

  it.each(['node_debug', 'Node_Debug'])('refuses %s=net as well', (name) => {
    expect(problems(load({ ...valid(), [name]: 'net' }))).toEqual([
      ['debug_output_enabled', 'NODE_DEBUG'],
    ]);
    expect(load({ ...valid(), [name]: ',' }).ok).toBe(true);
  });

  it('reports warnings also when the load fails', () => {
    const result = load({
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
      ECCLIUM_REDACTION: 'off',
    });
    expect(result.ok).toBe(false);
    expect(result.report.warnings).toEqual(['redaction_off']);
  });
});

describe('loadConfig and the settings of Node.js for TLS', () => {
  const certificate = '/path/to/ca.pem';
  const tab = String.fromCodePoint(0x09);

  // Every spelling counts, as for NODE_TLS_REJECT_UNAUTHORIZED.
  it.each(
    trustStoreVariableNames.flatMap((name) => [
      name,
      name.toLowerCase(),
      `${name.charAt(0)}${name.slice(1).toLowerCase()}`,
    ]),
  )('warns when %s extends the trust store', (name) => {
    const value =
      name.toUpperCase() === 'NODE_USE_SYSTEM_CA' ? '1' : certificate;
    const result = load({ ...valid(), [name]: value });
    expect(result.ok).toBe(true);
    expect(result.report.problems).toEqual([]);
    expect(result.report.warnings).toEqual(['trust_store_extended']);
  });

  // Node.js documents only 1, but a later release may take more.
  it.each(['0', 'true', ' '])('warns for NODE_USE_SYSTEM_CA=%j', (value) => {
    expect(
      load({ ...valid(), NODE_USE_SYSTEM_CA: value }).report.warnings,
    ).toEqual(['trust_store_extended']);
  });

  it.each(trustStoreVariableNames)('does not warn for an empty %s', (name) => {
    const result = load({ ...valid(), [name]: '' });
    expect(result.ok).toBe(true);
    expect(result.report.warnings).toEqual([]);
  });

  it('warns once for several settings, after the other warnings', () => {
    const result = load(
      {
        ...valid(),
        ECCLIUM_REDACTION: 'off',
        NODE_EXTRA_CA_CERTS: certificate,
        SSL_CERT_DIR: '/path/to/certs',
        NODE_OPTIONS: '--use-openssl-ca',
      },
      'stdio',
      memoryFiles().fs,
      ['--use-system-ca'],
    );
    expect(result.report.warnings).toEqual([
      'redaction_off',
      'trust_store_extended',
    ]);
  });

  // Node.js reads an option also with underscores, and in NODE_OPTIONS a
  // double quote anywhere opens or closes a quoted part.
  it.each([
    ['--use-system-ca'],
    ['--use_system_ca'],
    ['--use-openssl-ca'],
    ['--use_openssl-ca'],
    ['--conditions=@ecclium/source', '--use-system-ca'],
  ])('warns for the options of the start %j', (...execArgv) => {
    const result = started(execArgv);
    expect(result.ok).toBe(true);
    expect(result.report.warnings).toEqual(['trust_store_extended']);
  });

  it.each([
    '--use-system-ca',
    '--use_system_ca',
    '--use-openssl-ca',
    '--max-old-space-size=100 --use_openssl_ca',
    '  --use-system-ca  ',
    '"--use-system-ca"',
    '--use"-"system-ca',
    '"--use-sys\\tem-ca"',
  ])('warns for NODE_OPTIONS=%j', (value) => {
    for (const name of ['NODE_OPTIONS', 'node_options']) {
      const result = load({ ...valid(), [name]: value });
      expect(result.ok, name).toBe(true);
      expect(result.report.warnings, name).toEqual(['trust_store_extended']);
    }
  });

  // Node.js refuses each of these or does not read it as the option.
  it.each([
    ['--no-use-system-ca'],
    ['--use-bundled-ca'],
    ['--USE-SYSTEM-CA'],
    ['-use-system-ca'],
    ['--use-system-cax'],
    ['--title=--use-system-ca'],
    ['--import', 'use-system-ca'],
  ])('does not warn for the options of the start %j', (...execArgv) => {
    expect(started(execArgv).report.warnings).toEqual([]);
  });

  // Quotes keep a space inside one option, and only a space separates
  // options: Node.js reads what follows a tab as part of the same option.
  it.each([
    '--title="a --use-system-ca"',
    '"--title=a --use-system-ca"',
    `${tab}--use-system-ca`,
    `--title=a${tab}--use-system-ca`,
    '--no-use-system-ca',
  ])('does not warn for NODE_OPTIONS=%j', (value) => {
    expect(load({ ...valid(), NODE_OPTIONS: value }).report.warnings).toEqual(
      [],
    );
  });

  it.each([
    [['--tls-keylog=/path/to/keys'], 'tls_keylog_enabled'],
    [['--tls_keylog', '/path/to/keys'], 'tls_keylog_enabled'],
    [['--trace-tls'], 'tls_trace_enabled'],
    [['--trace_tls'], 'tls_trace_enabled'],
  ])('refuses the options of the start %j without a name', (execArgv, code) => {
    expect(problems(started(execArgv))).toEqual([[code]]);
  });

  it.each([
    ['--tls-keylog=/path/to/keys', 'tls_keylog_enabled'],
    ['--tls_keylog "/path/to/a file"', 'tls_keylog_enabled'],
    ['--max-old-space-size=100 --trace-tls', 'tls_trace_enabled'],
    ['"--trace_tls"', 'tls_trace_enabled'],
  ])('refuses NODE_OPTIONS=%j and names it', (value, code) => {
    expect(problems(load({ ...valid(), node_options: value }))).toEqual([
      [code, 'NODE_OPTIONS'],
    ]);
  });

  it('reports each option of TLS once per place, in a fixed order', () => {
    const result = load(
      {
        ...valid(),
        NODE_OPTIONS: '--trace-tls --tls-keylog=/path/to/keys',
        node_options: '--tls-keylog=/path/to/keys',
        NODE_DEBUG: 'tls',
      },
      'stdio',
      memoryFiles().fs,
      ['--trace-tls', '--tls-keylog', '/path/to/keys', '--trace-tls'],
    );
    expect(problems(result)).toEqual([
      ['debug_output_enabled', 'NODE_DEBUG'],
      ['tls_keylog_enabled'],
      ['tls_keylog_enabled', 'NODE_OPTIONS'],
      ['tls_trace_enabled'],
      ['tls_trace_enabled', 'NODE_OPTIONS'],
    ]);
  });

  it('takes the options of the start frozen and never changes them', () => {
    const execArgv = Object.freeze(['--use-system-ca']);
    expect(started(execArgv).report.warnings).toEqual(['trust_store_extended']);
    expect(execArgv).toEqual(['--use-system-ca']);
  });

  it('refuses options of the start that are no plain array of strings', () => {
    const getter = vi.fn(() => '--trace-tls');
    const withGetter = Object.defineProperty(['--use-system-ca'], '1', {
      get: getter,
      enumerable: true,
    });
    const { proxy, revoke } = Proxy.revocable(['--trace-tls'], {});
    revoke();
    const holey: string[] = [];
    holey[1] = '--trace-tls';
    for (const execArgv of [
      withGetter,
      new Proxy(['--trace-tls'], {}),
      proxy,
      holey,
      ['--trace-tls', 1],
      '--trace-tls',
      { 0: '--trace-tls', length: 1 },
      null,
    ]) {
      expect(() => started(execArgv as unknown as readonly string[])).toThrow(
        new TypeError(invalidSources),
      );
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('refuses a getter on a variable of Node.js without calling it', () => {
    const getter = vi.fn(() => '--trace-tls');
    const environment = Object.defineProperty(valid(), 'NODE_OPTIONS', {
      get: getter,
      enumerable: true,
    });
    expect(() => load(environment)).toThrow(invalidSources);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('loadConfig and the retention of the audit files', () => {
  const retained = (value: string, stateDir = true): ConfigResult =>
    load(
      {
        ...valid(),
        ...(stateDir ? { ECCLIUM_STATE_DIR: stateDirPath } : {}),
        ECCLIUM_AUDIT_RETENTION_MONTHS: value,
      },
      'stdio',
      memoryFiles().fs,
      undefined,
      memoryFolder().fs,
    );

  it('keeps the files twelve months by default, without a warning', () => {
    const result = withStateDir(stateDirPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.auditRetentionMonths).toBe(12);
    expect(result.report.warnings).toEqual([]);
    expect(setting(result, 'auditRetentionMonths')).toEqual({
      key: 'auditRetentionMonths',
      variable: 'ECCLIUM_AUDIT_RETENTION_MONTHS',
      origin: 'default',
      shown: { kind: 'integer', value: 12 },
    });
  });

  it.each([
    ['1', 1],
    ['12', 12],
    ['13', 13],
    ['120', 120],
  ])('takes %s months', (value, months) => {
    const result = retained(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.auditRetentionMonths).toBe(months);
    expect(setting(result, 'auditRetentionMonths')?.origin).toBe('environment');
  });

  it.each([
    '0',
    '121',
    '012',
    '1e2',
    '+12',
    '-1',
    ' 12',
    '12 ',
    '1.5',
    'zwölf',
  ])('refuses %j without naming it', (value) => {
    const result = retained(value);
    expect(result.ok).toBe(false);
    expect(problems(result)).toEqual(
      value.length > 3
        ? [['value_too_long', 'ECCLIUM_AUDIT_RETENTION_MONTHS']]
        : [['invalid_retention', 'ECCLIUM_AUDIT_RETENTION_MONTHS']],
    );
    expect(setting(result, 'auditRetentionMonths')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
    // A refused value is never in the report, not even as a string.
    expect(JSON.stringify(result.report)).not.toContain(JSON.stringify(value));
  });

  it('warns below twelve months with the folder of state, and not from twelve', () => {
    expect(retained('11').report.warnings).toEqual(['audit_retention_short']);
    expect(retained('1').report.warnings).toEqual(['audit_retention_short']);
    expect(retained('12').report.warnings).toEqual([]);
  });

  it('says that the variable does nothing without the folder of state', () => {
    expect(retained('6', false).report.warnings).toEqual([
      'audit_retention_without_state_dir',
    ]);
    expect(retained('12', false).report.warnings).toEqual([
      'audit_retention_without_state_dir',
    ]);
    expect(retained('6', false).ok).toBe(true);
    expect(load(valid()).report.warnings).toEqual([]);
  });

  it('warns about no folder of state only for a valid value over stdio', () => {
    for (const value of ['', '0', '1234']) {
      const result = retained(value, false);
      expect(result.ok, value).toBe(false);
      expect(result.report.warnings, value).toEqual([]);
    }
    const overHttp = load(
      { ...valid(), ECCLIUM_AUDIT_RETENTION_MONTHS: '6' },
      'http',
    );
    expect(overHttp.report.warnings).toEqual([]);
  });

  it('refuses the variable over HTTP', () => {
    const result = load(
      { ...valid(), ECCLIUM_AUDIT_RETENTION_MONTHS: '12' },
      'http',
    );
    expect(problems(result)).toEqual([
      ['stdio_only', 'ECCLIUM_AUDIT_RETENTION_MONTHS'],
    ]);
  });
});

describe('loadConfig and its problems', () => {
  const withAddress = (value: string): ConfigResult =>
    load({ ...valid(), ECCLIUM_CHURCHTOOLS_URL: value });

  /** One case per code. */
  const cases: Record<
    ConfigProblemCode | ConfigWarningCode,
    () => ConfigResult
  > = {
    unknown_variable: () => load({ ...valid(), ECCLIUM_REDONLY: 'true' }),
    miscased_variable: () => load({ ...valid(), ecclium_read_only: 'true' }),
    unsupported_variable: () => load({ ...valid(), ECCLIUM_EGRESS: 'x' }),
    proxy_unsupported: () => load({ ...valid(), ECCLIUM_EGRESS_PROXY: 'x' }),
    search_tools_replaced: () =>
      load({ ...valid(), ECCLIUM_SEARCH_TOOLS: 'true' }),
    tls_check_disabled: () =>
      load({ ...valid(), NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    debug_output_enabled: () => load({ ...valid(), NODE_DEBUG: 'undici' }),
    tls_keylog_enabled: () => started(['--tls-keylog=/path/to/keys']),
    tls_trace_enabled: () => load({ ...valid(), NODE_OPTIONS: '--trace-tls' }),
    empty_value: () => load({ ...valid(), ECCLIUM_READ_ONLY: '' }),
    invalid_toolsets: () => load({ ...valid(), ECCLIUM_TOOLSETS: 'groups' }),
    value_too_long: () => load({ ...valid(), ECCLIUM_READ_ONLY: 'xxxxxx' }),
    invalid_choice: () => load({ ...valid(), ECCLIUM_READ_ONLY: 'yes' }),
    invalid_integer: () =>
      load({ ...valid(), ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE: '0' }),
    invalid_retention: () =>
      load({ ...valid(), ECCLIUM_AUDIT_RETENTION_MONTHS: '121' }),
    url_missing: () => load({ ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath }),
    url_too_long: () => withAddress(`https://${'a'.repeat(300)}.example`),
    url_invalid: () => withAddress('demo.example'),
    url_not_https: () => withAddress('http://demo.example'),
    url_credentials: () => withAddress('https://user@demo.example'),
    url_path: () => withAddress('https://demo.example/api'),
    url_ip_address: () => withAddress('https://192.0.2.1'),
    url_trailing_dot: () => withAddress('https://demo.example.'),
    url_localhost: () => withAddress('https://localhost'),
    url_single_label: () => withAddress('https://intranet'),
    url_host: () => withAddress('https://my_host.example'),
    url_port: () => withAddress('https://demo.example:0'),
    url_not_canonical: () => withAddress('https://DEMO.example'),
    token_missing: () => load({ ECCLIUM_CHURCHTOOLS_URL: address }),
    token_conflict: () => load({ ...valid(), [tokenVariableName]: token() }),
    token_file_relative: () =>
      load({ ...valid(), ECCLIUM_CHURCHTOOLS_TOKEN_FILE: 'token-file' }),
    token_file_platform: () =>
      load(
        valid(),
        'stdio',
        memoryFiles(undefined, { getuid: () => undefined }).fs,
      ),
    token_file_missing: () => load(valid(), 'stdio', failingOpen('ENOENT')),
    token_file_symlink: () => load(valid(), 'stdio', failingOpen('ELOOP')),
    token_file_unreadable: () => load(valid(), 'stdio', failingOpen('EACCES')),
    token_file_not_regular: () =>
      load(
        valid(),
        'stdio',
        memoryFiles(undefined, { stats: { isFile: false } }).fs,
      ),
    token_file_owner: () =>
      load(valid(), 'stdio', memoryFiles(undefined, { stats: { uid: 0 } }).fs),
    token_file_mode: () =>
      load(
        valid(),
        'stdio',
        memoryFiles(undefined, { stats: { mode: 0o100644 } }).fs,
      ),
    token_file_too_large: () =>
      load(valid(), 'stdio', memoryFiles('a'.repeat(5000)).fs),
    token_file_empty: () => load(valid(), 'stdio', memoryFiles('\n').fs),
    token_file_bom: () =>
      load(valid(), 'stdio', memoryFiles('\xef\xbb\xbfabc\n').fs),
    token_file_characters: () =>
      load(valid(), 'stdio', memoryFiles('a b\n').fs),
    token_file_unsafe: () => load(valid(), 'stdio', failingOpen('ENOTDIR')),
    token_invalid: () =>
      load(valid(), 'stdio', memoryFiles('xxREDACTEDxx\n').fs),
    redaction_strict_unsupported: () =>
      load({ ...valid(), ECCLIUM_REDACTION: 'strict' }),
    stdio_only: () => load({ ...valid(), ECCLIUM_REDACTION: 'off' }, 'http'),
    subject_invalid: () => load({ ...valid(), ECCLIUM_STDIO_SUBJECT: 'Local' }),
    subject_reserved: () =>
      load({ ...valid(), ECCLIUM_STDIO_SUBJECT: 'invalid' }),
    state_dir_relative: () => withStateDir('path/to/state'),
    state_dir_too_long: () => withStateDir(`/${'\u00e4'.repeat(500)}`),
    state_dir_not_normalized: () => withStateDir(`${stateDirPath}/`),
    state_dir_platform: () =>
      withStateDir(stateDirPath, memoryFolder({ getuid: () => undefined }).fs),
    state_dir_missing: () =>
      withStateDir(
        stateDirPath,
        memoryFolder({ folder: { error: 'ENOENT' } }).fs,
      ),
    state_dir_symlink: () =>
      withStateDir(
        stateDirPath,
        memoryFolder({ folder: { symlink: true } }).fs,
      ),
    state_dir_not_directory: () =>
      withStateDir(
        stateDirPath,
        memoryFolder({ folder: { directory: false } }).fs,
      ),
    state_dir_owner: () =>
      withStateDir(stateDirPath, memoryFolder({ folder: { uid: 0 } }).fs),
    state_dir_mode: () =>
      withStateDir(
        stateDirPath,
        memoryFolder({ folder: { mode: 0o40750 } }).fs,
      ),
    state_dir_unsafe: () =>
      withStateDir(
        stateDirPath,
        memoryFolder({ folder: { error: 'EACCES' } }).fs,
      ),
    audit_dir_symlink: () =>
      withStateDir(stateDirPath, memoryFolder({ audit: { symlink: true } }).fs),
    audit_dir_not_directory: () =>
      withStateDir(
        stateDirPath,
        memoryFolder({ audit: { directory: false } }).fs,
      ),
    audit_dir_owner: () =>
      withStateDir(stateDirPath, memoryFolder({ audit: { uid: 0 } }).fs),
    audit_dir_mode: () =>
      withStateDir(stateDirPath, memoryFolder({ audit: { mode: 0o40701 } }).fs),
    audit_dir_unsafe: () =>
      withStateDir(stateDirPath, memoryFolder({ audit: { error: 'EIO' } }).fs),
    quota_dir_symlink: () =>
      withStateDir(stateDirPath, memoryFolder({ quota: { symlink: true } }).fs),
    quota_dir_not_directory: () =>
      withStateDir(
        stateDirPath,
        memoryFolder({ quota: { directory: false } }).fs,
      ),
    quota_dir_owner: () =>
      withStateDir(stateDirPath, memoryFolder({ quota: { uid: 0 } }).fs),
    quota_dir_mode: () =>
      withStateDir(stateDirPath, memoryFolder({ quota: { mode: 0o40701 } }).fs),
    quota_dir_unsafe: () =>
      withStateDir(stateDirPath, memoryFolder({ quota: { error: 'EIO' } }).fs),
    token_from_environment: () =>
      load({ ECCLIUM_CHURCHTOOLS_URL: address, [tokenVariableName]: token() }),
    redaction_off: () => load({ ...valid(), ECCLIUM_REDACTION: 'off' }),
    toolsets_without_state_dir: () =>
      load({ ...valid(), ECCLIUM_TOOLSETS: 'persons' }),
    // Only the loader of the commands that read the audit files reports it.
    state_dir_required: () => {
      const loaded = loadAuditConfig({ environment: {} });
      return {
        ok: false,
        report: {
          transport: 'stdio',
          settings: [],
          problems: loaded.ok ? [] : loaded.problems,
          omittedProblems: 0,
          warnings: [],
        },
      };
    },
    persons_toolset_enabled: () =>
      load(
        {
          ...valid(),
          ECCLIUM_TOOLSETS: 'persons',
          ECCLIUM_STATE_DIR: stateDirPath,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      ),
    events_toolset_enabled: () =>
      load(
        {
          ...valid(),
          ECCLIUM_TOOLSETS: 'events',
          ECCLIUM_STATE_DIR: stateDirPath,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      ),
    api_toolset_enabled: () =>
      load(
        {
          ...valid(),
          ECCLIUM_TOOLSETS: 'api',
          ECCLIUM_STATE_DIR: stateDirPath,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      ),
    trust_store_extended: () =>
      load({ ...valid(), NODE_EXTRA_CA_CERTS: '/path/to/ca.pem' }),
    audit_retention_short: () =>
      load(
        {
          ...valid(),
          ECCLIUM_STATE_DIR: stateDirPath,
          ECCLIUM_AUDIT_RETENTION_MONTHS: '6',
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      ),
    audit_retention_without_state_dir: () =>
      load({ ...valid(), ECCLIUM_AUDIT_RETENTION_MONTHS: '24' }),
  };

  it.each([...configProblemCodes])('can report the problem %s', (code) => {
    expect(codes(cases[code]())).toEqual([code]);
    expect(isEventName(`config_${code}`)).toBe(true);
  });

  it.each([...configWarningCodes])('can report the warning %s', (code) => {
    const result = cases[code]();
    expect(result.ok).toBe(true);
    expect(result.report.warnings).toEqual([code]);
  });

  // The tools of persons and events name persons and need the folder of
  // the audit file over stdio (ADR 0028, ADR 0060, ADR 0064). A folder that
  // is set but refused reports only its own problem, and the toolsets alone
  // stay a valid value.
  it('asks for the folder of state only when persons, events or api is on and it is unset', () => {
    for (const value of [
      'persons',
      'wiki,persons',
      'events',
      'events,wiki',
      'api',
      'docs,api',
      'all',
      'all,api',
    ]) {
      const missing = load({ ...valid(), ECCLIUM_TOOLSETS: value });
      expect(missing.ok, value).toBe(false);
      expect(missing.report.problems, value).toEqual([
        { code: 'toolsets_without_state_dir', variable: 'ECCLIUM_STATE_DIR' },
      ]);
      expect(setting(missing, 'toolsets')?.origin, value).toBe('environment');
    }
    expect(
      codes(
        load(
          {
            ...valid(),
            ECCLIUM_TOOLSETS: 'persons',
            ECCLIUM_STATE_DIR: stateDirPath,
          },
          'stdio',
          memoryFiles().fs,
          undefined,
          memoryFolder({ folder: { mode: 0o40750 } }).fs,
        ),
      ),
    ).toEqual(['state_dir_mode']);
    for (const value of ['', 'wiki', 'calendars,wiki,songs', 'docs']) {
      expect(load({ ...valid(), ECCLIUM_TOOLSETS: value }).ok, value).toBe(
        true,
      );
    }
  });

  // Unlike any other variable, an empty value means no toolset, as when
  // the variable is not set (ADR 0062).
  it('takes an empty list of toolsets as none, from the environment', () => {
    const result = load({ ...valid(), ECCLIUM_TOOLSETS: '' });
    expect(result.ok && result.config.toolsets).toEqual([]);
    expect(setting(result, 'toolsets')).toEqual({
      key: 'toolsets',
      variable: 'ECCLIUM_TOOLSETS',
      origin: 'environment',
      shown: { kind: 'list', values: [] },
    });
    expect(result.report.warnings).toEqual([]);
  });

  // all leaves out api, and all,api names every toolset, with the warning
  // of the escape hatch (ADR 0067).
  it('turns on api only when named, with its warning', () => {
    const start = (value: string) =>
      load(
        {
          ...valid(),
          ECCLIUM_TOOLSETS: value,
          ECCLIUM_STATE_DIR: stateDirPath,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      );
    const all = start('all');
    expect(all.ok && all.config.toolsets).not.toContain('api');
    expect(all.report.warnings).not.toContain('api_toolset_enabled');
    const both = start('all,api');
    expect(both.ok && both.config.toolsets).toEqual([
      'persons',
      'events',
      'calendars',
      'wiki',
      'songs',
      'docs',
      'api',
    ]);
    expect(both.report.warnings).toEqual([
      'persons_toolset_enabled',
      'events_toolset_enabled',
      'api_toolset_enabled',
    ]);
  });

  it('turns on every toolset but api with all and shows their names', () => {
    const result = load(
      { ...valid(), ECCLIUM_TOOLSETS: 'all', ECCLIUM_STATE_DIR: stateDirPath },
      'stdio',
      memoryFiles().fs,
      undefined,
      memoryFolder().fs,
    );
    const names = ['persons', 'events', 'calendars', 'wiki', 'songs', 'docs'];
    expect(result.ok && result.config.toolsets).toEqual(names);
    expect(setting(result, 'toolsets')?.shown).toEqual({
      kind: 'list',
      values: names,
    });
  });

  it.each([
    'Persons',
    'persons,',
    'persons, wiki',
    'persons,persons',
    'all,wiki',
    'groups',
    'true',
    'persons,events,calendars,wiki,songs,x',
    'persons,events,calendars,wiki,songs,docs,x',
  ])('refuses the toolsets %j and shows no value', (value) => {
    const result = load({ ...valid(), ECCLIUM_TOOLSETS: value });
    expect(problems(result)).toEqual([
      [
        value.length >
        (variables.find(({ name }) => name === 'ECCLIUM_TOOLSETS')?.maxLength ??
          0)
          ? 'value_too_long'
          : 'invalid_toolsets',
        'ECCLIUM_TOOLSETS',
      ],
    ]);
    expect(setting(result, 'toolsets')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  // The switch of phase 1 gave the search tools; whoever still sets it
  // learns of the toolset that replaced it, whatever its value.
  it.each([
    ['ECCLIUM_SEARCH_TOOLS', 'true'],
    ['ECCLIUM_SEARCH_TOOLS', 'false'],
    ['ECCLIUM_SEARCH_TOOLS', ''],
    ['ecclium_search_tools', 'true'],
  ])('refuses %s=%j and points to the toolsets', (name, value) => {
    const result = load({ ...valid(), [name]: value });
    expect(problems(result)).toEqual([
      ['search_tools_replaced', 'ECCLIUM_SEARCH_TOOLS'],
    ]);
    expect(setting(result, 'toolsets')?.origin).toBe('default');
  });

  it('lists 32 problems in a fixed order and counts the rest', () => {
    const environment: Environment = {
      ECCLIUM_CHURCHTOOLS_URL: 'http://demo.example',
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
      ECCLIUM_WRITE_CONFIRMATION: 'x',
      ECCLIUM_SEARCH_TOOLS: 'x',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_DEBUG: 'undici',
      NODE_OPTIONS: '--trace-tls',
      ECCLIUM_EGRESS_PROXY: 'x',
    };
    for (let index = 0; index < 40; index += 1) {
      environment[`ECCLIUM_UNKNOWN_${String(index)}`] = 'x';
    }
    const result = load(environment, 'stdio', memoryFiles().fs, [
      '--tls-keylog=/path/to/keys',
    ]);
    expect(result.report.problems).toHaveLength(maxReportedProblems);
    expect(result.report.omittedProblems).toBe(48 - maxReportedProblems);
    expect(problems(result).slice(0, 9)).toEqual([
      ['url_not_https', 'ECCLIUM_CHURCHTOOLS_URL'],
      ['tls_check_disabled', 'NODE_TLS_REJECT_UNAUTHORIZED'],
      ['debug_output_enabled', 'NODE_DEBUG'],
      ['tls_keylog_enabled'],
      ['tls_trace_enabled', 'NODE_OPTIONS'],
      ['proxy_unsupported', 'ECCLIUM_EGRESS_PROXY'],
      ['unsupported_variable', 'ECCLIUM_WRITE_CONFIRMATION'],
      ['search_tools_replaced', 'ECCLIUM_SEARCH_TOOLS'],
      ['unknown_variable', 'ECCLIUM_UNKNOWN_0'],
    ]);
  });

  it('gives the same report whatever the order of the variables', () => {
    const entries = Object.entries({
      ...valid(),
      ECCLIUM_ZETA: 'x',
      ECCLIUM_ALPHA: 'x',
      ecclium_log_level: 'x',
      ECCLIUM_READ_ONLY: 'no',
    });
    const forward = load(Object.fromEntries(entries));
    const backward = load(Object.fromEntries([...entries].reverse()));
    expect(backward.report).toEqual(forward.report);
  });

  it('asks the schema of a variable whether its value fits', () => {
    const spy = vi.spyOn(variableSchemas.ECCLIUM_LOG_LEVEL, 'safeParse');
    try {
      expect(load({ ...valid(), ECCLIUM_LOG_LEVEL: 'warn' }).ok).toBe(true);
      expect(spy).toHaveBeenCalledWith('warn');
    } finally {
      spy.mockRestore();
    }
  });

  it('checks no value of a name that is wrong', () => {
    const result = load({ ...valid(), ecclium_read_only: token() });
    expect(problems(result)).toEqual([
      ['miscased_variable', 'ECCLIUM_READ_ONLY'],
    ]);
  });
});

describe('loadConfig and what it gives out', () => {
  it('holds no value given, wherever a canary is planted', () => {
    const canaries = makeCanaries();
    const value = canaries.token.value;
    const variants: [Environment, TokenFileSystem][] = [
      [{ [tokenVariableName]: value }, memoryFiles().fs],
      [{}, failingOpen('ENOENT')],
    ];
    for (const [extra, files] of variants) {
      const input: Environment = {
        ...extra,
        ECCLIUM_CHURCHTOOLS_URL: `https://${value}@demo.example`,
        ECCLIUM_CHURCHTOOLS_TOKEN_FILE: `/${canaries.name.value}/${value}`,
        ECCLIUM_READ_ONLY: canaries.email.value,
        ECCLIUM_REDACTION: canaries.phone.value,
        ECCLIUM_SEARCH_TOOLS: value,
        ECCLIUM_STDIO_SUBJECT: canaries.name.value,
        ECCLIUM_LOG_LEVEL: value,
        [`ECCLIUM_${value}`]: value,
        ecclium_redaction: value,
        ECCLIUM_TOOLSETS: value,
        ECCLIUM_EGRESS_PROXY: value,
        NODE_TLS_REJECT_UNAUTHORIZED: value,
        NODE_DEBUG: `undici,${value}`,
        NODE_EXTRA_CA_CERTS: `/${canaries.name.value}/${value}.pem`,
        NODE_USE_SYSTEM_CA: value,
        SSL_CERT_FILE: `/${value}.pem`,
        SSL_CERT_DIR: `/${canaries.email.value}`,
        NODE_OPTIONS: `--tls-keylog=/${value} --${value} "${canaries.phone.value}"`,
      };
      // The path of a key log and of a certificate, and an unknown option.
      const execArgv = ['--tls_keylog', `/${value}`, `--${value}=${value}`];
      assertPlanted(input, canaries.all, 'environment');
      assertPlanted(execArgv, [canaries.token], 'options');
      const result = load(input, 'stdio', files, execArgv);
      expect(result.report.warnings).toContain('trust_store_extended');
      expect(codes(result)).toContain('tls_keylog_enabled');
      expect(result.ok).toBe(false);
      assertNoCanary(JSON.stringify(result), canaries.all, 'result as JSON');
      assertNoCanary(
        inspect(result, { depth: null, showHidden: true }),
        canaries.all,
        'result as inspected',
      );
    }
  });

  it('holds no Secret in the report and no config on failure', () => {
    const good = load(valid());
    expect(JSON.stringify(good.report)).not.toContain('REDACTED');
    const bad = load({ ECCLIUM_CHURCHTOOLS_URL: address });
    expect('config' in bad).toBe(false);
  });

  // A choice reaches zod only once it is an entry of the table, so the
  // subject is the one value of the loader on which zod fails. It stays
  // within its bound, so it gets past the check of the length.
  it('never lets zod report an error, which would see the value', () => {
    const spy = vi.fn(() => 'custom');
    const schema = vi.spyOn(variableSchemas.ECCLIUM_STDIO_SUBJECT, 'safeParse');
    try {
      z.config({ customError: spy });
      // The positive control: the spy fires once an error of this very
      // schema is read.
      expect(
        variableSchemas.ECCLIUM_STDIO_SUBJECT.safeParse('Max').error?.issues,
      ).toBeDefined();
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      schema.mockClear();
      const result = load({ ...valid(), ECCLIUM_STDIO_SUBJECT: 'Max' });
      expect(problems(result)).toEqual([
        ['subject_invalid', 'ECCLIUM_STDIO_SUBJECT'],
      ]);
      expect(schema).toHaveBeenCalledWith('Max');
      expect(schema.mock.results[0]?.value).toMatchObject({ success: false });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      z.config({ customError: undefined });
      schema.mockRestore();
    }
  });

  const deepFrozen = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null) return;
    expect(Object.isFrozen(value), path).toBe(true);
    if (value instanceof Secret) return;
    for (const [key, inner] of Object.entries(value)) {
      deepFrozen(inner, `${path}.${key}`);
    }
  };

  it.each([
    ['a good load', () => load(valid())],
    [
      'a failed load',
      () => load({ ECCLIUM_REDACTION: 'off', ECCLIUM_FOO: 'x' }),
    ],
  ])('freezes %s at every level, without prototypes', (_, run) => {
    const result = run();
    deepFrozen(result, 'result');
    const records: unknown[] = [
      result,
      result.report,
      ...result.report.settings,
      ...result.report.settings.map((entry) => entry.shown),
      ...result.report.problems,
    ];
    if (result.ok) records.push(result.config);
    for (const entry of records) {
      expect(Object.getPrototypeOf(entry)).toBeNull();
    }
  });

  it('keeps one load apart from the next', () => {
    const environment: Environment = {
      ...valid(),
      ECCLIUM_READ_ONLY: 'false',
    };
    const first = load(environment);
    environment.ECCLIUM_READ_ONLY = 'true';
    environment.ECCLIUM_FOO = 'x';
    const second = load(environment);
    expect(first.ok && first.config.readOnly).toBe(false);
    expect(first.report.problems).toEqual([]);
    expect(codes(second)).toEqual(['unknown_variable']);
    expect(second).not.toBe(first);
  });

  it('loads well after a load that threw', () => {
    expect(() =>
      loadConfig({
        environment: valid(),
        transport: 'tcp' as unknown as Transport,
      }),
    ).toThrow();
    expect(load(valid()).ok).toBe(true);
  });
});
