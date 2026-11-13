import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
import { KeyMaterial } from '../keys/index.js';
import { isEventName } from '../logger/index.js';
import { defaultPolicy } from '../policy/check.js';
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
  writeConfirmations,
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

const keyPath = '/path/to/pseudonym-key';
const previousKeyPath = '/path/to/pseudonym-key-previous';

// A key as 64 hex digits, made from a seed instead of written out, so that
// no secret scanner reads a test key as a leaked one.
const keyHex = (seed: string): string =>
  createHash('sha256').update(seed).digest('hex');

/**
 * File functions over several files in memory, each found by its path. A
 * path without a file is missing. The checks before the open, the ID of
 * the user and the flags, are those of the first file.
 */
const pathFiles = (
  files: Readonly<Record<string, TokenFileSystem>>,
): TokenFileSystem => {
  let current: TokenFileSystem | undefined;
  const open = (): TokenFileSystem => {
    if (current === undefined) throw new Error('No file is open.');
    return current;
  };
  const [first = memoryFiles().fs] = Object.values(files);
  return {
    openSync: (path, flags) => {
      const file = Object.hasOwn(files, path) ? files[path] : undefined;
      if (file === undefined) throw fsError('ENOENT');
      current = file;
      return file.openSync(path, flags);
    },
    fstatSync: (fd) => open().fstatSync(fd),
    readSync: (fd, buffer, offset, length, position) =>
      open().readSync(fd, buffer, offset, length, position),
    closeSync: (fd) => {
      open().closeSync(fd);
      current = undefined;
    },
    getuid: first.getuid,
    constants: first.constants,
  };
};

/**
 * A good configuration with a key file, and with a second one when its
 * content is given. The token file stays good.
 */
const withKeys = (
  key: TokenFileSystem | undefined,
  previous?: TokenFileSystem,
  transport: Transport = 'stdio',
  extra: Environment = {},
): ConfigResult => {
  const files: Record<string, TokenFileSystem> = {
    [tokenPath]: memoryFiles().fs,
  };
  const environment: Environment = { ...valid(), ...extra };
  if (key !== undefined) {
    files[keyPath] = key;
    environment['ECCLIUM_PSEUDONYM_KEY_FILE'] = keyPath;
  }
  if (previous !== undefined) {
    files[previousKeyPath] = previous;
    environment['ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE'] = previousKeyPath;
  }
  return load(environment, transport, pathFiles(files));
};

const keyFile = (seed: string, ending = '\n'): TokenFileSystem =>
  memoryFiles(`${keyHex(seed)}${ending}`).fs;

const markerKeyPath = '/path/to/marker-key';

/**
 * A good configuration of a server that writes to the wiki (ADR 0032),
 * with the key of the check codes and a policy that names whom to ask,
 * unless one of them is left out.
 */
const writingToWiki = (
  leave: { readonly key?: boolean; readonly inquiries?: boolean } = {},
  toolsets = 'wiki',
): ConfigResult => {
  const files: Record<string, TokenFileSystem> = {
    [tokenPath]: memoryFiles().fs,
    [policyPath]: memoryFiles(
      leave.inquiries === true
        ? 'schema: policy.v1\n'
        : 'schema: policy.v1\ninteractive: { inquiriesTo: Sekretariat }\n',
    ).fs,
  };
  const environment: Environment = {
    ...valid(),
    ECCLIUM_READ_ONLY: 'false',
    ECCLIUM_TOOLSETS: toolsets,
    ECCLIUM_KEYS_DIR: keysDirPath,
    ECCLIUM_POLICY_FILE: policyPath,
    ECCLIUM_STATE_DIR: stateDirPath,
  };
  if (leave.key !== true) {
    files[markerKeyPath] = keyFile('m');
    environment['ECCLIUM_MARKER_KEY_FILE'] = markerKeyPath;
  }
  return load(
    environment,
    'stdio',
    pathFiles(files),
    undefined,
    memoryFolder().fs,
  );
};

/**
 * A good configuration with the key file of the check codes (ADR 0032),
 * and with a key file of the pseudonyms when one is given.
 */
const withMarkerKey = (
  key: TokenFileSystem,
  pseudonym?: {
    readonly current?: TokenFileSystem;
    readonly previous?: TokenFileSystem;
  },
  transport: Transport = 'stdio',
): ConfigResult => {
  const files: Record<string, TokenFileSystem> = {
    [tokenPath]: memoryFiles().fs,
    [markerKeyPath]: key,
  };
  const environment: Environment = {
    ...valid(),
    ECCLIUM_MARKER_KEY_FILE: markerKeyPath,
  };
  if (pseudonym?.current !== undefined) {
    files[keyPath] = pseudonym.current;
    environment['ECCLIUM_PSEUDONYM_KEY_FILE'] = keyPath;
  }
  if (pseudonym?.previous !== undefined) {
    files[previousKeyPath] = pseudonym.previous;
    environment['ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE'] = previousKeyPath;
  }
  return load(environment, transport, pathFiles(files));
};

const policyPath = '/path/to/policy.yaml';

/** A good configuration with a file of the policy (ADR 0032). */
const withPolicy = (
  policy: TokenFileSystem | string,
  extra: Environment = {},
  transport: Transport = 'stdio',
): ConfigResult =>
  load(
    { ...valid(), ECCLIUM_POLICY_FILE: policyPath, ...extra },
    transport,
    pathFiles({
      [tokenPath]: memoryFiles().fs,
      [policyPath]:
        typeof policy === 'string' ? memoryFiles(policy).fs : policy,
    }),
  );

const policyYaml = [
  'schema: policy.v1',
  'interactive:',
  '  readBudgetPerDay: 150',
  '  targets:',
  '    - target: { kind: wiki_category, id: 12, name: Berichte }',
  '      tools: [ct_wiki_page_create]',
  '      maxPerDay: 4',
  '',
].join('\n');

const failingPolicy = (code: string): TokenFileSystem =>
  memoryFiles(policyYaml, {
    open: () => {
      throw fsError(code);
    },
  }).fs;

const providersPath = '/path/to/providers.yaml';

/** A good configuration with a file of the providers (ADR 0033). */
const withProviders = (
  providers: TokenFileSystem | string,
  extra: Environment = {},
  transport: Transport = 'stdio',
): ConfigResult =>
  load(
    { ...valid(), ECCLIUM_PROVIDERS_FILE: providersPath, ...extra },
    transport,
    pathFiles({
      [tokenPath]: memoryFiles().fs,
      [providersPath]:
        typeof providers === 'string' ? memoryFiles(providers).fs : providers,
    }),
  );

const providersYaml = [
  'schema: providers.v1',
  'providers:',
  '  - alias: default',
  '    vendor: example',
  '    model: example-maker/example-model-1',
  '    hostingCountry: CH',
  '    endpoint: https://model.example.org/v1/chat/completions',
  '    structuredOutput: true',
  '    apiKeyFile: /path/to/model-key',
  '',
].join('\n');

const failingProviders = (code: string): TokenFileSystem =>
  memoryFiles(providersYaml, {
    open: () => {
      throw fsError(code);
    },
  }).fs;

const stateDirPath = '/path/to/state';
const keysDirPath = '/path/to/keys';
const tokensDirPath = '/path/to/tokens';

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
 * File functions over the folders of state, of keys and of the token files
 * of the runner in memory: by default folders of the user with 0700 and no
 * folder audit, quota, snapshot or queue yet. The folders of keys and of
 * the tokens are found by their paths, so that a test can refuse each
 * alone.
 */
const memoryFolder = (
  options: {
    readonly folder?: Entry;
    readonly audit?: Entry;
    readonly quota?: Entry;
    readonly keys?: Entry;
    readonly tokens?: Entry;
    readonly snapshot?: Entry;
    readonly queue?: Entry;
    readonly stop?: Entry;
    readonly stopSwitch?: Entry;
    readonly getuid?: () => number | undefined;
  } = {},
): MemoryFolder => {
  const looked: string[] = [];
  const missing: Entry = { error: 'ENOENT' };
  const entryOf = (path: string): Entry =>
    path === keysDirPath
      ? (options.keys ?? {})
      : path === tokensDirPath
        ? (options.tokens ?? {})
        : path.endsWith('/audit')
          ? (options.audit ?? missing)
          : path.endsWith('/quota')
            ? (options.quota ?? missing)
            : path.endsWith('/snapshot')
              ? (options.snapshot ?? missing)
              : path.endsWith('/queue')
                ? (options.queue ?? missing)
                : path.endsWith('/stop')
                  ? (options.stop ?? {})
                  : path.endsWith('/stop/writes-off')
                    ? (options.stopSwitch ?? missing)
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

/** A good configuration with a folder of keys (ADR 0031). */
const withKeysDir = (
  value: string,
  folders: StateDirFileSystem = memoryFolder().fs,
  transport: Transport = 'stdio',
  extra: Environment = {},
): ConfigResult =>
  load(
    { ...valid(), ECCLIUM_KEYS_DIR: value, ...extra },
    transport,
    memoryFiles().fs,
    undefined,
    folders,
  );

/** A good configuration with a folder of the tokens of the runner. */
const withTokensDir = (
  value: string,
  folders: StateDirFileSystem = memoryFolder().fs,
  transport: Transport = 'stdio',
): ConfigResult =>
  load(
    { ...valid(), ECCLIUM_RUNNER_TOKENS_DIR: value },
    transport,
    memoryFiles().fs,
    undefined,
    folders,
  );

const routinesDirPath = '/path/to/routines';

/** The token file of the account of the runner itself (ADR 0023). */
const ownTokenPath = `${tokensDirPath}/ct_token_runner`;

/** The token file of another account of the runner, by its alias. */
const accountTokenPath = (alias: string): string =>
  `${tokensDirPath}/ct_token_${alias}`;

/**
 * What the runner needs and a server does not (ADR 0033, ADR 0034), and no
 * token of the server. A variable set to undefined in extra is left out.
 */
const runnerEnv = (extra: Environment = {}): Environment => ({
  ECCLIUM_CHURCHTOOLS_URL: address,
  ECCLIUM_TIME_ZONE: 'Europe/Zurich',
  ECCLIUM_POLICY_FILE: policyPath,
  ECCLIUM_ROUTINES_DIR: routinesDirPath,
  ECCLIUM_STATE_DIR: stateDirPath,
  ECCLIUM_RUNNER_TOKENS_DIR: tokensDirPath,
  // The runner starts only with a proxy or without the boundary on purpose
  // (ADR 0035); the tests of its other rules run without one.
  ECCLIUM_EGRESS: 'off',
  ...extra,
});

/**
 * A policy with one entry for each account given, each of its own routine
 * on the same target, so that no two entries contradict each other.
 */
const runnerPolicy = (credentials: readonly string[] = []): string =>
  [
    'schema: policy.v1',
    ...(credentials.length === 0 ? [] : ['unattended:']),
    ...credentials.flatMap((credential, index) => [
      `  - routine: routine-${String(index)}`,
      `    credential: ${credential}`,
      '    target: { kind: wiki_category, id: 12, name: Berichte }',
      '    tools: [ct_wiki_page_create]',
      '    maxPerRun: 2',
      '    maxPerDay: 4',
    ]),
    '',
  ].join('\n');

/**
 * A good configuration of the runner: its own token file, a policy without
 * entries unless one is given, and the folders in memory. Files of other
 * accounts come with files.
 */
const asRunner = (
  options: {
    readonly own?: TokenFileSystem;
    readonly policy?: string;
    readonly files?: Readonly<Record<string, TokenFileSystem>>;
    readonly extra?: Environment;
    readonly folders?: StateDirFileSystem;
  } = {},
): ConfigResult =>
  load(
    runnerEnv(options.extra),
    'runner',
    pathFiles({
      [policyPath]: memoryFiles(options.policy ?? runnerPolicy()).fs,
      [ownTokenPath]: options.own ?? memoryFiles().fs,
      ...options.files,
    }),
    undefined,
    options.folders ?? memoryFolder().fs,
  );

const pingPath = '/path/to/ping-url';
// The path of a ping works like a secret (ADR 0009), so it is made at run
// time and never shows up in a report.
const pingCheck = `check-${createHash('sha256').update('ping').digest('hex').slice(0, 24)}`;
const pingAddress = `https://ping.example/ping/${pingCheck}`;

/** A runner with the file of the ping, as given. */
const withPing = (file: TokenFileSystem, extra: Environment = {}) =>
  asRunner({
    extra: { ECCLIUM_RUNNER_PING_URL_FILE: pingPath, ...extra },
    files: { [pingPath]: file },
  });

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
      keysDir: undefined,
      snapshots: true,
      writeConfirmation: 'echo-allowed',
      auditRetentionMonths: 12,
      policy: defaultPolicy,
      egressOff: false,
      stdioSubject: 'local-stdio',
      logLevel: 'info',
    });
    expect(Object.hasOwn(result.config, 'stateDir')).toBe(true);
    expect(Object.hasOwn(result.config, 'keysDir')).toBe(true);
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
      ['pseudonymKey', 'ECCLIUM_PSEUDONYM_KEY_FILE', 'unset', { kind: 'none' }],
      [
        'pseudonymKeyPrevious',
        'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE',
        'unset',
        { kind: 'none' },
      ],
      ['toolsets', 'ECCLIUM_TOOLSETS', 'default', { kind: 'list', values: [] }],
      ['stateDir', 'ECCLIUM_STATE_DIR', 'unset', { kind: 'none' }],
      ['keysDir', 'ECCLIUM_KEYS_DIR', 'unset', { kind: 'none' }],
      [
        'snapshots',
        'ECCLIUM_SNAPSHOTS',
        'default',
        { kind: 'choice', value: 'on' },
      ],
      [
        'writeConfirmation',
        'ECCLIUM_WRITE_CONFIRMATION',
        'default',
        { kind: 'choice', value: 'echo-allowed' },
      ],
      ['timeZone', 'ECCLIUM_TIME_ZONE', 'unset', { kind: 'none' }],
      [
        'auditRetentionMonths',
        'ECCLIUM_AUDIT_RETENTION_MONTHS',
        'default',
        { kind: 'integer', value: 12 },
      ],
      ['policy', 'ECCLIUM_POLICY_FILE', 'default', { kind: 'none' }],
      ['markerKey', 'ECCLIUM_MARKER_KEY_FILE', 'unset', { kind: 'none' }],
      ['routinesDir', 'ECCLIUM_ROUTINES_DIR', 'unset', { kind: 'none' }],
      ['providers', 'ECCLIUM_PROVIDERS_FILE', 'unset', { kind: 'none' }],
      [
        'runnerTokensDir',
        'ECCLIUM_RUNNER_TOKENS_DIR',
        'unset',
        { kind: 'none' },
      ],
      ['draftsDir', 'ECCLIUM_DRAFTS_DIR', 'unset', { kind: 'none' }],
      ['notifyFile', 'ECCLIUM_NOTIFY_FILE', 'unset', { kind: 'none' }],
      ['metricsFile', 'ECCLIUM_RUNNER_METRICS_FILE', 'unset', { kind: 'none' }],
      [
        'runnerPingUrl',
        'ECCLIUM_RUNNER_PING_URL_FILE',
        'unset',
        { kind: 'none' },
      ],
      ['egressProxy', 'ECCLIUM_EGRESS_PROXY', 'unset', { kind: 'none' }],
      ['egress', 'ECCLIUM_EGRESS', 'unset', { kind: 'none' }],
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
      ECCLIUM_TOOLSETS: 'calendars,persons',
      ECCLIUM_STATE_DIR: stateDirPath,
      ECCLIUM_KEYS_DIR: keysDirPath,
      ECCLIUM_STDIO_SUBJECT: 'local-operator-2',
      ECCLIUM_LOG_LEVEL: 'debug',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      churchtoolsOrigin: 'https://demo.example:8443',
      readOnly: false,
      redaction: 'off',
      toolsets: ['persons', 'calendars'],
      stateDir: stateDirPath,
      keysDir: keysDirPath,
      stdioSubject: 'local-operator-2',
      logLevel: 'debug',
    });
    expect(setting(result, 'churchtoolsOrigin')?.shown).toEqual({
      kind: 'origin',
      host: 'demo.example',
      port: '8443',
    });
    expect(result.report.warnings).toEqual([
      'writes_enabled',
      'redaction_off',
      'persons_toolset_enabled',
    ]);
    expect(Object.isFrozen(result.config.toolsets)).toBe(true);
    expect(setting(result, 'toolsets')?.shown).toEqual({
      kind: 'list',
      values: ['persons', 'calendars'],
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

// The folder of the day keys (ADR 0031): needed as soon as the server
// writes, checked like the folder of state, and never the folder of state
// or a folder in it.
describe('loadConfig and the folder of keys', () => {
  it('leaves the folder unset while the server only reads, without looking at the disk', () => {
    const folder = memoryFolder();
    const result = load(
      valid(),
      'stdio',
      memoryFiles().fs,
      undefined,
      folder.fs,
    );
    expect(result.ok && result.config.keysDir).toBeUndefined();
    expect(setting(result, 'keysDir')).toMatchObject({
      variable: 'ECCLIUM_KEYS_DIR',
      origin: 'unset',
      shown: { kind: 'none' },
    });
    expect(folder.looked).toEqual([]);
  });

  it('takes a checked folder, also while the server only reads, and looks at the folder of each purpose', () => {
    const folder = memoryFolder({ snapshot: {} });
    const result = withKeysDir(keysDirPath, folder.fs);
    expect(result.ok && result.config.keysDir).toBe(keysDirPath);
    expect(result.ok && result.config.readOnly).toBe(true);
    expect(setting(result, 'keysDir')).toMatchObject({
      origin: 'environment',
      shown: { kind: 'path', value: keysDirPath },
    });
    expect(folder.looked).toEqual([
      keysDirPath,
      `${keysDirPath}/snapshot`,
      `${keysDirPath}/queue`,
    ]);
  });

  it('asks for the folder when the server writes, as missing', () => {
    const result = load({
      ...valid(),
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_STATE_DIR: stateDirPath,
    });
    expect(result.ok).toBe(false);
    expect(problems(result)).toEqual([
      ['keys_dir_required', 'ECCLIUM_KEYS_DIR'],
    ]);
    expect(setting(result, 'keysDir')).toMatchObject({
      origin: 'missing',
      shown: { kind: 'none' },
    });
    const written = withKeysDir(keysDirPath, memoryFolder().fs, 'stdio', {
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_STATE_DIR: stateDirPath,
    });
    expect(written.ok && written.config).toMatchObject({
      readOnly: false,
      keysDir: keysDirPath,
    });
  });

  it('does not ask for it when the switch for reading is invalid', () => {
    expect(problems(load({ ...valid(), ECCLIUM_READ_ONLY: 'no' }))).toEqual([
      ['invalid_choice', 'ECCLIUM_READ_ONLY'],
    ]);
  });

  // Over HTTP the variable is refused, so a server over HTTP cannot write
  // in this version.
  it('refuses the folder over http without looking at the disk, and still asks for it when the server writes', () => {
    const folder = memoryFolder();
    expect(problems(withKeysDir(keysDirPath, folder.fs, 'http'))).toEqual([
      ['stdio_only', 'ECCLIUM_KEYS_DIR'],
    ]);
    expect(folder.looked).toEqual([]);
    expect(
      problems(load({ ...valid(), ECCLIUM_READ_ONLY: 'false' }, 'http')),
    ).toEqual([['keys_dir_required', 'ECCLIUM_KEYS_DIR']]);
  });

  it('refuses the folder and keeps its path out of the report', () => {
    const result = withKeysDir(
      keysDirPath,
      memoryFolder({ keys: { mode: 0o40755 } }).fs,
    );
    expect(problems(result)).toEqual([['keys_dir_mode', 'ECCLIUM_KEYS_DIR']]);
    expect(setting(result, 'keysDir')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
    expect(JSON.stringify(result.report)).not.toContain(keysDirPath);
  });

  it.each([
    ['an empty value', '', [['empty_value', 'ECCLIUM_KEYS_DIR']]],
    [
      'a value of 897 characters',
      `/${'a'.repeat(896)}`,
      [['value_too_long', 'ECCLIUM_KEYS_DIR']],
    ],
  ])('refuses %s without looking at the disk', (_name, value, expected) => {
    const folder = memoryFolder();
    const result = withKeysDir(value, folder.fs);
    expect(problems(result)).toEqual(expected);
    expect(setting(result, 'keysDir')?.origin).toBe('invalid');
    expect(folder.looked).toEqual([]);
  });

  it('takes a path of 896 characters', () => {
    expect(withKeysDir(`/${'a'.repeat(895)}`).ok).toBe(true);
  });

  // A backup of the folder of state would hold the keys that open its
  // snapshots, also those that were destroyed.
  it.each([
    ['the folder of state itself', stateDirPath, stateDirPath],
    ['a folder in it', `${stateDirPath}/keys`, stateDirPath],
    ['a folder deep in it', `${stateDirPath}/a/b/keys`, stateDirPath],
    ['any folder when the folder of state is the root', keysDirPath, '/'],
  ])('refuses %s without looking at the disk', (_name, keys, state) => {
    const folder = memoryFolder();
    const result = load(
      { ...valid(), ECCLIUM_STATE_DIR: state, ECCLIUM_KEYS_DIR: keys },
      'stdio',
      memoryFiles().fs,
      undefined,
      folder.fs,
    );
    expect(problems(result)).toEqual([
      ['keys_dir_in_state_dir', 'ECCLIUM_KEYS_DIR'],
    ]);
    // The folder of state is looked at as such, the folder of keys not.
    expect(folder.looked).not.toContain(`${keys}/snapshot`);
    expect(setting(result, 'keysDir')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  // Then the folder of a purpose could be the folder of state itself, and
  // keeping the folder of keys out of a backup would keep the audit out.
  it('refuses a folder of keys above the folder of state', () => {
    const result = load(
      {
        ...valid(),
        ECCLIUM_STATE_DIR: stateDirPath,
        ECCLIUM_KEYS_DIR: '/path/to',
      },
      'stdio',
      memoryFiles().fs,
      undefined,
      memoryFolder().fs,
    );
    expect(problems(result)).toEqual([
      ['state_dir_in_keys_dir', 'ECCLIUM_KEYS_DIR'],
    ]);
  });

  it.each([
    ['a folder next to it', `${stateDirPath}-keys`],
    ['a folder elsewhere', keysDirPath],
  ])('takes %s', (_name, keys) => {
    const result = load(
      { ...valid(), ECCLIUM_STATE_DIR: stateDirPath, ECCLIUM_KEYS_DIR: keys },
      'stdio',
      memoryFiles().fs,
      undefined,
      memoryFolder().fs,
    );
    expect(result.ok && result.config.keysDir).toBe(keys);
  });

  // A folder of state that is refused still counts, as it names where the
  // operator keeps the state; one that is not even a path in its one form
  // leaves the check of the folder of keys to the disk.
  it('compares with a folder of state that is refused, and not with one of another form', () => {
    expect(
      codes(
        load(
          {
            ...valid(),
            ECCLIUM_STATE_DIR: stateDirPath,
            ECCLIUM_KEYS_DIR: `${stateDirPath}/keys`,
          },
          'stdio',
          memoryFiles().fs,
          undefined,
          memoryFolder({ folder: { mode: 0o40755 } }).fs,
        ),
      ),
    ).toEqual(['state_dir_mode', 'keys_dir_in_state_dir']);
    expect(
      codes(
        load({
          ...valid(),
          ECCLIUM_STATE_DIR: `${stateDirPath}/`,
          ECCLIUM_KEYS_DIR: `${stateDirPath}/keys`,
        }),
      ),
    ).toEqual(['state_dir_not_normalized']);
  });

  it('reports the folder after the folder of state and before the retention', () => {
    const result = load({
      ...valid(),
      ECCLIUM_AUDIT_RETENTION_MONTHS: '0',
      ECCLIUM_KEYS_DIR: 'keys',
      ECCLIUM_STATE_DIR: 'state',
    });
    expect(problems(result)).toEqual([
      ['state_dir_relative', 'ECCLIUM_STATE_DIR'],
      ['keys_dir_relative', 'ECCLIUM_KEYS_DIR'],
      ['invalid_retention', 'ECCLIUM_AUDIT_RETENTION_MONTHS'],
    ]);
  });

  describe('on the disk', () => {
    const base = mkdtempSync(join(tmpdir(), 'ecclium-load-keys-'));

    afterAll(() => {
      rmSync(base, { recursive: true, force: true });
    });

    // A real folder of state with its folder stop beside the keys, as
    // writing needs it (ADR 0029).
    const loadFromDisk = (value: string): ConfigResult => {
      const state = join(base, 'state-beside-keys');
      mkdirSync(join(state, 'stop'), { recursive: true, mode: 0o700 });
      chmodSync(state, 0o700);
      return loadConfig({
        environment: {
          ...valid(),
          ECCLIUM_READ_ONLY: 'false',
          ECCLIUM_KEYS_DIR: value,
          ECCLIUM_STATE_DIR: state,
        },
        transport: 'stdio',
        tokenFiles: memoryFiles().fs,
      });
    };

    it('checks the real folder when no file functions are given', () => {
      expect(problems(loadFromDisk(join(base, 'missing')))).toEqual([
        ['keys_dir_missing', 'ECCLIUM_KEYS_DIR'],
      ]);
    });

    it('creates nothing, not even the folder snapshot', () => {
      const folder = join(base, 'keys');
      mkdirSync(folder, { mode: 0o700 });
      expect(loadFromDisk(folder).ok).toBe(true);
      expect(existsSync(join(folder, 'snapshot'))).toBe(false);
    });
  });
});

// Writing over stdio needs the folder of state and its folder stop, so a
// start that could never write stops up front (ADR 0029).
describe('loadConfig and the folders writing needs', () => {
  const writes = (
    extra: Environment,
    folders: StateDirFileSystem = memoryFolder().fs,
    transport: Transport = 'stdio',
  ): ConfigResult =>
    withKeysDir(keysDirPath, folders, transport, {
      ECCLIUM_READ_ONLY: 'false',
      ...extra,
    });

  it('stops the start without the folder of state, only while the server writes', () => {
    expect(problems(writes({}))).toEqual([
      ['writes_without_state_dir', 'ECCLIUM_STATE_DIR'],
    ]);
    // The counter-checks: with the folder, or without writing.
    expect(writes({ ECCLIUM_STATE_DIR: stateDirPath }).ok).toBe(true);
    expect(load(valid()).ok).toBe(true);
  });

  it('starts with a switch in stop, and stops when the switch cannot be checked', () => {
    const withSwitch = (stopSwitch: Entry) =>
      writes(
        { ECCLIUM_STATE_DIR: stateDirPath },
        memoryFolder({ stopSwitch }).fs,
      );
    // Writing switched off is a state the operator chose, not a mistake.
    expect(withSwitch({}).ok).toBe(true);
    expect(problems(withSwitch({ error: 'EACCES' }))).toEqual([
      ['writes_without_stop_dir', 'ECCLIUM_STATE_DIR'],
    ]);
  });

  it('stops the start when stop is missing, a link or no folder', () => {
    for (const stop of [
      { error: 'ENOENT' },
      { error: 'EACCES' },
      { symlink: true },
      { directory: false },
    ] as const) {
      expect(
        problems(
          writes(
            { ECCLIUM_STATE_DIR: stateDirPath },
            memoryFolder({ stop }).fs,
          ),
        ),
      ).toEqual([['writes_without_stop_dir', 'ECCLIUM_STATE_DIR']]);
    }
    // The counter-check: the same without writing looks at no stop.
    const reading = memoryFolder({ stop: { error: 'ENOENT' } });
    expect(
      load(
        { ...valid(), ECCLIUM_STATE_DIR: stateDirPath },
        'stdio',
        memoryFiles().fs,
        undefined,
        reading.fs,
      ).ok,
    ).toBe(true);
    expect(reading.looked.some((path) => path.endsWith('/stop'))).toBe(false);
  });

  it('reports only the problem of a folder of state it refuses', () => {
    expect(
      problems(
        writes(
          { ECCLIUM_STATE_DIR: 'relative/state' },
          memoryFolder({ stop: { error: 'ENOENT' } }).fs,
        ),
      ),
    ).toEqual([['state_dir_relative', 'ECCLIUM_STATE_DIR']]);
  });

  it('asks for neither over HTTP, where the server does not write', () => {
    const codesOverHttp = codes(writes({}, memoryFolder().fs, 'http'));
    expect(codesOverHttp).not.toContain('writes_without_state_dir');
    expect(codesOverHttp).not.toContain('writes_without_stop_dir');
  });
});

// The snapshots of writes (ADR 0031): on by default, and off only with a
// warning on every start that writes.
describe('loadConfig and the snapshots', () => {
  const writing = (extra: Environment = {}): ConfigResult =>
    withKeysDir(keysDirPath, memoryFolder().fs, 'stdio', {
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_STATE_DIR: stateDirPath,
      ...extra,
    });

  it('keeps snapshots by default, also while the server writes, without a warning of their own', () => {
    const result = writing();
    expect(result.ok && result.config.snapshots).toBe(true);
    expect(setting(result, 'snapshots')).toEqual({
      key: 'snapshots',
      variable: 'ECCLIUM_SNAPSHOTS',
      origin: 'default',
      shown: { kind: 'choice', value: 'on' },
    });
    expect(result.report.warnings).toEqual(['writes_enabled']);
    const given = writing({ ECCLIUM_SNAPSHOTS: 'on' });
    expect(given.ok && given.config.snapshots).toBe(true);
    expect(setting(given, 'snapshots')?.origin).toBe('environment');
    expect(given.report.warnings).toEqual(['writes_enabled']);
  });

  it('turns them off with a warning when the server writes', () => {
    const result = writing({ ECCLIUM_SNAPSHOTS: 'off' });
    expect(result.ok && result.config.snapshots).toBe(false);
    expect(setting(result, 'snapshots')).toMatchObject({
      origin: 'environment',
      shown: { kind: 'choice', value: 'off' },
    });
    expect(result.report.warnings).toEqual(['writes_enabled', 'snapshots_off']);
  });

  // A server that only reads keeps no snapshot either way.
  it('says nothing of snapshots that are off while the server only reads', () => {
    const result = load({ ...valid(), ECCLIUM_SNAPSHOTS: 'off' });
    expect(result.ok && result.config.snapshots).toBe(false);
    expect(result.report.warnings).toEqual([]);
  });

  // Unlike the folder of keys, the switch holds over HTTP as well.
  it('takes the switch over http as well', () => {
    const result = load({ ...valid(), ECCLIUM_SNAPSHOTS: 'off' }, 'http');
    expect(result.ok && result.config.snapshots).toBe(false);
    expect(result.report.problems).toEqual([]);
  });

  it('warns also when the folder of keys is missing, next to that problem', () => {
    const result = load({
      ...valid(),
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_STATE_DIR: stateDirPath,
      ECCLIUM_SNAPSHOTS: 'off',
    });
    expect(problems(result)).toEqual([
      ['keys_dir_required', 'ECCLIUM_KEYS_DIR'],
    ]);
    expect(result.report.warnings).toEqual(['writes_enabled', 'snapshots_off']);
  });

  it.each(['', 'ON', 'Off', 'no', 'of', ' on'])(
    'refuses the value %j without repeating it',
    (value) => {
      const result = writing({ ECCLIUM_SNAPSHOTS: value });
      expect(result.ok).toBe(false);
      expect(problems(result)).toEqual([
        [value === '' ? 'empty_value' : 'invalid_choice', 'ECCLIUM_SNAPSHOTS'],
      ]);
      expect(setting(result, 'snapshots')).toMatchObject({
        origin: 'invalid',
        shown: { kind: 'none' },
      });
      expect(result.report.warnings).toEqual(['writes_enabled']);
      if (value.trim() !== '') {
        expect(JSON.stringify(result.report)).not.toContain(`"${value}"`);
      }
    },
  );

  it.each(['none', 'true', 'false'])(
    'refuses %j as too long, before any choice',
    (value) => {
      expect(problems(writing({ ECCLIUM_SNAPSHOTS: value }))).toEqual([
        ['value_too_long', 'ECCLIUM_SNAPSHOTS'],
      ]);
    },
  );
});

// The zone of the texts of times: unset means UTC, a name is kept as
// given, and anything else stops the start without its value.
describe('loadConfig and the zone of the texts', () => {
  it('leaves the zone unset without the variable', () => {
    const result = load(valid());
    expect(result.ok && result.config.timeZone).toBeUndefined();
    expect(result.ok && Object.hasOwn(result.config, 'timeZone')).toBe(true);
    expect(setting(result, 'timeZone')).toMatchObject({
      origin: 'unset',
      shown: { kind: 'none' },
    });
  });

  it.each(['Europe/Zurich', 'UTC', 'Asia/Kolkata'])(
    'keeps %s as given, over stdio and HTTP',
    (zone) => {
      for (const transport of ['stdio', 'http'] as const) {
        const result = load({ ...valid(), ECCLIUM_TIME_ZONE: zone }, transport);
        expect(result.ok && result.config.timeZone, transport).toBe(zone);
        expect(setting(result, 'timeZone')).toEqual({
          key: 'timeZone',
          variable: 'ECCLIUM_TIME_ZONE',
          origin: 'environment',
          shown: { kind: 'choice', value: zone },
        });
      }
    },
  );

  it.each(['Mars/Base', '+01:00', 'europe/zurich', 'CET', 'Etc/GMT+1'])(
    'refuses %s without showing it',
    (zone) => {
      const result = load({ ...valid(), ECCLIUM_TIME_ZONE: zone });
      expect(result.ok).toBe(false);
      expect(problems(result)).toEqual([
        ['time_zone_invalid', 'ECCLIUM_TIME_ZONE'],
      ]);
      expect(setting(result, 'timeZone')).toMatchObject({
        origin: 'invalid',
        shown: { kind: 'none' },
      });
      expect(JSON.stringify(result.report)).not.toContain(zone);
    },
  );

  it.each([
    ['', 'empty_value'],
    [`Europe/${'A'.repeat(60)}`, 'value_too_long'],
  ])('reports %j with %s', (zone, code) => {
    const result = load({ ...valid(), ECCLIUM_TIME_ZONE: zone });
    expect(problems(result)).toEqual([[code, 'ECCLIUM_TIME_ZONE']]);
    expect(setting(result, 'timeZone')?.origin).toBe('invalid');
  });
});

// How a write gets confirmed (ADR 0029): echo-allowed over stdio,
// elicitation-or-queue over HTTP, and the echo over HTTP only when the
// operator sets it, with a warning on every start.
describe('loadConfig and the confirmation of writes', () => {
  const confirming = (
    value: string,
    transport: Transport = 'stdio',
  ): ConfigResult =>
    load({ ...valid(), ECCLIUM_WRITE_CONFIRMATION: value }, transport);

  it('takes echo-allowed by default over stdio, without a warning', () => {
    const result = load(valid());
    expect(result.ok && result.config.writeConfirmation).toBe('echo-allowed');
    expect(setting(result, 'writeConfirmation')).toEqual({
      key: 'writeConfirmation',
      variable: 'ECCLIUM_WRITE_CONFIRMATION',
      origin: 'default',
      shown: { kind: 'choice', value: 'echo-allowed' },
    });
    expect(result.report.warnings).toEqual([]);
  });

  // The table has one default, the one over stdio, so the loader puts in
  // the one over HTTP itself, still as the default.
  it('takes elicitation-or-queue by default over http, without a warning', () => {
    const result = load(valid(), 'http');
    expect(result.ok && result.config.writeConfirmation).toBe(
      'elicitation-or-queue',
    );
    expect(setting(result, 'writeConfirmation')).toEqual({
      key: 'writeConfirmation',
      variable: 'ECCLIUM_WRITE_CONFIRMATION',
      origin: 'default',
      shown: { kind: 'choice', value: 'elicitation-or-queue' },
    });
    expect(result.report.warnings).toEqual([]);
  });

  it.each(writeConfirmations)(
    'takes %s as given over stdio, without a warning',
    (value) => {
      const result = confirming(value);
      expect(result.ok && result.config.writeConfirmation).toBe(value);
      expect(setting(result, 'writeConfirmation')).toMatchObject({
        origin: 'environment',
        shown: { kind: 'choice', value },
      });
      expect(result.report.warnings).toEqual([]);
    },
  );

  // Also while the server only reads: over HTTP no server writes in this
  // version, and the operator learns of the choice before one does.
  it('takes echo-allowed over http only with a warning', () => {
    const result = confirming('echo-allowed', 'http');
    expect(result.ok && result.config.writeConfirmation).toBe('echo-allowed');
    expect(setting(result, 'writeConfirmation')).toMatchObject({
      origin: 'environment',
      shown: { kind: 'choice', value: 'echo-allowed' },
    });
    expect(result.report.warnings).toEqual(['echo_over_http']);
  });

  it.each(['elicitation-or-queue', 'queue'])(
    'takes %s over http as given, without a warning',
    (value) => {
      const result = confirming(value, 'http');
      expect(result.ok && result.config.writeConfirmation).toBe(value);
      expect(setting(result, 'writeConfirmation')?.origin).toBe('environment');
      expect(result.report.warnings).toEqual([]);
    },
  );

  it('warns over http also next to a problem of another variable', () => {
    const result = load(
      {
        ...valid(),
        ECCLIUM_READ_ONLY: 'false',
        ECCLIUM_WRITE_CONFIRMATION: 'echo-allowed',
      },
      'http',
    );
    expect(problems(result)).toEqual([
      ['keys_dir_required', 'ECCLIUM_KEYS_DIR'],
    ]);
    expect(result.report.warnings).toEqual([
      'writes_enabled',
      'echo_over_http',
    ]);
  });

  // A refused value gets no default, over either transport.
  it.each([
    '',
    'QUEUE',
    'Queue',
    'Echo-allowed',
    'echo_allowed',
    'echo',
    'elicitation',
    ' queue',
    'queue ',
  ])('refuses the value %j without repeating it', (value) => {
    for (const transport of ['stdio', 'http'] as const) {
      const result = confirming(value, transport);
      expect(result.ok, transport).toBe(false);
      expect(problems(result), transport).toEqual([
        [
          value === '' ? 'empty_value' : 'invalid_choice',
          'ECCLIUM_WRITE_CONFIRMATION',
        ],
      ]);
      expect(setting(result, 'writeConfirmation'), transport).toMatchObject({
        origin: 'invalid',
        shown: { kind: 'none' },
      });
      expect(result.report.warnings, transport).toEqual([]);
      if (value.trim() !== '') {
        expect(JSON.stringify(result.report)).not.toContain(`"${value}"`);
      }
    }
  });

  it.each(['elicitation-or-queues', 'echo-allowed-or-queue'])(
    'refuses %j as too long, before any choice',
    (value) => {
      expect(problems(confirming(value))).toEqual([
        ['value_too_long', 'ECCLIUM_WRITE_CONFIRMATION'],
      ]);
    },
  );
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

  // Ecclium uses none of them, so it says so instead of passing them by
  // (ADR 0035). NO_PROXY alone opens no way and gives no warning.
  it('warns about the proxy variables of other tools, which it does not use', () => {
    const result = load({
      ...valid(),
      HTTPS_PROXY: 'http://proxy.example:3128',
      HTTP_PROXY: 'http://proxy.example:3128',
      NO_PROXY: 'demo.example',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(result.ok).toBe(true);
    expect(result.report.warnings).toEqual(['environment_proxy_ignored']);
    expect(
      load({ ...valid(), NO_PROXY: 'demo.example' }).report.warnings,
    ).toEqual([]);
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
  it.each(['https://proxy.example:3128', 'http://proxy.example'])(
    'refuses the proxy set to %j',
    (value) => {
      expect(
        problems(load({ ...valid(), ECCLIUM_EGRESS_PROXY: value })),
      ).toEqual([['egress_proxy_invalid', 'ECCLIUM_EGRESS_PROXY']]);
    },
  );

  // strict turns IDs of persons into pseudonyms with the key (ADR 0069).
  it.each(['stdio', 'http'] as const)(
    'takes strict redaction with a key over %s',
    (transport) => {
      const result = withKeys(keyFile('a'), undefined, transport, {
        ECCLIUM_REDACTION: 'strict',
      });
      expect(result.ok && result.config.redaction).toBe('strict');
    },
  );

  it.each(['stdio', 'http'] as const)(
    'refuses strict redaction without a key over %s',
    (transport) => {
      expect(
        problems(load({ ...valid(), ECCLIUM_REDACTION: 'strict' }, transport)),
      ).toEqual([['pseudonym_key_missing', 'ECCLIUM_PSEUDONYM_KEY_FILE']]);
    },
  );

  it('names only the problem of a key file that strict cannot read', () => {
    expect(
      problems(
        withKeys(
          memoryFiles(keyHex('a').toUpperCase()).fs,
          undefined,
          'stdio',
          { ECCLIUM_REDACTION: 'strict' },
        ),
      ),
    ).toEqual([['pseudonym_key_invalid', 'ECCLIUM_PSEUDONYM_KEY_FILE']]);
  });

  // The answers of the escape hatch have no known schema (ADR 0069).
  it.each(['api', 'all,api'])(
    'refuses strict redaction with the toolsets %s',
    (toolsets) => {
      const result = withKeys(keyFile('a'), undefined, 'http', {
        ECCLIUM_REDACTION: 'strict',
        ECCLIUM_TOOLSETS: toolsets,
      });
      expect(problems(result)).toEqual([
        ['redaction_strict_with_api', 'ECCLIUM_TOOLSETS'],
      ]);
      expect(result.report.warnings).toContain('api_toolset_enabled');
    },
  );

  it('takes the toolset api with the redaction standard', () => {
    expect(
      withKeys(keyFile('a'), undefined, 'http', { ECCLIUM_TOOLSETS: 'api' }).ok,
    ).toBe(true);
  });

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

describe('loadConfig and the policy', () => {
  it('takes the default policy without the variable', () => {
    const result = load(valid());
    expect(result.ok && result.config.policy).toBe(defaultPolicy);
    expect(setting(result, 'policy')).toEqual({
      key: 'policy',
      variable: 'ECCLIUM_POLICY_FILE',
      origin: 'default',
      shown: { kind: 'none' },
    });
  });

  it('reads the policy from its file, over stdio and over HTTP', () => {
    for (const transport of ['stdio', 'http'] as const) {
      const result = withPolicy(policyYaml, {}, transport);
      expect(result.ok, transport).toBe(true);
      expect(
        result.ok && result.config.policy.interactive.readBudgetPerDay,
      ).toBe(150);
      expect(setting(result, 'policy')).toEqual({
        key: 'policy',
        variable: 'ECCLIUM_POLICY_FILE',
        origin: 'file',
        shown: { kind: 'path', value: policyPath },
      });
    }
  });

  it('names the field or the line of a problem in the file, never a value', () => {
    const field = withPolicy(
      'schema: policy.v1\ninteractive: { readBudgetPerDay: 1001 }\n',
    );
    expect(field.report.problems).toEqual([
      {
        code: 'policy_invalid',
        variable: 'ECCLIUM_POLICY_FILE',
        field: 'interactive.readBudgetPerDay',
      },
    ]);
    expect(setting(field, 'policy')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
    const line = withPolicy('schema: policy.v1\nunknownKey: [1\n');
    expect(line.report.problems).toEqual([
      { code: 'policy_yaml_syntax', variable: 'ECCLIUM_POLICY_FILE', line: 3 },
    ]);
    expect(JSON.stringify(line.report)).not.toContain('unknownKey');
  });

  it('refuses an empty value', () => {
    const result = load({ ...valid(), ECCLIUM_POLICY_FILE: '' });
    expect(problems(result)).toEqual([['empty_value', 'ECCLIUM_POLICY_FILE']]);
    expect(setting(result, 'policy')).toMatchObject({ origin: 'invalid' });
  });

  // The library for YAML writes every token it reads to stdout while one
  // of them is set, which would break the protocol over stdio (ADR 0032).
  it('does not read the file while LOG_TOKENS or LOG_STREAM is set, in any spelling', () => {
    const file = memoryFiles(policyYaml);
    const result = withPolicy(file.fs, { log_tokens: '1', LOG_STREAM: 'x' });
    // One rank, so by name.
    expect(problems(result)).toEqual([
      ['yaml_debug_output_enabled', 'LOG_STREAM'],
      ['yaml_debug_output_enabled', 'LOG_TOKENS'],
    ]);
    expect(file.opened).toEqual([]);
    expect(setting(result, 'policy')).toMatchObject({ origin: 'invalid' });
  });

  it('lets LOG_TOKENS and LOG_STREAM be without a file of the policy, or empty', () => {
    expect(load({ ...valid(), LOG_TOKENS: '1', LOG_STREAM: '1' }).ok).toBe(
      true,
    );
    expect(withPolicy(policyYaml, { LOG_TOKENS: '' }).ok).toBe(true);
  });
});

describe('loadConfig and the folder of the routines', () => {
  it('leaves it unset without the variable', () => {
    const result = load(valid());
    expect(result.ok && result.config.routinesDir).toBeUndefined();
    expect(setting(result, 'routinesDir')).toMatchObject({
      variable: 'ECCLIUM_ROUTINES_DIR',
      origin: 'unset',
      shown: { kind: 'none' },
    });
  });

  it('takes an absolute path in simple form, without looking at the disk', () => {
    const result = load({
      ...valid(),
      ECCLIUM_ROUTINES_DIR: '/path/to/routines',
    });
    expect(result.ok && result.config.routinesDir).toBe('/path/to/routines');
    expect(setting(result, 'routinesDir')).toMatchObject({
      origin: 'environment',
      shown: { kind: 'path', value: '/path/to/routines' },
    });
  });

  it.each([
    'routines',
    './routines',
    '/path/../routines',
    '/path//routines',
    '/path/routines/',
    '/path/./routines',
  ])('refuses %s without showing it', (value) => {
    const result = load({ ...valid(), ECCLIUM_ROUTINES_DIR: value });
    expect(result.ok).toBe(false);
    expect(problems(result)).toEqual([
      ['routines_dir_invalid', 'ECCLIUM_ROUTINES_DIR'],
    ]);
    expect(setting(result, 'routinesDir')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  // The library for YAML would write each routine to stdout (ADR 0033).
  it('stops the start while LOG_TOKENS or LOG_STREAM is set', () => {
    const result = load({
      ...valid(),
      ECCLIUM_ROUTINES_DIR: '/path/to/routines',
      LOG_TOKENS: '1',
    });
    expect(problems(result)).toEqual([
      ['yaml_debug_output_enabled', 'LOG_TOKENS'],
    ]);
    expect(setting(result, 'routinesDir')).toMatchObject({ origin: 'invalid' });
  });

  it('reports each variable of debug output once, with a policy as well', () => {
    const file = memoryFiles(policyYaml);
    const result = withPolicy(file.fs, {
      ECCLIUM_ROUTINES_DIR: '/path/to/routines',
      LOG_STREAM: 'x',
    });
    expect(problems(result)).toEqual([
      ['yaml_debug_output_enabled', 'LOG_STREAM'],
    ]);
    expect(file.opened).toEqual([]);
  });
});

describe('loadConfig and the folder of the tokens of the runner', () => {
  it('leaves it unset without the variable', () => {
    const result = load(valid());
    expect(result.ok && result.config.runnerTokensDir).toBeUndefined();
    expect(setting(result, 'runnerTokensDir')).toMatchObject({
      variable: 'ECCLIUM_RUNNER_TOKENS_DIR',
      origin: 'unset',
      shown: { kind: 'none' },
    });
  });

  // Whoever may write in the folder could put the file of a wider account
  // in place of a narrow one, so a set folder is looked at for every
  // transport, like the folder of state (ADR 0033).
  it('takes an absolute path in simple form after a look at the folder', () => {
    const folders = memoryFolder();
    const result = withTokensDir(tokensDirPath, folders.fs);
    expect(result.ok && result.config.runnerTokensDir).toBe(tokensDirPath);
    expect(folders.looked).toEqual([tokensDirPath]);
    expect(setting(result, 'runnerTokensDir')).toMatchObject({
      origin: 'environment',
      shown: { kind: 'path', value: tokensDirPath },
    });
  });

  // Unlike the folders of state and of keys, the group and others may read
  // and search it, as a folder of secrets that a container mounts often
  // allows; each file in it has its own check.
  it.each(['stdio', 'http'] as const)(
    'lets the group and others read the folder over %s, but not write in it',
    (transport) => {
      const withMode = (mode: number): string[] =>
        codes(
          withTokensDir(
            tokensDirPath,
            memoryFolder({ tokens: { mode } }).fs,
            transport,
          ),
        );
      expect(withMode(0o40755)).toEqual([]);
      expect(withMode(0o40775)).toEqual(['runner_tokens_dir_mode']);
      expect(withMode(0o40757)).toEqual(['runner_tokens_dir_mode']);
    },
  );

  it('shows a folder refused on disk as invalid, without its path', () => {
    const result = withTokensDir(
      tokensDirPath,
      memoryFolder({ tokens: { uid: 0 } }).fs,
    );
    expect(problems(result)).toEqual([
      ['runner_tokens_dir_owner', 'ECCLIUM_RUNNER_TOKENS_DIR'],
    ]);
    expect(setting(result, 'runnerTokensDir')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  it.each([
    'tokens',
    './tokens',
    '/path/../tokens',
    '/path//tokens',
    '/path/tokens/',
    '/path/./tokens',
  ])('refuses %s without showing it', (value) => {
    const result = load({ ...valid(), ECCLIUM_RUNNER_TOKENS_DIR: value });
    expect(result.ok).toBe(false);
    expect(problems(result)).toEqual([
      ['runner_tokens_dir_invalid', 'ECCLIUM_RUNNER_TOKENS_DIR'],
    ]);
    expect(setting(result, 'runnerTokensDir')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });
});

// A draft or a notice never goes into a folder of Ecclium whose files it
// would spoil or that holds a secret (ADR 0033): the folder of state
// itself and its folders audit, quota, snapshots, queue, runner and stop,
// the folder of keys and the folder of the token files. A folder of drafts
// beside them in the folder of state stays allowed.
describe('loadConfig and the folders of drafts and notices', () => {
  const withKeys = { ECCLIUM_KEYS_DIR: keysDirPath };
  it.each([
    ['ECCLIUM_DRAFTS_DIR', stateDirPath, 'drafts_dir_overlap'],
    ['ECCLIUM_DRAFTS_DIR', '/path', 'drafts_dir_overlap'],
    ['ECCLIUM_DRAFTS_DIR', `${stateDirPath}/audit`, 'drafts_dir_overlap'],
    ['ECCLIUM_DRAFTS_DIR', `${stateDirPath}/stop/drafts`, 'drafts_dir_overlap'],
    ['ECCLIUM_DRAFTS_DIR', `${tokensDirPath}/drafts`, 'drafts_dir_overlap'],
    ['ECCLIUM_DRAFTS_DIR', keysDirPath, 'drafts_dir_overlap'],
    [
      'ECCLIUM_NOTIFY_FILE',
      `${stateDirPath}/quota/notices.jsonl`,
      'notify_file_overlap',
    ],
    [
      'ECCLIUM_NOTIFY_FILE',
      `${stateDirPath}/audit/default-2026-11-11.jsonl`,
      'notify_file_overlap',
    ],
    [
      'ECCLIUM_NOTIFY_FILE',
      `${tokensDirPath}/ct_token_runner`,
      'notify_file_overlap',
    ],
    ['ECCLIUM_NOTIFY_FILE', `${keysDirPath}/notices`, 'notify_file_overlap'],
    [
      'ECCLIUM_RUNNER_METRICS_FILE',
      `${stateDirPath}/runner/runner.prom`,
      'metrics_file_overlap',
    ],
    [
      'ECCLIUM_RUNNER_METRICS_FILE',
      `${stateDirPath}/audit/runner.prom`,
      'metrics_file_overlap',
    ],
    ['ECCLIUM_RUNNER_METRICS_FILE', stateDirPath, 'metrics_file_overlap'],
    [
      'ECCLIUM_RUNNER_METRICS_FILE',
      `${tokensDirPath}/runner.prom`,
      'metrics_file_overlap',
    ],
  ] as const)('refuses %s at %s', (name, path, code) => {
    const result = asRunner({ extra: { ...withKeys, [name]: path } });
    expect(result.ok).toBe(false);
    expect(problems(result)).toContainEqual([code, name]);
  });

  it.each([
    ['ECCLIUM_DRAFTS_DIR', `${stateDirPath}/output`, 'draftsDir'],
    ['ECCLIUM_DRAFTS_DIR', '/path/to/stateful', 'draftsDir'],
    ['ECCLIUM_NOTIFY_FILE', `${stateDirPath}/notices.jsonl`, 'notifyFile'],
    ['ECCLIUM_NOTIFY_FILE', '/path/to/logs/notices.jsonl', 'notifyFile'],
    [
      'ECCLIUM_RUNNER_METRICS_FILE',
      `${stateDirPath}/runner.prom`,
      'metricsFile',
    ],
    [
      'ECCLIUM_RUNNER_METRICS_FILE',
      '/path/to/metrics/runner.prom',
      'metricsFile',
    ],
  ] as const)('takes %s at %s', (name, path, key) => {
    const result = asRunner({ extra: { ...withKeys, [name]: path } });
    expect(codes(result)).not.toContain('drafts_dir_overlap');
    expect(codes(result)).not.toContain('notify_file_overlap');
    expect(codes(result)).not.toContain('metrics_file_overlap');
    expect(setting(result, key)).toMatchObject({ origin: 'environment' });
  });

  // The metrics file is replaced whole after each pass: as the file of the
  // notices it would wipe out their lines, as a key file the key
  // (ADR 0033).
  it.each([
    ['ECCLIUM_NOTIFY_FILE', '/path/to/logs/runner.prom'],
    ['ECCLIUM_DRAFTS_DIR', '/path/to/logs/runner.prom'],
    ['ECCLIUM_POLICY_FILE', '/path/to/config/policy.yaml'],
    ['ECCLIUM_PROVIDERS_FILE', '/path/to/config/providers.yaml'],
    ['ECCLIUM_MARKER_KEY_FILE', '/path/to/config/marker.key'],
  ] as const)('refuses the metrics file at the path of %s', (name, path) => {
    const result = asRunner({
      extra: { ...withKeys, [name]: path, ECCLIUM_RUNNER_METRICS_FILE: path },
    });
    expect(result.ok).toBe(false);
    expect(problems(result)).toContainEqual([
      'metrics_file_overlap',
      'ECCLIUM_RUNNER_METRICS_FILE',
    ]);
    expect(setting(result, 'metricsFile')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  it('refuses the metrics file in the folder of the routines', () => {
    const result = asRunner({
      extra: {
        ...withKeys,
        ECCLIUM_RUNNER_METRICS_FILE: `${routinesDirPath}/runner.prom`,
      },
    });
    expect(problems(result)).toContainEqual([
      'metrics_file_overlap',
      'ECCLIUM_RUNNER_METRICS_FILE',
    ]);
  });

  // The name must be one a private file of the runner takes, so that a
  // path the start takes is one the runner can write.
  it.each([
    '/path/to/metrics/.runner.prom',
    '/path/to/metrics/runner prom',
    '/path/to/metrics/läufe.prom',
    `/path/to/metrics/${'r'.repeat(129)}`,
  ])('refuses the metrics file %s by its name', (path) => {
    const result = asRunner({
      extra: { ...withKeys, ECCLIUM_RUNNER_METRICS_FILE: path },
    });
    expect(problems(result)).toContainEqual([
      'metrics_file_invalid',
      'ECCLIUM_RUNNER_METRICS_FILE',
    ]);
  });
});

// The folder of the drafts of the channel file and the file of the notices
// after a run (ADR 0033): only the runner writes them and prepares both
// itself, so every start checks the form of the path alone, as for the
// routines, and neither is required.
describe.each([
  ['draftsDir', 'ECCLIUM_DRAFTS_DIR', 'drafts_dir_invalid', '/path/to/drafts'],
  [
    'notifyFile',
    'ECCLIUM_NOTIFY_FILE',
    'notify_file_invalid',
    '/path/to/notify.jsonl',
  ],
  [
    'metricsFile',
    'ECCLIUM_RUNNER_METRICS_FILE',
    'metrics_file_invalid',
    '/path/to/metrics/runner.prom',
  ],
] as const)('loadConfig and %s', (key, name, code, path) => {
  it('leaves it unset without the variable, for the runner as well', () => {
    for (const result of [load(valid()), asRunner()]) {
      expect(result.ok && result.config[key]).toBeUndefined();
      expect(setting(result, key)).toMatchObject({
        variable: name,
        origin: 'unset',
        shown: { kind: 'none' },
      });
    }
  });

  it.each(['stdio', 'http'] as const)(
    'takes an absolute path in simple form over %s, without looking at the disk',
    (transport) => {
      const files = memoryFiles();
      const folders = memoryFolder();
      const result = load(
        { ...valid(), [name]: path },
        transport,
        files.fs,
        undefined,
        folders.fs,
      );
      expect(result.report.problems).toEqual([]);
      expect(result.ok && result.config[key]).toBe(path);
      expect(files.opened).toEqual([tokenPath]);
      expect(folders.looked).toEqual([]);
      expect(setting(result, key)).toMatchObject({
        variable: name,
        origin: 'environment',
        shown: { kind: 'path', value: path },
      });
    },
  );

  it('takes it for the runner', () => {
    const result = asRunner({ extra: { [name]: path } });
    expect(result.report.problems).toEqual([]);
    expect(result.ok && result.config[key]).toBe(path);
  });

  it.each([
    'drafts',
    './drafts',
    '/path/../drafts',
    '/path//drafts',
    '/path/drafts/',
    '/path/./drafts',
  ])('refuses %s without showing it', (value) => {
    const result = load({ ...valid(), [name]: value });
    expect(result.ok).toBe(false);
    expect(problems(result)).toEqual([[code, name]]);
    expect(setting(result, key)).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  it('reports an empty value as such, without its own problem', () => {
    const result = load({ ...valid(), [name]: '' });
    expect(result.ok).toBe(false);
    expect(problems(result)).toEqual([['empty_value', name]]);
    expect(setting(result, key)).toMatchObject({ origin: 'invalid' });
  });

  // Neither names a file in YAML, so the debug output of the library for
  // YAML does not stop the start, unlike with the routines (ADR 0033).
  it('lets LOG_TOKENS and LOG_STREAM be', () => {
    const result = load({
      ...valid(),
      [name]: path,
      LOG_TOKENS: '1',
      LOG_STREAM: '1',
    });
    expect(result.report.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// The runner of routines (ADR 0033, ADR 0034): its own account from the
// folder of the tokens, never the token of the server (ADR 0023), and the
// settings a server may leave out.
describe('loadConfig for the runner', () => {
  it('loads with the token file of its own account', () => {
    const own = memoryFiles();
    const result = asRunner({ own: own.fs });
    expect(result.report.problems).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      transport: 'runner',
      tokenSource: 'file',
      readOnly: true,
      timeZone: 'Europe/Zurich',
      stateDir: stateDirPath,
      routinesDir: routinesDirPath,
      runnerTokensDir: tokensDirPath,
    });
    expect(result.config.churchtoolsToken).toBeInstanceOf(Secret);
    expect(own.opened).toEqual([ownTokenPath]);
    expect(
      result.report.settings.filter(({ key }) => key === 'churchtoolsToken'),
    ).toEqual([
      {
        key: 'churchtoolsToken',
        variable: 'ECCLIUM_RUNNER_TOKENS_DIR',
        origin: 'file',
        shown: { kind: 'hidden' },
      },
    ]);
    expect(result.report.warnings).toEqual(['egress_off']);
  });

  // Its container should not keep the token of the server by mistake, so
  // the file is refused unopened, and the token in the environment as a
  // setting for stdio only, without a conflict between the two.
  it('refuses the token file of the server without opening it', () => {
    const server = memoryFiles();
    const files = { [tokenPath]: server.fs };
    const result = asRunner({
      extra: { ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath },
      files,
    });
    expect(problems(result)).toEqual([
      ['runner_server_token', 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE'],
    ]);
    const both = asRunner({
      extra: {
        ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
        [tokenVariableName]: token(),
      },
      files,
    });
    expect(problems(both)).toEqual([
      ['runner_server_token', 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE'],
      ['runner_stdio_only', tokenVariableName],
    ]);
    expect(server.opened).toEqual([]);
  });

  // The default subject is refused as well: the runner has no person at
  // the other end of a pipe.
  it.each([
    [tokenVariableName, token()],
    ['ECCLIUM_STDIO_SUBJECT', 'local-stdio'],
    ['ECCLIUM_REDACTION', 'off'],
  ])('refuses %s as a setting for stdio only', (name, value) => {
    const result = asRunner({ extra: { [name]: value } });
    // A code of its own, so that the message speaks of the runner and not
    // of the server over HTTP.
    expect(problems(result)).toEqual([['runner_stdio_only', name]]);
    expect(result.report.warnings).toEqual(['egress_off']);
  });

  it('takes the folders of state and of keys and the retention', () => {
    const result = asRunner({
      extra: {
        ECCLIUM_KEYS_DIR: keysDirPath,
        ECCLIUM_AUDIT_RETENTION_MONTHS: '24',
      },
    });
    expect(result.report.problems).toEqual([]);
    expect(result.ok && result.config).toMatchObject({
      stateDir: stateDirPath,
      keysDir: keysDirPath,
      auditRetentionMonths: 24,
    });
  });

  // ecclium config check names all of them at once, each as missing.
  it('names the five settings it needs together', () => {
    const result = load({ ECCLIUM_CHURCHTOOLS_URL: address }, 'runner');
    expect(problems(result)).toEqual([
      ['runner_state_dir_required', 'ECCLIUM_STATE_DIR'],
      ['runner_time_zone_required', 'ECCLIUM_TIME_ZONE'],
      ['runner_policy_required', 'ECCLIUM_POLICY_FILE'],
      ['runner_routines_dir_required', 'ECCLIUM_ROUTINES_DIR'],
      ['runner_tokens_dir_required', 'ECCLIUM_RUNNER_TOKENS_DIR'],
      ['runner_egress_required', 'ECCLIUM_EGRESS_PROXY'],
    ]);
    for (const key of [
      'stateDir',
      'timeZone',
      'policy',
      'routinesDir',
      'runnerTokensDir',
      'churchtoolsToken',
    ]) {
      expect(setting(result, key), key).toMatchObject({
        origin: 'missing',
        shown: { kind: 'none' },
      });
    }
  });

  // Each account the policy names is checked before the first run, so
  // that no run meets a file only then; its token is dropped at once.
  it('reads the file of each account once, its own as well', () => {
    const own = memoryFiles();
    const report = memoryFiles();
    const archive = memoryFiles();
    const result = asRunner({
      policy: runnerPolicy(['bericht', 'runner', 'bericht', 'archiv']),
      own: own.fs,
      files: {
        [accountTokenPath('bericht')]: report.fs,
        [accountTokenPath('archiv')]: archive.fs,
      },
    });
    expect(result.report.problems).toEqual([]);
    expect(result.ok && result.config.policy.unattended).toHaveLength(4);
    expect(own.opened).toEqual([ownTokenPath]);
    expect(report.opened).toEqual([accountTokenPath('bericht')]);
    expect(archive.opened).toEqual([accountTokenPath('archiv')]);
  });

  // A report names the field of the first entry with the account, never
  // the alias or the path, so that it fits into a public issue.
  it('stops at a refused file of an account and names the field of its first entry', () => {
    const result = asRunner({
      policy: runnerPolicy(['runner', 'bericht', 'bericht']),
    });
    expect(result.ok).toBe(false);
    expect(result.report.problems).toEqual([
      {
        code: 'runner_token_file_missing',
        variable: 'ECCLIUM_RUNNER_TOKENS_DIR',
        field: 'unattended[1].credential',
      },
    ]);
    expect(setting(result, 'churchtoolsToken')?.origin).toBe('file');
    expect(JSON.stringify(result.report)).not.toMatch(/bericht|ct_token/u);
  });

  it('names no field for its own file and checks the other files all the same', () => {
    const result = asRunner({
      policy: runnerPolicy(['bericht']),
      own: memoryFiles(undefined, { stats: { mode: 0o100640 } }).fs,
      files: { [accountTokenPath('bericht')]: memoryFiles('\n').fs },
    });
    expect(result.report.problems).toEqual([
      { code: 'runner_token_file_mode', variable: 'ECCLIUM_RUNNER_TOKENS_DIR' },
      {
        code: 'runner_token_file_empty',
        variable: 'ECCLIUM_RUNNER_TOKENS_DIR',
        field: 'unattended[0].credential',
      },
    ]);
    expect(setting(result, 'churchtoolsToken')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  it('reads no token file in a refused folder', () => {
    const own = memoryFiles();
    const result = asRunner({
      own: own.fs,
      folders: memoryFolder({ tokens: { mode: 0o40777 } }).fs,
    });
    expect(problems(result)).toEqual([
      ['runner_tokens_dir_mode', 'ECCLIUM_RUNNER_TOKENS_DIR'],
    ]);
    expect(own.opened).toEqual([]);
    expect(setting(result, 'churchtoolsToken')?.origin).toBe('invalid');
  });

  // Without the checks of a token file, which the check of the folder
  // makes as well, the folder is refused rather than the file. The policy
  // is left out, so that only the files of the tokens meet the platform.
  it('reports a platform without the checks of a token file as one of the folder', () => {
    const own = memoryFiles(undefined, { getuid: () => undefined });
    const result = load(
      runnerEnv({ ECCLIUM_POLICY_FILE: undefined }),
      'runner',
      own.fs,
      undefined,
      memoryFolder().fs,
    );
    expect(problems(result)).toEqual([
      ['runner_policy_required', 'ECCLIUM_POLICY_FILE'],
      ['runner_tokens_dir_platform', 'ECCLIUM_RUNNER_TOKENS_DIR'],
    ]);
    expect(own.opened).toEqual([]);
  });

  // A runner that may write writes its sections into the wiki, whatever
  // its toolsets, so it needs all a server over stdio needs to write there
  // (ADR 0029, ADR 0031, ADR 0032).
  it('needs the folder stop, the folder of keys, the marker key and whom to ask when it may write', () => {
    const result = asRunner({
      extra: { ECCLIUM_READ_ONLY: 'false', ECCLIUM_TOOLSETS: '' },
      folders: memoryFolder({ stop: { error: 'ENOENT' } }).fs,
    });
    expect(problems(result)).toEqual([
      ['writes_without_stop_dir', 'ECCLIUM_STATE_DIR'],
      ['keys_dir_required', 'ECCLIUM_KEYS_DIR'],
      ['inquiries_missing', 'ECCLIUM_POLICY_FILE'],
      ['marker_key_missing', 'ECCLIUM_MARKER_KEY_FILE'],
    ]);
  });

  // The runner needs the folder of state in any case, so writing does not
  // ask for it a second time.
  // Without the file of the policy the runner hears of the file, not of
  // the field the default policy lacks.
  it('asks for the file of the policy once, also for writing', () => {
    const result = asRunner({
      extra: { ECCLIUM_READ_ONLY: 'false', ECCLIUM_POLICY_FILE: undefined },
    });
    expect(codes(result)).toContain('runner_policy_required');
    expect(codes(result)).not.toContain('inquiries_missing');
  });

  // A backup of the folder of state would hold the login tokens.
  it.each([
    ['is', stateDirPath, false],
    ['lies in', `${stateDirPath}/runner/tokens`, false],
    ['lies next to', '/path/to/state-tokens', true],
  ])(
    'takes a folder of the tokens that %s the folder of state: %s',
    (_, dir, ok) => {
      const result = load(
        {
          ...valid(),
          ECCLIUM_STATE_DIR: stateDirPath,
          ECCLIUM_RUNNER_TOKENS_DIR: dir,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      );
      expect(result.ok).toBe(ok);
      if (!ok) {
        expect(problems(result)).toEqual([
          ['runner_tokens_dir_in_state_dir', 'ECCLIUM_RUNNER_TOKENS_DIR'],
        ]);
      }
    },
  );

  it('asks for the folder of state once, also for writing', () => {
    const result = asRunner({
      extra: { ECCLIUM_READ_ONLY: 'false', ECCLIUM_STATE_DIR: undefined },
    });
    expect(codes(result)).not.toContain('writes_without_state_dir');
    expect(
      codes(result).filter((code) => code === 'runner_state_dir_required'),
    ).toHaveLength(1);
  });

  it('writes with the folder of keys, the marker key and whom to ask', () => {
    const result = asRunner({
      policy: `${runnerPolicy()}interactive: { inquiriesTo: Sekretariat }\n`,
      extra: {
        ECCLIUM_READ_ONLY: 'false',
        ECCLIUM_KEYS_DIR: keysDirPath,
        ECCLIUM_MARKER_KEY_FILE: markerKeyPath,
      },
      files: { [markerKeyPath]: keyFile('m') },
    });
    expect(result.report.problems).toEqual([]);
    expect(result.ok && result.config.readOnly).toBe(false);
    expect(result.report.warnings).toEqual(['writes_enabled', 'egress_off']);
  });
});

describe('loadConfig and the file of the providers', () => {
  it('has no providers without the variable', () => {
    const result = load(valid());
    expect(result.ok && result.config.providers).toBeUndefined();
    expect(setting(result, 'providers')).toEqual({
      key: 'providers',
      variable: 'ECCLIUM_PROVIDERS_FILE',
      origin: 'unset',
      shown: { kind: 'none' },
    });
  });

  it.each(['stdio', 'http'] as const)(
    'reads and checks the file over %s, but not the file of a key',
    (transport) => {
      const key = memoryFiles('placeholder-key');
      const result = load(
        { ...valid(), ECCLIUM_PROVIDERS_FILE: providersPath },
        transport,
        pathFiles({
          [tokenPath]: memoryFiles().fs,
          [providersPath]: memoryFiles(providersYaml).fs,
          '/path/to/model-key': key.fs,
        }),
      );
      expect(result.ok && result.config.providers).toEqual([
        {
          alias: 'default',
          info: {
            vendor: 'example',
            model: 'example-maker/example-model-1',
            hostingCountry: 'CH',
            endpointHost: 'model.example.org',
          },
          endpoint: 'https://model.example.org/v1/chat/completions',
          structuredOutput: true,
          apiKeyFile: '/path/to/model-key',
        },
      ]);
      expect(key.opened).toEqual([]);
      expect(setting(result, 'providers')).toEqual({
        key: 'providers',
        variable: 'ECCLIUM_PROVIDERS_FILE',
        origin: 'file',
        shown: { kind: 'path', value: providersPath },
      });
    },
  );

  it('names the field of a provider outside without a basis, never a value', () => {
    const result = withProviders(providersYaml.replace('CH', 'US'));
    expect(result.ok).toBe(false);
    expect(result.report.problems).toEqual([
      {
        code: 'providers_transfer_basis_missing',
        variable: 'ECCLIUM_PROVIDERS_FILE',
        field: 'providers[0].transferBasis',
      },
    ]);
    expect(setting(result, 'providers')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  it('takes a provider outside with a basis', () => {
    const result = withProviders(
      `${providersYaml.replace('CH', 'US')}    transferBasis: standard_contractual_clauses\n`,
    );
    expect(result.ok && result.config.providers?.[0]?.info).toMatchObject({
      hostingCountry: 'US',
      transferBasis: 'standard_contractual_clauses',
    });
  });

  it('names the line of a problem of YAML', () => {
    const result = withProviders('schema: providers.v1\nproviders: [1\n');
    expect(result.report.problems).toEqual([
      expect.objectContaining({ code: 'providers_yaml_syntax', line: 3 }),
    ]);
  });

  // The library for YAML would write the file to stdout (ADR 0033).
  it('stops the start while LOG_TOKENS is set, without opening the file', () => {
    const file = memoryFiles(providersYaml);
    const result = withProviders(file.fs, { LOG_TOKENS: '1' });
    expect(problems(result)).toEqual([
      ['yaml_debug_output_enabled', 'LOG_TOKENS'],
    ]);
    expect(file.opened).toEqual([]);
    expect(setting(result, 'providers')).toMatchObject({ origin: 'invalid' });
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
    unsupported_variable: () =>
      load({ ...valid(), ECCLIUM_EGRESS_ALLOW_LAN: 'x' }),
    // The proxy and the switch for a runner without it (ADR 0035).
    egress_proxy_invalid: () =>
      load({ ...valid(), ECCLIUM_EGRESS_PROXY: 'https://egress:3128' }),
    egress_off_with_proxy: () =>
      load({
        ...valid(),
        ECCLIUM_EGRESS_PROXY: 'http://egress:3128',
        ECCLIUM_EGRESS: 'off',
      }),
    runner_egress_required: () =>
      asRunner({ extra: { ECCLIUM_EGRESS: undefined } }),
    egress_off: () => asRunner(),
    environment_proxy_ignored: () =>
      load({ ...valid(), https_proxy: 'http://proxy.example:3128' }),
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
    time_zone_invalid: () =>
      load({ ...valid(), ECCLIUM_TIME_ZONE: 'Mars/Base' }),
    routines_dir_invalid: () =>
      load({ ...valid(), ECCLIUM_ROUTINES_DIR: 'routines' }),
    runner_tokens_dir_invalid: () =>
      load({ ...valid(), ECCLIUM_RUNNER_TOKENS_DIR: 'tokens' }),
    drafts_dir_invalid: () =>
      load({ ...valid(), ECCLIUM_DRAFTS_DIR: 'drafts' }),
    notify_file_invalid: () =>
      load({ ...valid(), ECCLIUM_NOTIFY_FILE: 'notify.jsonl' }),
    metrics_file_invalid: () =>
      load({ ...valid(), ECCLIUM_RUNNER_METRICS_FILE: 'runner.prom' }),
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
    pseudonym_key_missing: () =>
      load({ ...valid(), ECCLIUM_REDACTION: 'strict' }),
    redaction_strict_with_api: () =>
      withKeys(keyFile('a'), undefined, 'http', {
        ECCLIUM_REDACTION: 'strict',
        ECCLIUM_TOOLSETS: 'api',
      }),
    pseudonym_key_file_relative: () =>
      load({ ...valid(), ECCLIUM_PSEUDONYM_KEY_FILE: 'pseudonym-key' }),
    // The token comes from the environment, so that only the key file meets
    // the checks of the platform.
    pseudonym_key_file_platform: () =>
      load(
        {
          ECCLIUM_CHURCHTOOLS_URL: address,
          [tokenVariableName]: token(),
          ECCLIUM_PSEUDONYM_KEY_FILE: keyPath,
        },
        'stdio',
        memoryFiles(undefined, { getuid: () => undefined }).fs,
      ),
    pseudonym_key_file_missing: () =>
      load(
        { ...valid(), ECCLIUM_PSEUDONYM_KEY_FILE: keyPath },
        'stdio',
        pathFiles({ [tokenPath]: memoryFiles().fs }),
      ),
    pseudonym_key_file_symlink: () =>
      withKeys(
        memoryFiles(undefined, {
          open: () => {
            throw fsError('ELOOP');
          },
        }).fs,
      ),
    pseudonym_key_file_unreadable: () =>
      withKeys(
        memoryFiles(undefined, {
          open: () => {
            throw fsError('EACCES');
          },
        }).fs,
      ),
    pseudonym_key_file_not_regular: () =>
      withKeys(memoryFiles(keyHex('a'), { stats: { isFile: false } }).fs),
    pseudonym_key_file_owner: () =>
      withKeys(memoryFiles(keyHex('a'), { stats: { uid: 0 } }).fs),
    pseudonym_key_file_mode: () =>
      withKeys(memoryFiles(keyHex('a'), { stats: { mode: 0o100640 } }).fs),
    pseudonym_key_file_too_large: () =>
      withKeys(memoryFiles('a'.repeat(5000)).fs),
    pseudonym_key_file_empty: () => withKeys(memoryFiles('\n').fs),
    pseudonym_key_file_bom: () =>
      withKeys(memoryFiles(`\xef\xbb\xbf${keyHex('a')}\n`).fs),
    pseudonym_key_file_characters: () =>
      withKeys(memoryFiles(`${keyHex('a')}\n\n`).fs),
    pseudonym_key_file_unsafe: () =>
      withKeys(
        memoryFiles(undefined, {
          open: () => {
            throw fsError('ENOTDIR');
          },
        }).fs,
      ),
    pseudonym_key_invalid: () =>
      withKeys(memoryFiles(keyHex('a').toUpperCase()).fs),
    pseudonym_key_previous_without_current: () =>
      withKeys(undefined, keyFile('a')),
    pseudonym_key_same: () => withKeys(keyFile('a'), keyFile('a')),
    pseudonym_key_change: () => withKeys(keyFile('new'), keyFile('old')),
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
    keys_dir_relative: () => withKeysDir('path/to/keys'),
    keys_dir_too_long: () => withKeysDir(`/${'\u00e4'.repeat(450)}`),
    keys_dir_not_normalized: () => withKeysDir(`${keysDirPath}/`),
    keys_dir_platform: () =>
      withKeysDir(keysDirPath, memoryFolder({ getuid: () => undefined }).fs),
    keys_dir_missing: () =>
      withKeysDir(keysDirPath, memoryFolder({ keys: { error: 'ENOENT' } }).fs),
    keys_dir_symlink: () =>
      withKeysDir(keysDirPath, memoryFolder({ keys: { symlink: true } }).fs),
    keys_dir_not_directory: () =>
      withKeysDir(keysDirPath, memoryFolder({ keys: { directory: false } }).fs),
    keys_dir_owner: () =>
      withKeysDir(keysDirPath, memoryFolder({ keys: { uid: 0 } }).fs),
    keys_dir_mode: () =>
      withKeysDir(keysDirPath, memoryFolder({ keys: { mode: 0o40750 } }).fs),
    keys_dir_unsafe: () =>
      withKeysDir(keysDirPath, memoryFolder({ keys: { error: 'EACCES' } }).fs),
    snapshot_keys_dir_symlink: () =>
      withKeysDir(
        keysDirPath,
        memoryFolder({ snapshot: { symlink: true } }).fs,
      ),
    snapshot_keys_dir_not_directory: () =>
      withKeysDir(
        keysDirPath,
        memoryFolder({ snapshot: { directory: false } }).fs,
      ),
    snapshot_keys_dir_owner: () =>
      withKeysDir(keysDirPath, memoryFolder({ snapshot: { uid: 0 } }).fs),
    snapshot_keys_dir_mode: () =>
      withKeysDir(
        keysDirPath,
        memoryFolder({ snapshot: { mode: 0o40701 } }).fs,
      ),
    snapshot_keys_dir_unsafe: () =>
      withKeysDir(keysDirPath, memoryFolder({ snapshot: { error: 'EIO' } }).fs),
    queue_keys_dir_symlink: () =>
      withKeysDir(keysDirPath, memoryFolder({ queue: { symlink: true } }).fs),
    queue_keys_dir_not_directory: () =>
      withKeysDir(
        keysDirPath,
        memoryFolder({ queue: { directory: false } }).fs,
      ),
    queue_keys_dir_owner: () =>
      withKeysDir(keysDirPath, memoryFolder({ queue: { uid: 0 } }).fs),
    queue_keys_dir_mode: () =>
      withKeysDir(keysDirPath, memoryFolder({ queue: { mode: 0o40701 } }).fs),
    queue_keys_dir_unsafe: () =>
      withKeysDir(keysDirPath, memoryFolder({ queue: { error: 'EIO' } }).fs),
    keys_dir_required: () =>
      load({
        ...valid(),
        ECCLIUM_READ_ONLY: 'false',
        ECCLIUM_STATE_DIR: stateDirPath,
      }),
    keys_dir_in_state_dir: () =>
      withKeysDir(`${stateDirPath}/keys`, memoryFolder().fs, 'stdio', {
        ECCLIUM_STATE_DIR: stateDirPath,
      }),
    state_dir_in_keys_dir: () =>
      withKeysDir('/path/to', memoryFolder().fs, 'stdio', {
        ECCLIUM_STATE_DIR: stateDirPath,
      }),
    // The runner has an account of its own and needs more than a server
    // (ADR 0033, ADR 0034). A set folder of the tokens is checked for every
    // transport; over stdio no other folder shares its file functions.
    runner_stdio_only: () =>
      asRunner({ extra: { ECCLIUM_STDIO_SUBJECT: 'local-stdio' } }),
    runner_server_token: () =>
      asRunner({ extra: { ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath } }),
    runner_time_zone_required: () =>
      asRunner({ extra: { ECCLIUM_TIME_ZONE: undefined } }),
    runner_policy_required: () =>
      asRunner({ extra: { ECCLIUM_POLICY_FILE: undefined } }),
    runner_routines_dir_required: () =>
      asRunner({ extra: { ECCLIUM_ROUTINES_DIR: undefined } }),
    runner_state_dir_required: () =>
      asRunner({ extra: { ECCLIUM_STATE_DIR: undefined } }),
    runner_tokens_dir_required: () =>
      asRunner({ extra: { ECCLIUM_RUNNER_TOKENS_DIR: undefined } }),
    // The login tokens would go into every backup of the folder of state.
    runner_tokens_dir_in_state_dir: () =>
      load(
        {
          ...valid(),
          ECCLIUM_STATE_DIR: stateDirPath,
          ECCLIUM_RUNNER_TOKENS_DIR: `${stateDirPath}/tokens`,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      ),
    drafts_dir_overlap: () =>
      load(
        {
          ...valid(),
          ECCLIUM_STATE_DIR: stateDirPath,
          ECCLIUM_DRAFTS_DIR: `${stateDirPath}/audit`,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      ),
    notify_file_overlap: () =>
      load(
        {
          ...valid(),
          ECCLIUM_STATE_DIR: stateDirPath,
          ECCLIUM_NOTIFY_FILE: `${stateDirPath}/audit/notices.jsonl`,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      ),
    metrics_file_overlap: () =>
      load(
        {
          ...valid(),
          ECCLIUM_STATE_DIR: stateDirPath,
          ECCLIUM_RUNNER_METRICS_FILE: `${stateDirPath}/quota/runner.prom`,
        },
        'stdio',
        memoryFiles().fs,
        undefined,
        memoryFolder().fs,
      ),
    runner_tokens_dir_platform: () =>
      withTokensDir(
        tokensDirPath,
        memoryFolder({ getuid: () => undefined }).fs,
      ),
    runner_tokens_dir_too_long: () => withTokensDir(`/${'ä'.repeat(450)}`),
    runner_tokens_dir_missing: () =>
      withTokensDir(
        tokensDirPath,
        memoryFolder({ tokens: { error: 'ENOENT' } }).fs,
      ),
    runner_tokens_dir_symlink: () =>
      withTokensDir(
        tokensDirPath,
        memoryFolder({ tokens: { symlink: true } }).fs,
      ),
    runner_tokens_dir_not_directory: () =>
      withTokensDir(
        tokensDirPath,
        memoryFolder({ tokens: { directory: false } }).fs,
      ),
    runner_tokens_dir_owner: () =>
      withTokensDir(tokensDirPath, memoryFolder({ tokens: { uid: 0 } }).fs),
    runner_tokens_dir_mode: () =>
      withTokensDir(
        tokensDirPath,
        memoryFolder({ tokens: { mode: 0o40775 } }).fs,
      ),
    runner_tokens_dir_unsafe: () =>
      withTokensDir(
        tokensDirPath,
        memoryFolder({ tokens: { error: 'EACCES' } }).fs,
      ),
    runner_token_file_missing: () => asRunner({ own: failingOpen('ENOENT') }),
    runner_token_file_symlink: () => asRunner({ own: failingOpen('ELOOP') }),
    runner_token_file_unreadable: () =>
      asRunner({ own: failingOpen('EACCES') }),
    runner_token_file_not_regular: () =>
      asRunner({
        own: memoryFiles(undefined, { stats: { isFile: false } }).fs,
      }),
    runner_token_file_owner: () =>
      asRunner({ own: memoryFiles(undefined, { stats: { uid: 0 } }).fs }),
    runner_token_file_mode: () =>
      asRunner({
        own: memoryFiles(undefined, { stats: { mode: 0o100644 } }).fs,
      }),
    runner_token_file_too_large: () =>
      asRunner({ own: memoryFiles('a'.repeat(5000)).fs }),
    runner_token_file_empty: () => asRunner({ own: memoryFiles('\n').fs }),
    runner_token_file_bom: () =>
      asRunner({ own: memoryFiles('\xef\xbb\xbfabc\n').fs }),
    runner_token_file_characters: () =>
      asRunner({ own: memoryFiles('a b\n').fs }),
    runner_token_file_unsafe: () => asRunner({ own: failingOpen('ENOTDIR') }),
    runner_token_invalid: () =>
      asRunner({ own: memoryFiles('xxREDACTEDxx\n').fs }),
    token_from_environment: () =>
      load({ ECCLIUM_CHURCHTOOLS_URL: address, [tokenVariableName]: token() }),
    writes_enabled: () =>
      withKeysDir(keysDirPath, memoryFolder().fs, 'stdio', {
        ECCLIUM_READ_ONLY: 'false',
        ECCLIUM_STATE_DIR: stateDirPath,
      }),
    snapshots_off: () =>
      withKeysDir(keysDirPath, memoryFolder().fs, 'stdio', {
        ECCLIUM_READ_ONLY: 'false',
        ECCLIUM_STATE_DIR: stateDirPath,
        ECCLIUM_SNAPSHOTS: 'off',
      }),
    echo_over_http: () =>
      load({ ...valid(), ECCLIUM_WRITE_CONFIRMATION: 'echo-allowed' }, 'http'),
    redaction_off: () => load({ ...valid(), ECCLIUM_REDACTION: 'off' }),
    toolsets_without_state_dir: () =>
      load({ ...valid(), ECCLIUM_TOOLSETS: 'persons' }),
    writes_without_state_dir: () =>
      withKeysDir(keysDirPath, memoryFolder().fs, 'stdio', {
        ECCLIUM_READ_ONLY: 'false',
      }),
    writes_without_stop_dir: () =>
      withKeysDir(
        keysDirPath,
        memoryFolder({ stop: { error: 'ENOENT' } }).fs,
        'stdio',
        { ECCLIUM_READ_ONLY: 'false', ECCLIUM_STATE_DIR: stateDirPath },
      ),
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
    yaml_debug_output_enabled: () =>
      withPolicy(policyYaml, { LOG_TOKENS: '1' }),
    policy_file_relative: () =>
      load({ ...valid(), ECCLIUM_POLICY_FILE: 'policy.yaml' }),
    // The token comes from the environment, so that only the file of the
    // policy meets the checks of the platform.
    policy_file_platform: () =>
      load(
        {
          ECCLIUM_CHURCHTOOLS_URL: address,
          [tokenVariableName]: token(),
          ECCLIUM_POLICY_FILE: policyPath,
        },
        'stdio',
        memoryFiles(policyYaml, { getuid: () => undefined }).fs,
      ),
    policy_file_missing: () =>
      load(
        { ...valid(), ECCLIUM_POLICY_FILE: policyPath },
        'stdio',
        pathFiles({ [tokenPath]: memoryFiles().fs }),
      ),
    policy_file_symlink: () => withPolicy(failingPolicy('ELOOP')),
    policy_file_unreadable: () => withPolicy(failingPolicy('EACCES')),
    policy_file_not_regular: () =>
      withPolicy(memoryFiles(policyYaml, { stats: { isFile: false } }).fs),
    policy_file_owner: () =>
      withPolicy(memoryFiles(policyYaml, { stats: { uid: 0 } }).fs),
    policy_file_mode: () =>
      withPolicy(memoryFiles(policyYaml, { stats: { mode: 0o100620 } }).fs),
    policy_file_too_large: () =>
      withPolicy(memoryFiles(policyYaml, { stats: { size: 262_145 } }).fs),
    // Bytes in latin1: the mark of UTF-8, and a byte that starts a sign of
    // two bytes followed by one that cannot end it.
    policy_file_bom: () => withPolicy(`ï»¿${policyYaml}`),
    policy_file_encoding: () => withPolicy(`${policyYaml}# Ã(\n`),
    policy_file_unsafe: () => withPolicy(failingPolicy('EIO')),
    policy_yaml_syntax: () => withPolicy(`${policyYaml}schema: policy.v1\n`),
    policy_yaml_unsupported: () => withPolicy('schema: &v policy.v1\n'),
    policy_version_unknown: () => withPolicy('schema: policy.v2\n'),
    policy_invalid: () =>
      withPolicy(
        'schema: policy.v1\ninteractive: { readBudgetPerDay: 1001 }\n',
      ),
    policy_contradiction: () =>
      withPolicy(
        `${policyYaml}    - target: { kind: wiki_category, id: 12, name: Archiv }\n      tools: [ct_wiki_page_update]\n      maxPerDay: 4\n`,
      ),
    providers_file_relative: () =>
      load({ ...valid(), ECCLIUM_PROVIDERS_FILE: 'providers.yaml' }),
    // The token comes from the environment, so that only the file of the
    // providers meets the checks of the platform.
    providers_file_platform: () =>
      load(
        {
          ECCLIUM_CHURCHTOOLS_URL: address,
          [tokenVariableName]: token(),
          ECCLIUM_PROVIDERS_FILE: providersPath,
        },
        'stdio',
        memoryFiles(providersYaml, { getuid: () => undefined }).fs,
      ),
    providers_file_missing: () =>
      load(
        { ...valid(), ECCLIUM_PROVIDERS_FILE: providersPath },
        'stdio',
        pathFiles({ [tokenPath]: memoryFiles().fs }),
      ),
    providers_file_symlink: () => withProviders(failingProviders('ELOOP')),
    providers_file_unreadable: () => withProviders(failingProviders('EACCES')),
    providers_file_not_regular: () =>
      withProviders(
        memoryFiles(providersYaml, { stats: { isFile: false } }).fs,
      ),
    providers_file_owner: () =>
      withProviders(memoryFiles(providersYaml, { stats: { uid: 0 } }).fs),
    providers_file_mode: () =>
      withProviders(
        memoryFiles(providersYaml, { stats: { mode: 0o100620 } }).fs,
      ),
    providers_file_too_large: () =>
      withProviders(memoryFiles(providersYaml, { stats: { size: 65_537 } }).fs),
    providers_file_bom: () => withProviders(`ï»¿${providersYaml}`),
    providers_file_encoding: () => withProviders(`${providersYaml}# Ã(\n`),
    providers_file_unsafe: () => withProviders(failingProviders('EIO')),
    providers_yaml_syntax: () =>
      withProviders(`${providersYaml}schema: providers.v1\n`),
    providers_yaml_unsupported: () =>
      withProviders('schema: &v providers.v1\n'),
    providers_version_unknown: () => withProviders('schema: providers.v2\n'),
    providers_invalid: () =>
      withProviders(providersYaml.replace('CH', 'Schweiz')),
    providers_key_inline: () =>
      withProviders(`${providersYaml}    apiKey: placeholder\n`),
    providers_contradiction: () =>
      withProviders(
        `${providersYaml}${providersYaml.split('\n').slice(2).join('\n')}`,
      ),
    providers_transfer_basis_missing: () =>
      withProviders(providersYaml.replace('CH', 'US')),
    providers_transfer_basis_needless: () =>
      withProviders(`${providersYaml}    transferBasis: adequacy_decision\n`),
    // The file of the ping of the runner (ADR 0009). A server checks only
    // that the path is absolute.
    ping_url_file_relative: () =>
      load({ ...valid(), ECCLIUM_RUNNER_PING_URL_FILE: 'ping-url' }),
    // Only the file of the ping, which the runner reads last, meets a
    // platform without the ID of the user.
    ping_url_file_platform: () => {
      const files = pathFiles({
        [policyPath]: memoryFiles(runnerPolicy()).fs,
        [ownTokenPath]: memoryFiles().fs,
      });
      const opened: string[] = [];
      return load(
        runnerEnv({ ECCLIUM_RUNNER_PING_URL_FILE: pingPath }),
        'runner',
        {
          ...files,
          openSync: (path, flags) => {
            opened.push(path);
            return files.openSync(path, flags);
          },
          getuid: () => (opened.includes(ownTokenPath) ? undefined : 1000),
        },
        undefined,
        memoryFolder().fs,
      );
    },
    ping_url_file_missing: () => withPing(failingOpen('ENOENT')),
    ping_url_file_symlink: () => withPing(failingOpen('ELOOP')),
    ping_url_file_unreadable: () => withPing(failingOpen('EACCES')),
    ping_url_file_not_regular: () =>
      withPing(memoryFiles(pingAddress, { stats: { isFile: false } }).fs),
    ping_url_file_owner: () =>
      withPing(memoryFiles(pingAddress, { stats: { uid: 0 } }).fs),
    ping_url_file_mode: () =>
      withPing(memoryFiles(pingAddress, { stats: { mode: 0o100644 } }).fs),
    ping_url_file_too_large: () => withPing(memoryFiles('a'.repeat(5000)).fs),
    ping_url_file_empty: () => withPing(memoryFiles('\n').fs),
    ping_url_file_bom: () =>
      withPing(memoryFiles(`\xef\xbb\xbf${pingAddress}\n`).fs),
    ping_url_file_characters: () =>
      withPing(memoryFiles(`${pingAddress} x\n`).fs),
    ping_url_file_unsafe: () => withPing(failingOpen('ENOTDIR')),
    ping_url_invalid: () =>
      withPing(memoryFiles(pingAddress.replace('https:', 'http:')).fs),
    marker_key_file_relative: () =>
      load({ ...valid(), ECCLIUM_MARKER_KEY_FILE: 'marker-key' }),
    // The token comes from the environment, so that only the key file meets
    // the checks of the platform.
    marker_key_file_platform: () =>
      load(
        {
          ECCLIUM_CHURCHTOOLS_URL: address,
          [tokenVariableName]: token(),
          ECCLIUM_MARKER_KEY_FILE: markerKeyPath,
        },
        'stdio',
        memoryFiles(undefined, { getuid: () => undefined }).fs,
      ),
    marker_key_file_missing: () =>
      load(
        { ...valid(), ECCLIUM_MARKER_KEY_FILE: markerKeyPath },
        'stdio',
        pathFiles({ [tokenPath]: memoryFiles().fs }),
      ),
    marker_key_file_symlink: () =>
      withMarkerKey(
        memoryFiles(undefined, {
          open: () => {
            throw fsError('ELOOP');
          },
        }).fs,
      ),
    marker_key_file_unreadable: () =>
      withMarkerKey(
        memoryFiles(undefined, {
          open: () => {
            throw fsError('EACCES');
          },
        }).fs,
      ),
    marker_key_file_not_regular: () =>
      withMarkerKey(memoryFiles(keyHex('m'), { stats: { isFile: false } }).fs),
    marker_key_file_owner: () =>
      withMarkerKey(memoryFiles(keyHex('m'), { stats: { uid: 0 } }).fs),
    marker_key_file_mode: () =>
      withMarkerKey(memoryFiles(keyHex('m'), { stats: { mode: 0o100640 } }).fs),
    marker_key_file_too_large: () =>
      withMarkerKey(memoryFiles('a'.repeat(5000)).fs),
    marker_key_file_empty: () => withMarkerKey(memoryFiles('\n').fs),
    marker_key_file_bom: () =>
      withMarkerKey(memoryFiles(`\xef\xbb\xbf${keyHex('m')}\n`).fs),
    marker_key_file_characters: () =>
      withMarkerKey(memoryFiles(`${keyHex('m')}\n\n`).fs),
    marker_key_file_unsafe: () =>
      withMarkerKey(
        memoryFiles(undefined, {
          open: () => {
            throw fsError('ENOTDIR');
          },
        }).fs,
      ),
    marker_key_invalid: () =>
      withMarkerKey(memoryFiles(keyHex('m').toUpperCase()).fs),
    marker_key_same: () =>
      withMarkerKey(keyFile('a'), { current: keyFile('a') }),
    marker_key_missing: () => writingToWiki({ key: true }),
    inquiries_missing: () => writingToWiki({ inquiries: true }),
  };

  it.each([...configProblemCodes])('can report the problem %s', (code) => {
    expect(codes(cases[code]())).toEqual([code]);
    expect(isEventName(`config_${code}`)).toBe(true);
  });

  // Snapshots matter only to a server that writes, so their warning comes
  // with the one that says writing is on (ADR 0029, ADR 0031).
  it.each([...configWarningCodes])('can report the warning %s', (code) => {
    const result = cases[code]();
    expect(result.ok).toBe(true);
    expect(result.report.warnings).toEqual(
      code === 'snapshots_off' ? ['writes_enabled', code] : [code],
    );
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
      ECCLIUM_EGRESS_ALLOW_LAN: 'x',
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
      ['egress_proxy_invalid', 'ECCLIUM_EGRESS_PROXY'],
      ['tls_check_disabled', 'NODE_TLS_REJECT_UNAUTHORIZED'],
      ['debug_output_enabled', 'NODE_DEBUG'],
      ['tls_keylog_enabled'],
      ['tls_trace_enabled', 'NODE_OPTIONS'],
      ['unsupported_variable', 'ECCLIUM_EGRESS_ALLOW_LAN'],
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
        ECCLIUM_EGRESS: value,
        HTTPS_PROXY: `http://${value}@proxy.example:3128`,
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
      ECCLIUM_KEYS_DIR: keysDirPath,
      ECCLIUM_STATE_DIR: stateDirPath,
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

describe('loadConfig and the key files for pseudonyms', () => {
  it('needs neither of them', () => {
    const result = load(valid());
    expect(result.ok && result.config.pseudonymKey).toBeUndefined();
    expect(result.ok && result.config.pseudonymKeyPrevious).toBeUndefined();
  });

  it('reads a key with LF, with CR LF and without a line ending', () => {
    for (const ending of ['\n', '\r\n', '']) {
      const result = withKeys(keyFile('a', ending));
      expect(result.ok, JSON.stringify(ending)).toBe(true);
      if (!result.ok) continue;
      expect(
        result.config.pseudonymKey?.sameAs(new KeyMaterial(keyHex('a'))),
      ).toBe(true);
      expect(setting(result, 'pseudonymKey')).toMatchObject({
        origin: 'file',
        shown: { kind: 'hidden' },
      });
      expect(setting(result, 'pseudonymKeyPrevious')).toMatchObject({
        origin: 'unset',
      });
      expect(result.report.warnings).toEqual([]);
    }
  });

  it('reads both keys while the operator changes them, and warns', () => {
    const result = withKeys(keyFile('new'), keyFile('old'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.config.pseudonymKey?.sameAs(new KeyMaterial(keyHex('new'))),
    ).toBe(true);
    expect(
      result.config.pseudonymKeyPrevious?.sameAs(
        new KeyMaterial(keyHex('old')),
      ),
    ).toBe(true);
    expect(setting(result, 'pseudonymKeyPrevious')).toMatchObject({
      origin: 'file',
      shown: { kind: 'hidden' },
    });
    expect(result.report.warnings).toEqual(['pseudonym_key_change']);
  });

  it('names the variable of the file that fails', () => {
    expect(problems(withKeys(keyFile('new'), memoryFiles('\n').fs))).toEqual([
      ['pseudonym_key_file_empty', 'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE'],
    ]);
    expect(problems(withKeys(memoryFiles('\n').fs, keyFile('old')))).toEqual([
      ['pseudonym_key_file_empty', 'ECCLIUM_PSEUDONYM_KEY_FILE'],
    ]);
  });

  it.each([
    ['63 digits', keyHex('a').slice(1)],
    ['65 digits', `${keyHex('a')}0`],
    ['capitals', keyHex('a').toUpperCase()],
    ['only zeros', '0'.repeat(64)],
  ])('refuses a key of %s', (_name, content) => {
    const result = withKeys(memoryFiles(`${content}\n`).fs);
    expect(problems(result)).toEqual([
      ['pseudonym_key_invalid', 'ECCLIUM_PSEUDONYM_KEY_FILE'],
    ]);
    expect(setting(result, 'pseudonymKey')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  it('names the previous key alone also when its file has a problem', () => {
    expect(problems(withKeys(undefined, memoryFiles('\n').fs))).toEqual([
      ['pseudonym_key_file_empty', 'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE'],
      [
        'pseudonym_key_previous_without_current',
        'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE',
      ],
    ]);
  });

  it('refuses the previous key alone and the same key twice', () => {
    for (const result of [
      withKeys(undefined, keyFile('a')),
      withKeys(keyFile('a'), keyFile('a')),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.report.warnings).toEqual([]);
      expect(setting(result, 'pseudonymKeyPrevious')).toMatchObject({
        origin: 'invalid',
        shown: { kind: 'none' },
      });
    }
  });

  it('takes the key files over HTTP as well', () => {
    expect(withKeys(keyFile('new'), keyFile('old'), 'http').ok).toBe(true);
  });

  it('holds neither a path nor a key in the report or the printed configuration', () => {
    const result = withKeys(keyFile('new'), keyFile('old'));
    expect(result.ok).toBe(true);
    const printed = [
      JSON.stringify(result.report),
      inspect(result.report, { depth: Infinity }),
      result.ok ? JSON.stringify(result.config) : '',
      result.ok ? inspect(result.config, { depth: Infinity }) : '',
    ];
    for (const text of printed) {
      for (const secret of [
        keyPath,
        previousKeyPath,
        keyHex('new'),
        keyHex('old'),
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(result.ok && JSON.stringify(result.config)).toContain(
      '"pseudonymKey":"[REDACTED]"',
    );
  });
});

describe('loadConfig and the key file of the check codes', () => {
  it('needs none', () => {
    const result = load(valid());
    expect(result.ok && result.config.markerKey).toBeUndefined();
    expect(setting(result, 'markerKey')).toMatchObject({
      origin: 'unset',
      shown: { kind: 'none' },
    });
  });

  it('reads a key with LF, with CR LF and without a line ending', () => {
    for (const ending of ['\n', '\r\n', '']) {
      const result = withMarkerKey(keyFile('m', ending));
      expect(result.ok, JSON.stringify(ending)).toBe(true);
      if (!result.ok) continue;
      expect(
        result.config.markerKey?.sameAs(new KeyMaterial(keyHex('m'))),
      ).toBe(true);
      expect(setting(result, 'markerKey')).toMatchObject({
        origin: 'file',
        shown: { kind: 'hidden' },
      });
      expect(result.report.warnings).toEqual([]);
    }
  });

  it.each([
    ['63 digits', keyHex('m').slice(1)],
    ['65 digits', `${keyHex('m')}0`],
    ['capitals', keyHex('m').toUpperCase()],
    ['only zeros', '0'.repeat(64)],
  ])('refuses a key of %s', (_name, content) => {
    const result = withMarkerKey(memoryFiles(`${content}\n`).fs);
    expect(problems(result)).toEqual([
      ['marker_key_invalid', 'ECCLIUM_MARKER_KEY_FILE'],
    ]);
    expect(setting(result, 'markerKey')).toMatchObject({
      origin: 'invalid',
      shown: { kind: 'none' },
    });
  });

  // The two secrets live apart: the key of the pseudonyms changes now and
  // then, the one of the check codes never (ADR 0032).
  it('refuses the key of the pseudonyms, also the previous one', () => {
    for (const result of [
      withMarkerKey(keyFile('a'), { current: keyFile('a') }),
      withMarkerKey(keyFile('a'), {
        current: keyFile('b'),
        previous: keyFile('a'),
      }),
    ]) {
      expect(problems(result)).toEqual([
        ['marker_key_same', 'ECCLIUM_MARKER_KEY_FILE'],
      ]);
      expect(setting(result, 'markerKey')).toMatchObject({
        origin: 'invalid',
        shown: { kind: 'none' },
      });
    }
    expect(withMarkerKey(keyFile('m'), { current: keyFile('a') }).ok).toBe(
      true,
    );
  });

  it('takes the key file over HTTP as well', () => {
    expect(withMarkerKey(keyFile('m'), undefined, 'http').ok).toBe(true);
  });

  it('holds neither the path nor the key in the report or the printed configuration', () => {
    const result = withMarkerKey(keyFile('m'));
    expect(result.ok).toBe(true);
    const printed = [
      JSON.stringify(result.report),
      inspect(result.report, { depth: Infinity }),
      result.ok ? JSON.stringify(result.config) : '',
      result.ok ? inspect(result.config, { depth: Infinity }) : '',
    ];
    for (const text of printed) {
      expect(text).not.toContain(markerKeyPath);
      expect(text).not.toContain(keyHex('m'));
    }
    expect(result.ok && JSON.stringify(result.config)).toContain(
      '"markerKey":"[REDACTED]"',
    );
  });
});

// A server that writes to the wiki marks what it adds (ADR 0032).
describe('loadConfig and a server that writes to the wiki', () => {
  it('starts with the key of the check codes and whom to ask', () => {
    for (const toolsets of ['wiki', 'calendars,wiki']) {
      const result = writingToWiki({}, toolsets);
      expect(problems(result), toolsets).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it('stops without the key or without whom to ask, and names both', () => {
    expect(problems(writingToWiki({ key: true }))).toEqual([
      ['marker_key_missing', 'ECCLIUM_MARKER_KEY_FILE'],
    ]);
    expect(setting(writingToWiki({ key: true }), 'markerKey')).toMatchObject({
      origin: 'missing',
    });
    expect(problems(writingToWiki({ inquiries: true }))).toEqual([
      ['inquiries_missing', 'ECCLIUM_POLICY_FILE'],
    ]);
    expect(problems(writingToWiki({ key: true, inquiries: true }))).toEqual([
      ['inquiries_missing', 'ECCLIUM_POLICY_FILE'],
      ['marker_key_missing', 'ECCLIUM_MARKER_KEY_FILE'],
    ]);
    // all holds the toolset wiki.
    expect(codes(writingToWiki({ key: true }, 'all'))).toContain(
      'marker_key_missing',
    );
  });

  it('names only the problem of a policy file that is refused', () => {
    expect(codes(writingToWiki({}, 'wiki')).includes('inquiries_missing')).toBe(
      false,
    );
    const refused = load(
      {
        ...valid(),
        ECCLIUM_READ_ONLY: 'false',
        ECCLIUM_TOOLSETS: 'wiki',
        ECCLIUM_KEYS_DIR: keysDirPath,
        ECCLIUM_POLICY_FILE: 'policy.yaml',
      },
      'stdio',
    );
    expect(codes(refused)).not.toContain('inquiries_missing');
  });

  it('needs neither for a server that only reads or writes no wiki', () => {
    expect(load(valid()).ok).toBe(true);
    expect(load({ ...valid(), ECCLIUM_TOOLSETS: 'wiki' }).ok).toBe(true);
    expect(
      problems(writingToWiki({ key: true, inquiries: true }, 'calendars')),
    ).toEqual([]);
  });
});

describe('loadConfig and the proxy of outbound connections (ADR 0035)', () => {
  const proxy = 'http://egress:3128';

  it('takes the proxy for every transport and shows host and port', () => {
    for (const transport of ['stdio', 'http'] as const) {
      const result = load(
        { ...valid(), ECCLIUM_EGRESS_PROXY: proxy },
        transport,
      );
      expect(result.ok && result.config.egressProxy, transport).toBe(proxy);
      expect(result.ok && result.config.egressOff, transport).toBe(false);
      expect(setting(result, 'egressProxy'), transport).toEqual({
        key: 'egressProxy',
        variable: 'ECCLIUM_EGRESS_PROXY',
        origin: 'environment',
        shown: { kind: 'proxy', host: 'egress', port: '3128' },
      });
    }
  });

  it('connects directly without the variable, for the server', () => {
    const result = load(valid());
    expect(result.ok && result.config.egressProxy).toBeUndefined();
    expect(setting(result, 'egressProxy')?.origin).toBe('unset');
    expect(setting(result, 'egress')?.origin).toBe('unset');
  });

  it('starts the runner with a proxy and without a warning', () => {
    const result = asRunner({
      extra: { ECCLIUM_EGRESS: undefined, ECCLIUM_EGRESS_PROXY: proxy },
    });
    expect(problems(result)).toEqual([]);
    expect(result.ok && result.config.egressProxy).toBe(proxy);
    expect(result.report.warnings).toEqual([]);
  });

  it('starts the runner without a proxy only with off, and warns', () => {
    const without = asRunner({ extra: { ECCLIUM_EGRESS: undefined } });
    expect(problems(without)).toEqual([
      ['runner_egress_required', 'ECCLIUM_EGRESS_PROXY'],
    ]);
    const off = asRunner();
    expect(off.ok && off.config.egressOff).toBe(true);
    expect(off.report.warnings).toEqual(['egress_off']);
    expect(setting(off, 'egress')?.shown).toEqual({
      kind: 'choice',
      value: 'off',
    });
  });

  it('takes off for the server without a warning, since it changes nothing there', () => {
    const result = load({ ...valid(), ECCLIUM_EGRESS: 'off' });
    expect(result.ok && result.config.egressOff).toBe(true);
    expect(result.report.warnings).toEqual([]);
  });

  it('refuses off together with a proxy, and any value but off', () => {
    expect(
      problems(
        load({
          ...valid(),
          ECCLIUM_EGRESS_PROXY: proxy,
          ECCLIUM_EGRESS: 'off',
        }),
      ),
    ).toEqual([['egress_off_with_proxy', 'ECCLIUM_EGRESS']]);
    for (const value of ['on', 'OFF', 'no']) {
      const result = load({ ...valid(), ECCLIUM_EGRESS: value });
      expect(problems(result), value).toEqual([
        ['invalid_choice', 'ECCLIUM_EGRESS'],
      ]);
      expect(setting(result, 'egress')?.origin, value).toBe('invalid');
    }
    // An invalid proxy is reported once, not also as a missing one.
    expect(
      problems(
        asRunner({
          extra: { ECCLIUM_EGRESS: undefined, ECCLIUM_EGRESS_PROXY: 'egress' },
        }),
      ),
    ).toEqual([['egress_proxy_invalid', 'ECCLIUM_EGRESS_PROXY']]);
  });

  it('warns about a proxy of Node.js in its options as well', () => {
    expect(started(['--use-env-proxy']).report.warnings).toEqual([
      'environment_proxy_ignored',
    ]);
    expect(
      load({ ...valid(), NODE_OPTIONS: '--use_env_proxy' }).report.warnings,
    ).toEqual(['environment_proxy_ignored']);
    expect(load({ ...valid(), all_proxy: '' }).report.warnings).toEqual([]);
  });
});

describe('loadConfig and the ping of the runner (ADR 0009)', () => {
  it('reads the address for the runner, keeps it as a secret and shows host and port', () => {
    const result = withPing(memoryFiles(`${pingAddress}\n`).fs);
    expect(problems(result)).toEqual([]);
    const url = result.ok ? result.config.runnerPingUrl : undefined;
    expect(url).toBeInstanceOf(Secret);
    expect(String(url)).toBe('[REDACTED]');
    expect(setting(result, 'runnerPingUrl')).toEqual({
      key: 'runnerPingUrl',
      variable: 'ECCLIUM_RUNNER_PING_URL_FILE',
      origin: 'file',
      shown: { kind: 'origin', host: 'ping.example', port: '' },
    });
    expect(JSON.stringify(result)).not.toContain(pingCheck);
    expect(inspect(result, { depth: 10 })).not.toContain(pingCheck);
  });

  it('shows a port that is not the default', () => {
    const result = withPing(
      memoryFiles(pingAddress.replace('ping.example', 'ping.example:8443')).fs,
    );
    expect(setting(result, 'runnerPingUrl')?.shown).toEqual({
      kind: 'origin',
      host: 'ping.example',
      port: '8443',
    });
  });

  it('never reads the file for a server, which checks the form of the path', () => {
    for (const transport of ['stdio', 'http'] as const) {
      const file = memoryFiles(pingAddress);
      const result = load(
        { ...valid(), ECCLIUM_RUNNER_PING_URL_FILE: pingPath },
        transport,
        pathFiles({ [tokenPath]: memoryFiles().fs, [pingPath]: file.fs }),
      );
      expect(problems(result), transport).toEqual([]);
      expect(file.opened, transport).toEqual([]);
      expect(result.ok && result.config.runnerPingUrl).toBeUndefined();
      expect(setting(result, 'runnerPingUrl')).toMatchObject({
        origin: 'environment',
        shown: { kind: 'hidden' },
      });
    }
  });

  it('has no address without the variable', () => {
    const result = asRunner();
    expect(result.ok && result.config.runnerPingUrl).toBeUndefined();
    expect(setting(result, 'runnerPingUrl')).toMatchObject({
      origin: 'unset',
      shown: { kind: 'none' },
    });
  });

  it('refuses an empty value and names no file', () => {
    const result = withPing(memoryFiles(pingAddress).fs, {
      ECCLIUM_RUNNER_PING_URL_FILE: '',
    });
    expect(problems(result)).toEqual([
      ['empty_value', 'ECCLIUM_RUNNER_PING_URL_FILE'],
    ]);
    expect(setting(result, 'runnerPingUrl')?.origin).toBe('invalid');
  });

  it('keeps the file of the notices off the file of the ping, which a line would break', () => {
    const result = withPing(memoryFiles(pingAddress).fs, {
      ECCLIUM_NOTIFY_FILE: pingPath,
    });
    expect(problems(result)).toEqual([
      ['notify_file_overlap', 'ECCLIUM_NOTIFY_FILE'],
    ]);
  });

  it('keeps the metrics file off the file of the ping, which it would replace', () => {
    const result = withPing(memoryFiles(pingAddress).fs, {
      ECCLIUM_RUNNER_METRICS_FILE: pingPath,
    });
    expect(problems(result)).toEqual([
      ['metrics_file_overlap', 'ECCLIUM_RUNNER_METRICS_FILE'],
    ]);
  });

  it('names no part of a refused address', () => {
    const result = withPing(memoryFiles(`${pingAddress}?key=${pingCheck}`).fs);
    expect(problems(result)).toEqual([
      ['ping_url_invalid', 'ECCLIUM_RUNNER_PING_URL_FILE'],
    ]);
    expect(JSON.stringify(result)).not.toContain(pingCheck);
  });
});
