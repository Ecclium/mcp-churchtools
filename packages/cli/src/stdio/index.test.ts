import { PassThrough } from 'node:stream';

import {
  type RefusalReason,
  RegistryRefusal,
  tokenVariableName,
} from '@ecclium/mcp-churchtools-core';
import { DocsIndexError } from '@ecclium/mcp-churchtools-docs-index';
import {
  assertNoCanary,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
  type MockedHttpTransport,
  syntheticDocsIndex,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  problemText,
  refusalText,
  startText,
  warningText,
} from '../messages/index.js';
import type { WriteSyncFn } from '../send.js';
import { startStdio, type StdioStartOptions } from './index.js';
import type { StdioHost } from './serve.js';

// The first stage of the start over stdio: the environment, the
// arguments, the configuration, the catalog and the start notices, before
// the server loads. A fake writeSync stands in for fd 2. The way to a
// running server gets the replacements of the second stage, so that no
// listener reaches the process of the test.

// A refusal of the registry cannot come from the plugin of the core, so
// the test plants one in the catalog when it sets a reason.
const planted = vi.hoisted(() => ({
  reason: undefined as RefusalReason | undefined,
}));
vi.mock(import('./catalog.js'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createStdioCatalog: (
      ...args: Parameters<typeof original.createStdioCatalog>
    ) => {
      if (planted.reason !== undefined) {
        throw new RegistryRefusal(planted.reason, { plugin: 'example' });
      }
      return original.createStdioCatalog(...args);
    },
  };
});

type Environment = Record<string, string | undefined>;

const open: MockedHttpTransport[] = [];
afterEach(async () => {
  planted.reason = undefined;
  await Promise.all(
    open.splice(0).map((double) => double.close().catch(() => undefined)),
  );
});

// The name of the token in capitals, in small letters and mixed: the
// start removes every spelling, as a child process would inherit each.
const spellings: readonly string[] = [
  tokenVariableName,
  tokenVariableName.toLowerCase(),
  'Ecclium_ChurchTools_Token',
];

const decoder = new TextDecoder();

/**
 * Runs the first stage with a fake writeSync and the replacements, and
 * with the options of Node.js, by default none.
 */
const start = async (
  args: readonly string[],
  environment: Environment,
  options: Omit<StdioStartOptions, 'writeSync'> = {},
  execArgv: readonly string[] = [],
) => {
  const bytes: number[] = [];
  const writeSync: WriteSyncFn = (fd, buffer, offset, length) => {
    expect(fd).toBe(2);
    for (const byte of buffer.subarray(offset, offset + length)) {
      bytes.push(byte);
    }
    return length;
  };
  const code = await startStdio(args, environment, execArgv, {
    ...options,
    writeSync,
  });
  const stderr = (): string => decoder.decode(new Uint8Array(bytes));
  return { code, stderr };
};

/** The replacements of the second stage and what they recorded. */
const serving = () => {
  const exitCodesSet: ExitCode[] = [];
  const host: StdioHost = Object.freeze({
    onSignal: () => undefined,
    onUncaughtException: () => undefined,
    onUnhandledRejection: () => undefined,
    setExitCode: (code: ExitCode) => {
      exitCodesSet.push(code);
    },
    exit: () => undefined,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const options: Omit<StdioStartOptions, 'writeSync'> = {
    host,
    input,
    output,
    createTransport: (settings) => {
      const double = createChurchToolsDouble({
        token: settings.token,
        origin: settings.origin,
        logger: settings.logger,
      });
      open.push(double);
      return double.transport;
    },
  };
  return { options, input, exitCodesSet };
};

describe('the first stage of the start over stdio', () => {
  it.each(spellings)(
    'refuses every argument with a fixed notice and 64, and removes %s',
    async (name) => {
      const token = makeCanary('token');
      const argument = token.cores[0] ?? '';
      for (const args of [['--help'], [argument], ['stdio', '-h']]) {
        const environment: Environment = {
          ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
          [name]: token.value,
        };
        const { code, stderr } = await start(args, environment);
        expect(code).toBe(exitCodes.usage);
        expect(stderr()).toBe(`${startText('usage')}\n`);
        expect(Object.keys(environment)).toEqual(['ECCLIUM_CHURCHTOOLS_URL']);
        assertNoCanary(stderr(), [token], 'stderr');
      }
    },
  );

  it.each(spellings)(
    'ends an invalid configuration with its problems and 78, and removes %s',
    async (name) => {
      const token = makeCanary('token');
      const environment: Environment = { [name]: token.value };
      const { code, stderr } = await start([], environment);
      expect(code).toBe(exitCodes.invalidConfig);
      expect(stderr()).toContain(
        `${problemText({ code: 'url_missing', variable: 'ECCLIUM_CHURCHTOOLS_URL' })}\n`,
      );
      expect(stderr().endsWith('\n')).toBe(true);
      // Only notices: no line of the log, so no stderr writer came into
      // being.
      expect(stderr()).not.toContain('{');
      expect(Object.keys(environment)).toEqual([]);
      assertNoCanary(stderr(), [token], 'stderr');
    },
  );

  // The loader reads the path of a certificate and of a key log, but the
  // notices name only the settings.
  it('refuses a key log and warns about the trust store without a path', async () => {
    const canary = makeCanary('token');
    const path = `/path/${canary.value}`;
    const environment: Environment = {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      [tokenVariableName]: makeCanary('token').value,
      NODE_EXTRA_CA_CERTS: `${path}/ca.pem`,
    };
    const { code, stderr } = await start([], environment, {}, [
      '--tls-keylog',
      `${path}/keys`,
    ]);
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr()).toBe(
      [
        problemText({ code: 'tls_keylog_enabled' }),
        warningText('token_from_environment'),
        warningText('trust_store_extended'),
        '',
      ].join('\n'),
    );
    assertNoCanary(stderr(), [canary], 'stderr');
  });

  it('starts the server after the notices and removes the token', async () => {
    const token = makeCanary('token');
    const environment: Environment = {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      [tokenVariableName]: token.value,
    };
    const { options, input, exitCodesSet } = serving();
    const { code, stderr } = await start([], environment, options);
    expect(code).toBeUndefined();
    expect(Object.keys(environment)).toEqual(['ECCLIUM_CHURCHTOOLS_URL']);

    input.end();
    await vi.waitFor(() => {
      expect(exitCodesSet).toEqual([exitCodes.ok]);
      expect(stderr()).toContain('"event":"stdio_closed"');
    });
    // The notice first, then only lines of JSON from the stderr writer.
    const [notice, ...rest] = stderr().trimEnd().split('\n');
    expect(notice).toBe(warningText('token_from_environment'));
    expect(rest.length).toBeGreaterThan(0);
    for (const line of rest) {
      expect(() => JSON.parse(line) as unknown, line).not.toThrow();
    }
    assertNoCanary(stderr(), [token], 'stderr');
  });

  it('ends a refusal of the registry with its notice and 70', async () => {
    planted.reason = 'plugin_reserved';
    const environment: Environment = {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      [tokenVariableName]: makeCanary('token').value,
    };
    const { code, stderr } = await start([], environment);
    expect(code).toBe(exitCodes.internal);
    expect(stderr()).toBe(
      `${warningText('token_from_environment')}\n${refusalText('plugin_reserved')}\n`,
    );
  });

  // The docs index is read only with the toolset docs, and without a
  // usable index the start stops with its notice (ADR 0066).
  it('reads the docs index once with the toolset docs and never without it', async () => {
    const reads: number[] = [];
    const readDocs = () => {
      reads.push(1);
      return syntheticDocsIndex();
    };
    const environment = (toolsets: string): Environment => ({
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      [tokenVariableName]: makeCanary('token').value,
      ECCLIUM_TOOLSETS: toolsets,
    });
    for (const toolsets of ['wiki', 'docs']) {
      const { options, input, exitCodesSet } = serving();
      const { code } = await start([], environment(toolsets), {
        ...options,
        readDocs,
      });
      expect(code).toBeUndefined();
      input.end();
      await vi.waitFor(() => {
        expect(exitCodesSet).toEqual([exitCodes.ok]);
      });
      expect(reads, toolsets).toHaveLength(toolsets === 'docs' ? 1 : 0);
    }
  });

  it.each(['missing', 'size'] as const)(
    'ends with the toolset docs and a docs index that is %s with its notice and 70',
    async (problem) => {
      const { code, stderr } = await start(
        [],
        {
          ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
          [tokenVariableName]: makeCanary('token').value,
          ECCLIUM_TOOLSETS: 'docs',
        },
        {
          readDocs: () => {
            throw new DocsIndexError(problem);
          },
        },
      );
      expect(code).toBe(exitCodes.internal);
      expect(stderr()).toBe(
        `${warningText('token_from_environment')}\n${startText('docs_index')}\n`,
      );
    },
  );

  it('gives an internal error one fixed notice and 70', async () => {
    const token = makeCanary('token');
    // A proxy as the environment: taking it over fails, and nothing of it
    // may reach the notice.
    const environment = new Proxy<Environment>(
      { [tokenVariableName]: token.value },
      {},
    );
    const { code, stderr } = await start([], environment);
    expect(code).toBe(exitCodes.internal);
    expect(stderr()).toBe(`${startText('internal')}\n`);
  });

  // Only a reason of the catalog becomes a refusal notice.
  it('reports a refusal with an unknown reason as an internal error', async () => {
    planted.reason = 'not_a_reason' as RefusalReason;
    const { code, stderr } = await start([], {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      [tokenVariableName]: makeCanary('token').value,
    });
    expect(code).toBe(exitCodes.internal);
    expect(stderr().trimEnd().split('\n').at(-1)).toBe(startText('internal'));
  });
});
