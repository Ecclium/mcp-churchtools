import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig,
  tokenVariableName,
  type Transport,
} from '@ecclium/mcp-churchtools-core';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exitCodes } from './exit-codes.js';
import { run, type RunOptions } from './main.js';
import { problemText, warningText } from './messages/index.js';
import {
  helpLines,
  internalErrorText,
  usageLine,
  type UsageProblem,
  usageProblemTexts,
} from './output/index.js';
import type { WriteSyncFn } from './send.js';

type Environment = Record<string, string | undefined>;

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly {
    readonly stream: number;
    readonly count: number;
  }[];
}

const decoder = new TextDecoder();

/**
 * Runs the command line with a fake writeSync that records every call
 * before it answers. `fail` may throw for a descriptor, and `execArgv`
 * stands for the options Node.js was started with, by default none.
 */
const capture = (
  args: readonly string[],
  environment: Environment,
  options: Omit<RunOptions, 'writeSync'> & {
    readonly fail?: (fd: number) => void;
    readonly execArgv?: readonly string[];
  } = {},
): Captured => {
  const calls: { stream: number; count: number }[] = [];
  const taken = new Map<number, number[]>();
  const writeSync: WriteSyncFn = (...given) => {
    const [fd, buffer, offset, length] = given;
    calls.push({ stream: fd, count: given.length });
    options.fail?.(fd);
    const bytes = taken.get(fd) ?? [];
    for (const byte of buffer.subarray(offset, offset + length)) {
      bytes.push(byte);
    }
    taken.set(fd, bytes);
    return length;
  };
  const code = run(args, environment, options.execArgv ?? [], {
    tokenFiles: options.tokenFiles,
    load: options.load,
    writeSync,
  });
  // Every command but policy init answers at once.
  if (typeof code !== 'number') throw new Error('expected an exit code');
  const text = (fd: number): string =>
    decoder.decode(new Uint8Array(taken.get(fd) ?? []));
  return { code, stdout: text(1), stderr: text(2), calls };
};

/** Letters and digits only, so that it fits a name, a host or an option. */
const plain = (): string => makeCanary('token').cores[0] ?? '';

const address = 'https://example.church.tools';
const check = ['config', 'check'];

const valid =
  'Die Konfiguration ist gültig. ChurchTools wurde nicht angefragt. Ob ChurchTools das Token annimmt, zeigt erst ein Aufruf von ‹ct_whoami›.';
const invalid =
  'Mit dieser Konfiguration startet Ecclium nicht. ChurchTools wurde nicht angefragt. Beheben Sie die Probleme und prüfen Sie dann erneut mit ‹ecclium config check›.';

const lastLine = (text: string): string | undefined =>
  text.trimEnd().split('\n').at(-1);

describe('the exit codes', () => {
  // After sysexits.h, and never 1, which Node.js gives a process that ends
  // with an uncaught exception. The codes after a signal are 128 and its
  // number, as a shell reports them.
  it('keep their numbers', () => {
    expect(exitCodes).toEqual({
      ok: 0,
      usage: 64,
      dataError: 65,
      noInput: 66,
      unavailable: 69,
      internal: 70,
      ioError: 74,
      tempFail: 75,
      noPermission: 77,
      invalidConfig: 78,
      interrupted: 130,
      terminated: 143,
    });
    expect(Object.isFrozen(exitCodes)).toBe(true);
  });
});

describe('the command line', () => {
  // The name of the folder holds a canary, so that a path in any output
  // would show.
  const folderCanary = plain();
  let folder = '';
  let token = '';
  let goodPath = '';
  let loosePath = '';

  const tokenFile = (name: string, content: string, mode: number): string => {
    const path = join(folder, name);
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  };

  const validEnvironment = (): Environment => ({
    ECCLIUM_CHURCHTOOLS_URL: address,
    ECCLIUM_CHURCHTOOLS_TOKEN_FILE: goodPath,
  });

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), `ecclium-cli-${folderCanary}-`));
    token = makeCanary('token').value;
    goodPath = tokenFile('token', `${token}\n`, 0o600);
    loosePath = tokenFile('loose', `${makeCanary('token').value}\n`, 0o644);
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('writes the report of a valid configuration to stdout only', () => {
    const result = capture(check, validEnvironment());
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(
      /^Prüfung der Konfiguration für den Betrieb über stdio\n/,
    );
    expect(lastLine(result.stdout)).toBe(valid);
    expect(result.stdout).not.toContain(token);
    for (const call of result.calls) {
      expect(call).toEqual({ stream: 1, count: 4 });
    }
  });

  it('puts the notices of the start into the report, not on stderr', () => {
    const result = capture(check, {
      ECCLIUM_CHURCHTOOLS_URL: address,
      [tokenVariableName]: makeCanary('token').value,
      ECCLIUM_REDACTION: 'off',
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('\nBeim Start meldet Ecclium:\n');
  });

  // The search tools need the folder of the audit file over stdio, and the
  // check says so before any start (ADR 0028, ADR 0060).
  it('refuses the toolset persons without the folder of the audit file', () => {
    const result = capture(check, {
      ECCLIUM_CHURCHTOOLS_URL: address,
      [tokenVariableName]: makeCanary('token').value,
      ECCLIUM_TOOLSETS: 'persons',
    });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      problemText({
        code: 'toolsets_without_state_dir',
        variable: 'ECCLIUM_STATE_DIR',
      }),
    );
    expect(lastLine(result.stdout)).toBe(invalid);
  });

  // The same notices as the start over stdio, for the variables and for
  // the options Node.js was started with, and never a path.
  it.each<[string, () => Environment, readonly string[]]>([
    [
      'a certificate in the environment',
      () => ({
        ...validEnvironment(),
        NODE_EXTRA_CA_CERTS: join(folder, 'ca.pem'),
      }),
      [],
    ],
    ['an option of Node.js', validEnvironment, ['--use_system_ca']],
  ])(
    'warns in the report about a trust store extended by %s',
    (_, environment, execArgv) => {
      const result = capture(check, environment(), { execArgv });
      expect(result.code).toBe(exitCodes.ok);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(
        `  - ${warningText('trust_store_extended')}\n`,
      );
      expect(result.stdout).not.toContain(folderCanary);
    },
  );

  it('refuses a key log among the options of Node.js without its path', () => {
    const result = capture(check, validEnvironment(), {
      execArgv: ['--tls-keylog', join(folder, 'keys')],
    });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stdout).toContain(
      `  - ${problemText({ code: 'tls_keylog_enabled' })}\n`,
    );
    expect(result.stdout + result.stderr).not.toContain(folderCanary);
  });

  it.each([[check], [['--jsn']]])(
    'takes the token out of the environment it was given, for %j',
    (args) => {
      const lower = tokenVariableName.toLowerCase();
      const environment: Environment = {
        ...validEnvironment(),
        [tokenVariableName]: makeCanary('token').value,
        [lower]: makeCanary('token').value,
      };
      capture(args, environment);
      expect(Object.keys(environment)).toEqual([
        'ECCLIUM_CHURCHTOOLS_URL',
        'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
      ]);
    },
  );

  it.each<[readonly string[], UsageProblem]>([
    [[], 'command'],
    [['config'], 'command'],
    [['check'], 'command'],
    [['check', 'config'], 'command'],
    [['config', 'check', 'extra'], 'command'],
    [['config', 'check', '--', '--show-values'], 'command'],
    [['other', '--help'], 'command'],
    [['config', 'check', 'extra', '-h'], 'command'],
    [['--jsn'], 'option'],
    [['config', 'check', '--jsn'], 'option'],
    [['config', 'check', '-x'], 'option'],
    [['config', 'check', '--no-show-values'], 'option'],
    [['config', 'check', '--help=1'], 'value'],
    [['config', 'check', '--show-values=x'], 'value'],
    [['config', 'check', '-hh'], 'repeated'],
    [['config', 'check', '-h', '--help'], 'repeated'],
    [['config', 'check', '--show-values', '--show-values'], 'repeated'],
    [['audit'], 'command'],
    [['audit', 'check'], 'command'],
    [['audit', 'verify', 'extra'], 'command'],
    [['audit', 'show', 'person:1'], 'command'],
    [['audit', 'verify', '--show-values'], 'option'],
    [['config', 'check', '--log', 'x'], 'option'],
    [['audit', 'show', '--log=x'], 'option'],
    [['audit', 'verify', '--object=person:1'], 'option'],
    [['audit', 'verify', '--log'], 'value'],
    [['audit', 'show', '--object'], 'value'],
    [['audit', 'show', '--since', '--until'], 'value'],
    [['audit', 'show', '--object', 'a', '--object', 'b'], 'repeated'],
    [['undo'], 'command'],
    [['undo', 'a', 'b'], 'command'],
    [['undo', '--overwrite'], 'command'],
    [['undo', 'x', '--overwrite=1'], 'value'],
    [['undo', 'x', '--log', 'y'], 'option'],
    [['config', 'check', '--overwrite'], 'option'],
    [['queue'], 'command'],
    [['queue', 'list', 'x'], 'command'],
    [['queue', 'show'], 'command'],
    [['queue', 'reject', 'a', 'b'], 'command'],
    [['queue', 'approve'], 'command'],
    [['queue', 'approve', 'a', 'b'], 'command'],
    [['queue', 'approve', 'x', '--overwrite'], 'option'],
    [['queue', 'accept', 'x'], 'command'],
    [['queue', 'reject', 'x', '--overwrite'], 'option'],
  ])('refuses %j as %s with a fixed text on stderr', (args, problem) => {
    const result = capture(args, validEnvironment());
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${usageProblemTexts[problem]}\n${usageLine}\n`);
  });

  it.each([
    [['--help']],
    [['-h']],
    [['config', '--help']],
    [['config', 'check', '-h']],
    [['config', 'check', '--show-values', '--help']],
    [['audit', '--help']],
    [['audit', 'verify', '-h']],
    [['audit', 'show', '--object', 'person:1', '--help']],
    [['undo', '--help']],
    [['undo', 'x', '-h']],
    [['queue', '--help']],
    [['queue', 'show', 'x', '-h']],
  ])('writes the help for %j to stdout', (args) => {
    const result = capture(args, {});
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${helpLines.join('\n')}\n`);
  });

  it.each([
    [['audit', 'verify']],
    [['audit', 'verify', '--log', '-', '--log', 'x']],
    [['audit', 'show', '--object', 'person:1', '--since', '2026-10-01']],
  ])('runs %j with the folder of state alone as its configuration', (args) => {
    // Without the folder of state the command stops before it reads a log
    // or a file, and the address and the token play no part.
    const result = capture(args, validEnvironment());
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n')[0]).toBe(
      'Die Konfiguration hat 1 Problem:',
    );
  });

  it('shows the host only with --show-values', () => {
    expect(capture(check, validEnvironment()).stdout).not.toContain(
      'example.church.tools',
    );
    expect(
      capture([...check, '--show-values'], validEnvironment()).stdout,
    ).toContain(
      '  https://example.church.tools (aus ‹ECCLIUM_CHURCHTOOLS_URL›)',
    );
  });

  it.each([
    ['a missing address', () => ({ ECCLIUM_CHURCHTOOLS_TOKEN_FILE: goodPath })],
    [
      'an unknown variable',
      () => ({ ...validEnvironment(), ECCLIUM_FOO: 'x' }),
    ],
    [
      'a token file that others may read',
      () => ({
        ...validEnvironment(),
        ECCLIUM_CHURCHTOOLS_TOKEN_FILE: loosePath,
      }),
    ],
  ])('reports %s as invalid on stdout', (_, environment) => {
    const result = capture(check, environment());
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stderr).toBe('');
    expect(lastLine(result.stdout)).toBe(invalid);
  });

  describe('after an internal error', () => {
    const canary = plain();
    const traps: string[] = [];
    // A proxy whose handler records every trap that is looked up.
    const recording = (): object =>
      new Proxy(
        {},
        new Proxy(
          {},
          {
            get: (_target, name) => {
              traps.push(String(name));
              return undefined;
            },
          },
        ),
      );

    it.each<[string, () => { environment: Environment; options: RunOptions }]>([
      [
        'an error from the loader',
        () => ({
          environment: validEnvironment(),
          options: {
            load: () => {
              throw new Error(canary);
            },
          },
        }),
      ],
      [
        'a string from the loader',
        () => ({
          environment: validEnvironment(),
          options: {
            load: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
              throw canary;
            },
          },
        }),
      ],
      [
        'a proxy from the loader',
        () => ({
          environment: validEnvironment(),
          options: {
            load: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
              throw recording();
            },
          },
        }),
      ],
      [
        'an environment that is a proxy',
        () => ({ environment: recording() as Environment, options: {} }),
      ],
      [
        'a variable behind a getter',
        () => {
          const environment = validEnvironment();
          Object.defineProperty(environment, 'ECCLIUM_READ_ONLY', {
            enumerable: true,
            get: () => canary,
          });
          return { environment, options: {} };
        },
      ],
    ])('after %s writes one fixed line to stderr', (_, made) => {
      traps.length = 0;
      const { environment, options } = made();
      const result = capture(check, environment, options);
      expect(result.code).toBe(exitCodes.internal);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`${internalErrorText}\n`);
      expect(result.stderr).not.toContain(canary);
      expect(traps).toEqual([]);
    });

    it('gives 70 when the output cannot be made', () => {
      expect(
        run(check, validEnvironment(), [], {
          writeSync: 'fd' as unknown as WriteSyncFn,
        }),
      ).toBe(exitCodes.internal);
    });
  });

  it.each<[string, (canary: string) => readonly string[]]>([
    ['as the name of an option', (canary) => [...check, `--${canary}`]],
    ['as a short option', (canary) => [...check, `-${canary}`]],
    ['as an option with a value', (canary) => [...check, `--token=${canary}`]],
    ['as a word', (canary) => [...check, canary]],
    ['after a flag', (canary) => [...check, '--show-values', canary]],
    [
      'after the end of the options',
      (canary) => [...check, '--', `--${canary}`],
    ],
    ['as the command', (canary) => [canary]],
    ['before the help', (canary) => [canary, '--help']],
  ])('never shows an argument given %s', (_, args) => {
    const canary = plain();
    const result = capture(args(canary), validEnvironment());
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stdout + result.stderr).not.toContain(canary);
  });

  it.each([false, true])(
    'never shows a value of the environment, with values shown: %s',
    (showValues) => {
      const canary = plain();
      const result = capture(showValues ? [...check, '--show-values'] : check, {
        ECCLIUM_CHURCHTOOLS_URL: `https://user:${canary}@example.church.tools`,
        ECCLIUM_CHURCHTOOLS_TOKEN_FILE: goodPath,
        ECCLIUM_READ_ONLY: canary,
        ECCLIUM_REDACTION: canary,
        ECCLIUM_TOOLSETS: canary,
        ECCLIUM_STDIO_SUBJECT: `Z${canary}`,
        ECCLIUM_LOG_LEVEL: canary,
        ECCLIUM_FOO: canary,
        [tokenVariableName.toLowerCase()]: canary,
      });
      expect(result.code).toBe(exitCodes.invalidConfig);
      expect(result.stdout).toContain('Die Konfiguration hat 8 Probleme:');
      expect(result.stdout + result.stderr).not.toContain(canary);
    },
  );

  it.each([
    [
      'credentials',
      (canary: string) => `https://user:${canary}@example.church.tools`,
    ],
    ['a path', (canary: string) => `${address}/${canary}`],
    [
      'a dot at the end of the host',
      (canary: string) => `https://${canary.toLowerCase()}.church.tools.`,
    ],
  ])('never shows an address with %s, even with values shown', (_, url) => {
    const canary = plain();
    const result = capture([...check, '--show-values'], {
      ...validEnvironment(),
      ECCLIUM_CHURCHTOOLS_URL: url(canary),
    });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stdout + result.stderr).not.toContain(canary);
    expect(result.stdout + result.stderr).not.toContain(canary.toLowerCase());
  });

  it('counts names that hold hidden characters and never writes them', () => {
    const names = [
      'ECCLIUM_A\u000aQZ1',
      'ECCLIUM_\u001b[31mQZ2',
      'ECCLIUM_\u202eQZ3',
      'ECCLIUM_\u00dcQZ4',
    ];
    const environment = validEnvironment();
    for (const name of names) environment[name] = 'x';
    const result = capture(check, environment);
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stdout).toContain('Die Konfiguration hat 4 Probleme:');
    // Each name is counted under the one text without a name, so none of
    // its characters reaches the report.
    const unnamed = `  - ${problemText({ code: 'unknown_variable' })}`;
    const lines = result.stdout.trimEnd().split('\n');
    const start = lines.indexOf('Die Konfiguration hat 4 Probleme:');
    expect(lines.slice(start + 1, start + 5)).toEqual([
      unnamed,
      unnamed,
      unnamed,
      unnamed,
    ]);
    expect(result.stdout).not.toMatch(/QZ\d/);
  });

  it.each([
    ['a valid file', () => goodPath, exitCodes.ok],
    [
      'a missing file',
      () => join(folder, 'missing', 'token'),
      exitCodes.invalidConfig,
    ],
    ['a file that others may read', () => loosePath, exitCodes.invalidConfig],
  ])('never shows the path of %s', (_, path, code) => {
    const result = capture([...check, '--show-values'], {
      ...validEnvironment(),
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: path(),
    });
    expect(result.code).toBe(code);
    expect(result.stdout + result.stderr).not.toContain(folderCanary);
    expect(result.stdout + result.stderr).not.toContain(folder);
  });

  it('writes the same report for a short and a long token', () => {
    const short = tokenFile('short', 'Q\n', 0o600);
    const long = tokenFile('long', `${'q'.repeat(4096)}\n`, 0o600);
    const first = capture(check, {
      ...validEnvironment(),
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: short,
    });
    const second = capture(check, {
      ...validEnvironment(),
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: long,
    });
    expect(first.code).toBe(exitCodes.ok);
    expect(second.code).toBe(exitCodes.ok);
    expect(second.stdout).toBe(first.stdout);
  });

  it('writes the same report for two hosts', () => {
    const one = plain().toLowerCase();
    const two = plain().toLowerCase();
    const first = capture(check, {
      ...validEnvironment(),
      ECCLIUM_CHURCHTOOLS_URL: `https://${one}.example.org:8443`,
    });
    const second = capture(check, {
      ...validEnvironment(),
      ECCLIUM_CHURCHTOOLS_URL: `https://${two}.example.org:8443`,
    });
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).not.toContain(one);
  });

  it.each([
    ['valid', validEnvironment, exitCodes.ok],
    ['invalid', () => ({}), exitCodes.invalidConfig],
  ])(
    'keeps the exit code of a %s configuration when stdout is gone',
    (_, environment, code) => {
      const result = capture(check, environment(), {
        fail: (fd) => {
          if (fd === 1)
            throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
        },
      });
      expect(result.code).toBe(code);
      expect(result.stderr).toBe('');
      expect(result.calls).toEqual([{ stream: 1, count: 4 }]);
    },
  );
});

describe('ecclium policy init in the command line', () => {
  // The command talks to ChurchTools, so run gives a promise for it; its
  // own tests stand in policy/init.test.ts.
  const runInit = async (args: readonly string[], options: RunOptions = {}) => {
    const taken: number[] = [];
    const writeSync: WriteSyncFn = (_fd, buffer, offset, length) => {
      taken.push(...buffer.subarray(offset, offset + length));
      return length;
    };
    const code = await run(args, {}, [], { ...options, writeSync });
    return { code, stderr: decoder.decode(new Uint8Array(taken)) };
  };

  it('hands the call to the command, which needs --interactive', async () => {
    const result = await runInit(['policy', 'init']);
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stderr).toContain(
      '‹ecclium policy init› braucht ‹--interactive›.',
    );
  });

  it('turns a failure of the command into the internal error', async () => {
    const result = await runInit(['policy', 'init', '--interactive'], {
      policyInit: {
        load: () => {
          throw new Error(plain());
        },
      },
    });
    expect(result.code).toBe(exitCodes.internal);
    expect(result.stderr).toBe(`${internalErrorText}\n`);
  });

  it('takes --interactive only for policy init', () => {
    const result = capture(['config', 'check', '--interactive'], {});
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stderr).toBe(`${usageProblemTexts.option}\n${usageLine}\n`);
  });
});

describe('ecclium undo in the command line', () => {
  // The command talks to ChurchTools, so run gives a promise for it; its
  // own tests stand in undo/undo.test.ts.
  const runUndo = async (args: readonly string[], options: RunOptions = {}) => {
    const taken: number[] = [];
    const writeSync: WriteSyncFn = (_fd, buffer, offset, length) => {
      taken.push(...buffer.subarray(offset, offset + length));
      return length;
    };
    const code = await run(args, {}, [], { ...options, writeSync });
    return { code, stderr: decoder.decode(new Uint8Array(taken)) };
  };

  it('hands the ID to the command, which checks it and never names it', async () => {
    const id = `not-an-id-${plain()}`;
    const result = await runUndo(['undo', id, '--overwrite']);
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stderr).toContain('Die Kennung ist keine Kennung');
    expect(result.stderr).not.toContain(id);
  });

  it('turns a failure of the command into the internal error', async () => {
    const result = await runUndo(
      ['undo', '11111111-2222-4333-8444-555555555555'],
      {
        undo: {
          load: () => {
            throw new Error(plain());
          },
        },
      },
    );
    expect(result.code).toBe(exitCodes.internal);
    expect(result.stderr).toBe(`${internalErrorText}\n`);
  });
});

describe('ecclium queue in the command line', () => {
  // The command builds the pipeline, so run gives a promise for it; its
  // own tests stand in queue/queue.test.ts.
  const runQueue = async (
    args: readonly string[],
    options: RunOptions = {},
  ) => {
    const taken: number[] = [];
    const writeSync: WriteSyncFn = (_fd, buffer, offset, length) => {
      taken.push(...buffer.subarray(offset, offset + length));
      return length;
    };
    const code = await run(args, {}, [], { ...options, writeSync });
    return { code, stderr: decoder.decode(new Uint8Array(taken)) };
  };

  it.each(['show', 'approve', 'reject'])(
    'hands the ID of %s to the command, which checks it and never names it',
    async (action) => {
      const id = `not-an-id-${plain()}`;
      const result = await runQueue(['queue', action, id]);
      expect(result.code).toBe(exitCodes.usage);
      expect(result.stderr).toContain('Die Kennung ist keine Kennung');
      expect(result.stderr).not.toContain(id);
    },
  );

  it.each([
    [['queue', 'list']],
    [['queue', 'show', '11111111-2222-4333-8444-555555555555']],
    [['queue', 'approve', '11111111-2222-4333-8444-555555555555']],
  ])(
    'turns a failure of the command %j into the internal error',
    async (args) => {
      const result = await runQueue(args, {
        queue: {
          load: () => {
            throw new Error(plain());
          },
        },
      });
      expect(result.code).toBe(exitCodes.internal);
      expect(result.stderr).toBe(`${internalErrorText}\n`);
    },
  );
});

describe('ecclium run-once in the command line', () => {
  // The command builds the pipelines and the models, so run gives a
  // promise for it; its own tests stand in runner/run-once.test.ts.
  const runAsync = async (
    args: readonly string[],
    options: RunOptions = {},
  ) => {
    const taken = new Map<number, number[]>();
    const writeSync: WriteSyncFn = (fd, buffer, offset, length) => {
      const bytes = taken.get(fd) ?? [];
      bytes.push(...buffer.subarray(offset, offset + length));
      taken.set(fd, bytes);
      return length;
    };
    const code = await run(args, {}, [], { ...options, writeSync });
    const text = (fd: number): string =>
      decoder.decode(new Uint8Array(taken.get(fd) ?? []));
    return { code, stdout: text(1), stderr: text(2) };
  };

  it('refuses run-once without --due and without a routine with 64', () => {
    const result = capture(['run-once'], {});
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${usageProblemTexts.command}\n${usageLine}\n`);
  });

  it('refuses --due before a routine with 64, as an option of the other form', () => {
    const result = capture(['run-once', '--due', 'wochen-bericht'], {});
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stderr).toBe(`${usageProblemTexts.option}\n${usageLine}\n`);
  });

  it('refuses --due after a routine with 64, without naming the routine', () => {
    const routine = `routine-${plain().toLowerCase()}`;
    const result = capture(['run-once', routine, '--due'], {});
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stderr).toBe(`${usageProblemTexts.option}\n${usageLine}\n`);
    expect(result.stderr).not.toContain(routine);
  });

  it('refuses --preview without a routine with 64', () => {
    const result = capture(['run-once', '--preview'], {});
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stderr).toBe(`${usageProblemTexts.option}\n${usageLine}\n`);
  });

  it('hands a pass to the command, which turns a failure into the internal error', async () => {
    const result = await runAsync(['run-once', '--due'], {
      runOnce: {
        load: () => {
          throw new Error(plain());
        },
      },
    });
    expect(result.code).toBe(exitCodes.internal);
    expect(result.stderr).toBe(`${internalErrorText}\n`);
  });

  it('reaches the check of the runner with config check --runner, which loads the kind runner', async () => {
    const transports: Transport[] = [];
    const result = await runAsync(['config', 'check', '--runner'], {
      load: (sources) => {
        transports.push(sources.transport);
        return loadConfig(sources);
      },
    });
    expect(transports).toEqual(['runner']);
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(lastLine(result.stdout)).toBe(
      'Mit dieser Konfiguration startet der Runner nicht, oder eine Routine startet nicht. ChurchTools wurde nicht angefragt. Beheben Sie die Probleme und prüfen Sie dann erneut mit ‹ecclium config check --runner›.',
    );
    expect(result.stdout).not.toContain('ct_whoami');
  });

  it('lists run-once and the check of the runner in the help', () => {
    const result = capture(['--help'], {});
    expect(result.code).toBe(exitCodes.ok);
    const lines = result.stdout.split('\n');
    for (const start of [
      '    --runner ',
      '  run-once --due ',
      '  run-once <Routine> ',
      '    --preview ',
    ]) {
      expect(lines.some((line) => line.startsWith(start))).toBe(true);
    }
    expect(usageLine).toContain(
      'ecclium run-once --due | ecclium run-once <Routine> [--preview]',
    );
    expect(capture(['run-once', '--help'], {}).stdout).toBe(result.stdout);
  });
});
