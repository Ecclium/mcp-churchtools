import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { type EccliumConfig, loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  assertNoCanary,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanaries,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExitCode } from '../exit-codes.js';
import type { WriteSyncFn } from '../send.js';
import { createStdioCatalog } from './catalog.js';
import {
  closeDeadlineMs,
  serve,
  type ServeReplacements,
  type StdioHost,
} from './serve.js';

// The second stage of the start over stdio in process: the real stderr
// writer, logger, audit, pipeline and server, with a fake writeSync in
// place of fd 2, streams in memory in place of stdin and stdout, the test
// double of ChurchTools in place of an instance and a fake process for
// signals, exceptions and the exit. The real process is the subject of a
// test with a child process, because package tests start none. Canaries
// stand in the token, in both names and in the e-mail address.

type Json = Readonly<Record<string, unknown>>;

/** Reads a value along a path of keys, undefined where the path ends. */
const at = (value: unknown, ...path: readonly (string | number)[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === 'object' && current !== null
        ? (current as Readonly<Record<string | number, unknown>>)[key]
        : undefined,
    value,
  );

const canary = makeCanaries();
const [firstName = '', lastName = ''] = canary.name.cores;
const allCanaries = [canary.token, canary.email, canary.name];
const maskedEmail = `${canary.email.value.charAt(0)}***@example.org`;

/** The configuration of the test, at the level of the log given. */
const configAt = (level: EccliumConfig['logLevel']): EccliumConfig => {
  const loaded = loadConfig({
    environment: {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      ECCLIUM_LOG_LEVEL: level,
    },
    transport: 'stdio',
  });
  if (!loaded.ok) throw new Error('the configuration of the test is invalid');
  return loaded.config;
};
const config = configAt('info');

const json = { headers: { 'content-type': 'application/json' } };

const open: MockedHttpTransport[] = [];
afterEach(async () => {
  // Before the real timers, so that the stub of setTimeout does not put
  // the fake one back.
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // The end of the connection closes the transport already; a second
  // close may fail, which says nothing here.
  await Promise.all(
    open.splice(0).map((double) => double.close().catch(() => undefined)),
  );
});

/** A process that records what the start does with it. */
const fakeHost = () => {
  const signals = new Map<string, () => void>();
  const crashes = new Map<string, (value: unknown) => void>();
  const exitCodes: ExitCode[] = [];
  const exits: ExitCode[] = [];
  const host: StdioHost = Object.freeze({
    onSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      signals.set(signal, listener);
    },
    onUncaughtException: (listener: (error: unknown) => void) => {
      crashes.set('uncaught', listener);
    },
    onUnhandledRejection: (listener: (reason: unknown) => void) => {
      crashes.set('rejection', listener);
    },
    setExitCode: (code: ExitCode) => {
      exitCodes.push(code);
    },
    exit: (code: ExitCode) => {
      exits.push(code);
    },
  });
  return { host, signals, crashes, exitCodes, exits };
};

const decoder = new TextDecoder();

const setup = (
  options: {
    readonly afterTornLine?: boolean;
    readonly answer?: boolean;
    readonly failTransport?: boolean;
    readonly logLevel?: EccliumConfig['logLevel'];
  } = {},
) => {
  const configured =
    options.logLevel === undefined ? config : configAt(options.logLevel);
  const bytes: number[] = [];
  const writeSync: WriteSyncFn = (fd, buffer, offset, length) => {
    expect(fd).toBe(2);
    for (const byte of buffer.subarray(offset, offset + length)) {
      bytes.push(byte);
    }
    return length;
  };
  const agents: string[] = [];
  const createTransport: NonNullable<ServeReplacements['createTransport']> = (
    settings,
  ) => {
    agents.push(settings.userAgent);
    if (options.failTransport === true) throw new Error(canary.token.value);
    // The logger of the start, so that the lines of the transport reach
    // the fake fd 2 as well.
    const double = createChurchToolsDouble({
      token: settings.token,
      origin: settings.origin,
      logger: settings.logger,
    });
    open.push(double);
    if (options.answer === true) {
      double
        .intercept({
          path: '/api/whoami?only_allow_authenticated=true',
          method: 'GET',
        })
        .reply(
          200,
          JSON.stringify({
            data: {
              id: 7,
              guid: '00000000-0000-0000-0000-000000000007',
              firstName,
              lastName,
              email: canary.email.value,
            },
          }),
          json,
        );
      double
        .intercept({ path: '/api/permissions/global', method: 'GET' })
        .reply(
          200,
          JSON.stringify({ data: { churchwiki: { view: true } } }),
          json,
        );
    }
    return double.transport;
  };
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  const fake = fakeHost();
  const code = serve({
    config: configured,
    catalog: createStdioCatalog(configured),
    afterTornLine: options.afterTornLine ?? false,
    writeSync,
    createTransport,
    input,
    output,
    host: fake.host,
  });
  const stderr = (): string => decoder.decode(new Uint8Array(bytes));
  /** Every line on the fake fd 2 so far, parsed. */
  const lines = (): readonly Json[] =>
    stderr()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Json);
  const events = (): readonly unknown[] => lines().map((line) => line['event']);
  const received = (): readonly Json[] =>
    written
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line) as Json);
  return {
    ...fake,
    code,
    agents,
    input,
    stderr,
    lines,
    events,
    send: (message: Json): void => {
      input.write(`${JSON.stringify(message)}\n`);
    },
    reply: async (id: number): Promise<Json> => {
      let found: Json | undefined;
      await vi.waitFor(() => {
        found = received().find((message) => message['id'] === id);
        expect(found).toBeDefined();
      });
      return found ?? {};
    },
    /** Waits until the end of the connection has written its event. */
    ended: async (): Promise<Json> => {
      let found: Json | undefined;
      await vi.waitFor(() => {
        found = lines().find((line) => line['event'] === 'stdio_closed');
        expect(found).toBeDefined();
      });
      return found ?? {};
    },
  };
};

const initialize: Json = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

// Code without comments, so that a word in a comment counts for nothing.
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the second stage of the start over stdio', () => {
  it('answers ct_whoami with the e-mail masked and writes no canary to stderr', async () => {
    const session = setup({ answer: true });
    expect(session.code).toBeUndefined();
    session.send(initialize);
    expect(at(await session.reply(1), 'result', 'serverInfo')).toEqual({
      name: 'ecclium-mcp-churchtools',
      version: '0.0.0',
    });
    session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    session.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ct_whoami', arguments: {} },
    });
    const result = at(await session.reply(2), 'result');
    expect(at(result, 'isError')).toBeUndefined();
    expect(at(result, 'structuredContent')).toEqual({
      id: 7,
      firstName,
      lastName,
      email: maskedEmail,
      rights: {
        status: 'known',
        modules: [{ module: 'churchwiki', rights: [{ right: 'view' }] }],
      },
    });
    expect(session.agents).toEqual(['Ecclium/0.0.0']);

    session.input.end();
    expect(at(await session.ended(), 'count')).toBe(0);
    // Every line on stderr is JSON, none holds a canary, the lines of the
    // transport name the tenant default, and the audit line the mode.
    const lines = session.lines();
    assertNoCanary(session.stderr(), allCanaries, 'stderr');
    expect(
      lines.filter((line) => line['event'] === 'http_response'),
    ).toHaveLength(2);
    for (const line of lines.filter(
      (entry) => entry['event'] === 'http_response',
    )) {
      expect(line['tenantId']).toBe('default');
    }
    expect(lines.filter((line) => line['type'] === 'tool_call')).toEqual([
      expect.objectContaining({
        tenantId: 'default',
        mode: 'interactive',
        tool: 'ct_whoami',
        outcome: 'ok',
      }),
    ]);
    expect(session.exitCodes).toEqual([0]);
    expect(session.exits).toEqual([]);
  });

  it('ends with 143 when SIGTERM came before the end of the connection', async () => {
    const session = setup();
    session.signals.get('SIGTERM')?.();
    await session.ended();
    expect(session.events()).toEqual(['process_sigterm', 'stdio_closed']);
    expect(session.exitCodes).toEqual([143]);
    expect(session.exits).toEqual([]);
  });

  // The level filters the lines of the server, the transport and the
  // pipeline, never the signal and the count of lost lines.
  it.each(['warn', 'error'] as const)(
    'writes the signal and the end also at the level %s',
    async (logLevel) => {
      const session = setup({ logLevel });
      session.signals.get('SIGTERM')?.();
      expect(at(await session.ended(), 'count')).toBe(0);
      expect(session.events()).toEqual(['process_sigterm', 'stdio_closed']);
      expect(session.exitCodes).toEqual([143]);
    },
  );

  it('ends with 130 after SIGINT and at once on a second signal', async () => {
    const session = setup();
    session.signals.get('SIGINT')?.();
    session.signals.get('SIGTERM')?.();
    expect(session.exits).toEqual([143]);
    await session.ended();
    expect(session.exitCodes).toEqual([130]);
    expect(session.events()).toEqual(['process_sigint', 'stdio_closed']);
  });

  // vi.waitFor would move the fake clock itself, so the test waits for
  // the exit code with turns of the event loop instead. The spy wraps the
  // fake setTimeout, so it comes after the fake timers.
  it('ends the process at the deadline when something still holds it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const timers = vi.fn(globalThis.setTimeout);
    vi.stubGlobal('setTimeout', timers);
    const session = setup();
    session.input.end();
    for (
      let turn = 0;
      turn < 1000 && session.exitCodes.length === 0;
      turn += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(session.exitCodes).toEqual([0]);
    // The deadline itself holds nothing: a clean end does not wait for it.
    // Found by its delay, since the end may arm other timers.
    const index = timers.mock.calls.findIndex(
      ([, delay]) => delay === closeDeadlineMs,
    );
    const deadline = timers.mock.results[index];
    if (deadline?.type !== 'return') throw new Error('no deadline armed');
    expect(deadline.value.hasRef()).toBe(false);
    vi.advanceTimersByTime(closeDeadlineMs - 1);
    expect(session.exits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(session.exits).toEqual([0]);
  });

  it.each([
    ['uncaught', 'process_uncaught_exception'],
    ['rejection', 'process_unhandled_rejection'],
  ])(
    'writes one fixed line for an %s exception and ends with 70',
    (kind, event) => {
      const session = setup();
      const thrown = new Error(canary.token.value, {
        cause: canary.email.value,
      });
      session.crashes.get(kind)?.(thrown);
      expect(session.exits).toEqual([70]);
      expect(session.lines()).toEqual([
        expect.objectContaining({ level: 'error', event, code: 'internal' }),
      ]);
      assertNoCanary(session.stderr(), allCanaries, 'stderr');
    },
  );

  // Once the stderr writer exists, no notice may follow: a failure of the
  // start becomes a line of the log.
  it('ends a start that fails after the writer with a fixed event and 70', () => {
    const session = setup({ failTransport: true });
    expect(session.code).toBe(70);
    expect(session.lines()).toEqual([
      expect.objectContaining({
        level: 'error',
        event: 'stdio_start_failed',
        code: 'internal',
      }),
    ]);
    assertNoCanary(session.stderr(), allCanaries, 'stderr');
    expect(session.signals.size).toBe(0);
  });

  it('starts its first line on a line of its own after a torn notice', () => {
    const session = setup({ afterTornLine: true });
    session.crashes.get('uncaught')?.(new Error('x'));
    expect(session.stderr()).toMatch(/^\n\{/);
  });

  // The mode decides which tools may run. It is a literal of the start,
  // never a value from the configuration, an argument or a request.
  it('sets the mode only as the literal interactive', () => {
    const source = code(
      readFileSync(new URL('serve.ts', import.meta.url), 'utf8'),
    );
    expect(source.match(/\bmode\b/g)).toEqual(['mode']);
    expect(source).toContain("mode: 'interactive',");
  });
});
