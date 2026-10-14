import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';

import {
  assertNoCanary,
  assertPlanted,
  makeCanaries,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  loadConfig,
  maxReportedProblems,
  type Transport,
} from './load.js';
import type { TokenFileStats, TokenFileSystem } from './token-file.js';
import {
  tokenVariableName,
  unsupportedVariableNames,
  variableNames,
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

const load = (
  environment: Environment,
  transport: Transport = 'stdio',
  files: TokenFileSystem = memoryFiles().fs,
): ConfigResult => loadConfig({ environment, transport, tokenFiles: files });

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
      readOnly: true,
      redaction: 'standard',
      searchTools: false,
      stdioSubject: 'local-stdio',
      logLevel: 'info',
    });
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
      [
        'searchTools',
        'ECCLIUM_SEARCH_TOOLS',
        'default',
        { kind: 'boolean', value: false },
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
      ECCLIUM_SEARCH_TOOLS: 'true',
      ECCLIUM_STDIO_SUBJECT: 'local-operator-2',
      ECCLIUM_LOG_LEVEL: 'debug',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      churchtoolsOrigin: 'https://demo.example:8443',
      readOnly: false,
      redaction: 'off',
      searchTools: true,
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
      'search_tools_enabled',
    ]);
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
      ECCLIUM_SEARCH_TOOLS: 'true',
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
      'ECCLIUM_TOOLSETS',
      'ECCLIUM_WRITE_CONFIRMATION',
      'ECCLIUM_STATE_DIR',
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

  it.each(variableNames)(
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

  it('reports warnings also when the load fails', () => {
    const result = load({
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
      ECCLIUM_REDACTION: 'off',
    });
    expect(result.ok).toBe(false);
    expect(result.report.warnings).toEqual(['redaction_off']);
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
    unsupported_variable: () => load({ ...valid(), ECCLIUM_TOOLSETS: 'x' }),
    proxy_unsupported: () => load({ ...valid(), ECCLIUM_EGRESS_PROXY: 'x' }),
    tls_check_disabled: () =>
      load({ ...valid(), NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    empty_value: () => load({ ...valid(), ECCLIUM_READ_ONLY: '' }),
    value_too_long: () => load({ ...valid(), ECCLIUM_READ_ONLY: 'xxxxxx' }),
    invalid_choice: () => load({ ...valid(), ECCLIUM_READ_ONLY: 'yes' }),
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
    token_from_environment: () =>
      load({ ECCLIUM_CHURCHTOOLS_URL: address, [tokenVariableName]: token() }),
    redaction_off: () => load({ ...valid(), ECCLIUM_REDACTION: 'off' }),
    search_tools_enabled: () =>
      load({ ...valid(), ECCLIUM_SEARCH_TOOLS: 'true' }),
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

  it('lists 32 problems in a fixed order and counts the rest', () => {
    const environment: Environment = {
      ECCLIUM_CHURCHTOOLS_URL: 'http://demo.example',
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
      ECCLIUM_TOOLSETS: 'x',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    };
    for (let index = 0; index < 40; index += 1) {
      environment[`ECCLIUM_UNKNOWN_${String(index)}`] = 'x';
    }
    const result = load(environment);
    expect(result.report.problems).toHaveLength(maxReportedProblems);
    expect(result.report.omittedProblems).toBe(43 - maxReportedProblems);
    expect(problems(result).slice(0, 6)).toEqual([
      ['url_not_https', 'ECCLIUM_CHURCHTOOLS_URL'],
      ['tls_check_disabled', 'NODE_TLS_REJECT_UNAUTHORIZED'],
      ['unsupported_variable', 'ECCLIUM_TOOLSETS'],
      ['unknown_variable', 'ECCLIUM_UNKNOWN_0'],
      ['unknown_variable', 'ECCLIUM_UNKNOWN_1'],
      ['unknown_variable', 'ECCLIUM_UNKNOWN_10'],
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
      };
      assertPlanted(input, canaries.all, 'environment');
      const result = load(input, 'stdio', files);
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
