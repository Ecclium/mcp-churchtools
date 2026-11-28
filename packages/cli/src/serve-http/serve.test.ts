import { Buffer } from 'node:buffer';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBearerToken,
  hashBearerToken,
  readBearerLastUse,
  serializeBearerTokens,
} from '@ecclium/mcp-churchtools-core';
import { createFileQuotaStore } from '@ecclium/mcp-churchtools-core/composition';
import type { IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createHttpApp,
  type HttpApp,
  HttpBindError,
  type HttpListenOptions,
  mcpPath,
} from '@ecclium/mcp-churchtools-server/http';
import {
  assertNoCanary,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanaries,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import { problemText, startText } from '../messages/index.js';
import { createOutput } from '../output/index.js';
import {
  runServeHttp,
  type ServeHttpHost,
  type ServeHttpOptions,
} from './serve.js';
import {
  bindText,
  listeningText,
  serveHttpTexts,
  tokensText,
} from './texts.js';

// `ecclium serve-http` in process (ADR 0073, ADR 0074): the real start
// with its folders and files in the temporary folder, the double of
// ChurchTools, a fixed clock and a process that only records, and a
// binding that builds the application without a port, so that the
// requests reach it in process. The one test over a real socket lives in
// tests/http-listen.test.mts. Every token comes into being at run time.

type Json = Readonly<Record<string, unknown>>;

const now = Date.UTC(2026, 10, 27, 12);
const clock = Object.freeze({ now: Object.freeze(() => now) });
const canary = makeCanaries();

const base = mkdtempSync(join(tmpdir(), 'ecclium-serve-http-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

let made = 0;
const privateDir = (name: string): string => {
  made += 1;
  const path = join(base, `${name}-${String(made)}`);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
};
const privateFile = (path: string, text: string): string => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

const reader = createBearerToken();
const writer = createBearerToken();
const entry = (
  name: string,
  token: string,
  scopes: readonly ('read' | 'write')[],
  expiresAt = '2027-05-25',
) => ({
  name,
  sha256: hashBearerToken(token),
  scopes,
  createdAt: '2026-11-26',
  expiresAt,
});

const doubles: MockedHttpTransport[] = [];
afterEach(async () => {
  await Promise.all(
    doubles.splice(0).map((double) => double.close().catch(() => undefined)),
  );
});

const json = { headers: { 'content-type': 'application/json' } };

interface Setup {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly tokens?: string;
  readonly listen?: (options: HttpListenOptions) => Promise<never>;
  readonly holdClose?: Promise<void>;
  readonly state?: string;
  readonly extra?: Partial<ServeHttpOptions>;
}

/**
 * The folder of state, the file of the tokens and the token file of the
 * server, the output and the stderr writer, the process and the binding.
 */
const setup = (options: Setup = {}) => {
  const folder = privateDir('case');
  const state = options.state ?? privateDir('state');
  const tokensFile = privateFile(
    join(folder, 'http-tokens.yaml'),
    options.tokens ??
      serializeBearerTokens([
        entry('reader', reader, ['read']),
        entry('writer', writer, ['read', 'write']),
      ]),
  );
  const tokenFile = privateFile(
    join(folder, 'ct-token'),
    `${canary.token.value}\n`,
  );
  const environment = {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenFile,
    ECCLIUM_STATE_DIR: state,
    ECCLIUM_HTTP_TOKENS_FILE: tokensFile,
    ...options.environment,
  };
  const text: string[] = [];
  const writeSync = (
    _fd: number,
    buffer: Uint8Array,
    offset?: number,
    length?: number,
  ): number => {
    const start = offset ?? 0;
    const end = start + (length ?? buffer.length - start);
    text.push(Buffer.from(buffer).subarray(start, end).toString('utf8'));
    return end - start;
  };
  const output = createOutput({ writeSync });
  const signals = new Map<string, () => void>();
  const faults: ((kind: 'exception' | 'rejection', value: unknown) => void)[] =
    [];
  const exit = vi.fn();
  const host: ServeHttpHost = Object.freeze({
    onSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      signals.set(signal, listener);
      return () => {
        signals.delete(signal);
      };
    },
    onFault: (
      listener: (kind: 'exception' | 'rejection', value: unknown) => void,
    ) => {
      faults.push(listener);
      return () => {
        faults.splice(faults.indexOf(listener), 1);
      };
    },
    exit,
  });
  let bind: (app: HttpApp) => void = () => undefined;
  const bound = new Promise<HttpApp>((resolve) => {
    bind = resolve;
  });
  const listened: HttpListenOptions[] = [];
  let closes = 0;
  const run = runServeHttp({
    ...options.extra,
    environment,
    execArgv: [],
    output,
    writeSync,
    clock,
    host,
    createTransport: (settings) => {
      const double = createChurchToolsDouble({
        token: settings.token,
        origin: settings.origin,
        logger: settings.logger,
      });
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
              firstName: 'Max',
              lastName: 'Mustermann',
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
      doubles.push(double);
      return double.transport;
    },
    listen:
      options.listen ??
      ((settings) => {
        listened.push(settings);
        const app = createHttpApp(settings);
        bind(app);
        return Promise.resolve(
          Object.freeze({
            address: settings.host ?? '127.0.0.1',
            port: settings.port,
            close: async () => {
              closes += 1;
              await options.holdClose;
              await app.close();
            },
          }),
        );
      }),
  });
  const lines = (): readonly string[] =>
    text
      .join('')
      .split('\n')
      .filter((line) => line !== '');
  const logLines = (): readonly Json[] =>
    lines()
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Json);
  return {
    run,
    bound,
    state,
    tokensFile,
    listened,
    closes: () => closes,
    exit,
    fault: (kind: 'exception' | 'rejection', value: unknown) => {
      for (const listener of faults) listener(kind, value);
    },
    signal: (name: 'SIGINT' | 'SIGTERM') => {
      signals.get(name)?.();
    },
    lines,
    logLines,
    notices: () => lines().filter((line) => !line.startsWith('{')),
    text: () => text.join(''),
  };
};

const ask = (
  app: HttpApp,
  token: string | undefined,
  method: string,
  params: Json = {},
): Promise<Response> =>
  app.fetch(
    new Request(`http://127.0.0.1:8765${mcpPath}`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8765',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    }),
    { localPort: 8765 },
  );

describe('ecclium serve-http', () => {
  it('binds to loopback, signs a token in, audits its call with its actor, notes the day and ends with 143 after SIGTERM', async () => {
    const session = setup();
    const app = await session.bound;
    await vi.waitFor(() => {
      expect(session.notices().at(-1)).toBe(
        listeningText({ address: '127.0.0.1', port: 8765 }),
      );
    });
    const [settings] = session.listened;
    expect(settings).toMatchObject({
      host: '127.0.0.1',
      port: 8765,
      mode: 'interactive',
      readOnly: true,
      redaction: 'standard',
    });
    expect(settings?.allowedHosts).toBeUndefined();
    expect(session.notices()).toEqual([
      tokensText(2, 1),
      serveHttpTexts.readOnly,
      listeningText({ address: '127.0.0.1', port: 8765 }),
    ]);

    expect((await ask(app, undefined, 'tools/list')).status).toBe(401);
    expect((await ask(app, createBearerToken(), 'tools/list')).status).toBe(
      401,
    );
    const called = await ask(app, reader, 'tools/call', {
      name: 'ct_whoami',
      arguments: {},
    });
    expect(called.status).toBe(200);
    const audit = session
      .logLines()
      .filter((line) => line['type'] === 'tool_call');
    expect(audit).toEqual([
      expect.objectContaining({
        tenantId: 'default',
        actor: { kind: 'user', id: 'bearer:reader' },
        mode: 'interactive',
        tool: 'ct_whoami',
        outcome: 'ok',
      }),
    ]);
    // The line stands in the audit file as well, and the day of the use
    // in the folder of state.
    expect(readdirSync(join(session.state, 'audit')).length).toBe(1);
    const store = createFileQuotaStore({
      stateDir: session.state,
      clock,
      pid: 4242,
      host: 'example-host',
    });
    await expect(readBearerLastUse(store, 'reader')).resolves.toBe(
      '2026-11-27',
    );

    session.signal('SIGTERM');
    await expect(session.run).resolves.toBe(exitCodes.terminated);
    expect(session.closes()).toBe(1);
    expect(session.exit).not.toHaveBeenCalled();
    const events = session
      .logLines()
      .map((line) => line['event'])
      .filter((event) => event !== undefined);
    // The count of lost lines of the audit file comes before its anchor,
    // which the close writes, and the end of the process is the last line.
    expect(events.slice(-3)).toEqual([
      'audit_file_closed',
      'audit_chain_anchor',
      'http_closed',
    ]);
    expect(events).toContain('process_sigterm');
    expect(session.notices()).toContain(serveHttpTexts.signal);
    // No token, no path of a file and no canary reaches stderr.
    for (const value of [reader, writer, session.tokensFile, session.state]) {
      expect(session.text()).not.toContain(value);
    }
    assertNoCanary(session.text(), [canary.token, canary.email], 'stderr');
  });

  it('ends with 130 after SIGINT, and a second signal ends the process at once', async () => {
    let release: () => void = () => undefined;
    const holdClose = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = setup({ holdClose });
    await session.bound;
    session.signal('SIGINT');
    session.signal('SIGINT');
    expect(session.exit).toHaveBeenCalledWith(exitCodes.interrupted);
    release();
    await expect(session.run).resolves.toBe(exitCodes.interrupted);
  });

  it('takes the address, the port and the allowed hosts of the configuration', async () => {
    const session = setup({
      environment: {
        ECCLIUM_HTTP_ADDRESS: '0.0.0.0',
        ECCLIUM_HTTP_PORT: '8443',
        ECCLIUM_ALLOWED_HOSTS: 'mcp.example.org:8443',
      },
    });
    await session.bound;
    expect(session.listened[0]).toMatchObject({
      host: '0.0.0.0',
      port: 8443,
      allowedHosts: [{ name: 'mcp.example.org', port: 8443 }],
    });
    await vi.waitFor(() => {
      expect(session.notices().at(-1)).toBe(
        listeningText({ address: '0.0.0.0', port: 8443 }),
      );
    });
    session.signal('SIGTERM');
    await expect(session.run).resolves.toBe(exitCodes.terminated);
  });

  it.each([
    [
      'without the folder of state',
      { ECCLIUM_STATE_DIR: undefined },
      'http_state_dir_required',
      'ECCLIUM_STATE_DIR',
    ],
    [
      'without the file of the tokens',
      { ECCLIUM_HTTP_TOKENS_FILE: undefined },
      'http_tokens_file_required',
      'ECCLIUM_HTTP_TOKENS_FILE',
    ],
    [
      'with writes',
      { ECCLIUM_READ_ONLY: 'false' },
      'http_writes_unsupported',
      'ECCLIUM_READ_ONLY',
    ],
    [
      'with an address beyond loopback and no hosts',
      { ECCLIUM_HTTP_ADDRESS: '0.0.0.0' },
      'http_address_needs_allowed_hosts',
      'ECCLIUM_HTTP_ADDRESS',
    ],
    [
      'with the subject of stdio',
      { ECCLIUM_STDIO_SUBJECT: 'local-stdio' },
      'stdio_only',
      'ECCLIUM_STDIO_SUBJECT',
    ],
  ] as const)(
    'does not start %s: 78 with its problem, and binds nothing',
    async (_, environment, code, variable) => {
      const session = setup({ environment });
      await expect(session.run).resolves.toBe(exitCodes.invalidConfig);
      expect(session.listened).toEqual([]);
      expect(session.logLines()).toEqual([]);
      // The problem comes first; a warning such as the one for writes may
      // follow it.
      expect(session.notices()[0]).toBe(problemText({ code, variable }));
    },
  );

  it('does not start with a file of the tokens that is no valid file, and opens no audit file', async () => {
    const session = setup({ tokens: 'version: [\n' });
    await expect(session.run).resolves.toBe(exitCodes.invalidConfig);
    expect(session.listened).toEqual([]);
    expect(readdirSync(session.state)).toEqual([]);
    expect(session.notices()).toHaveLength(1);
  });

  it('starts with a file that holds no token of today, and says so', async () => {
    const session = setup({
      tokens: serializeBearerTokens([
        entry('reader', reader, ['read'], '2026-11-26'),
      ]),
    });
    const app = await session.bound;
    expect(session.notices()[0]).toBe(serveHttpTexts.noToken);
    expect((await ask(app, reader, 'tools/list')).status).toBe(401);
    session.signal('SIGTERM');
    await expect(session.run).resolves.toBe(exitCodes.terminated);
  });

  it('ends with 78 when the port is taken, and closes the audit file', async () => {
    const session = setup({
      listen: () => Promise.reject(new HttpBindError('listen', 'EADDRINUSE')),
    });
    await expect(session.run).resolves.toBe(exitCodes.invalidConfig);
    expect(session.notices()).toContain(bindText('listen', 'EADDRINUSE'));
    expect(session.logLines().map((line) => line['event'])).toContain(
      'audit_file_closed',
    );
  });

  it('ends with 70 and a fixed line when the binding fails otherwise', async () => {
    const session = setup({
      listen: () => Promise.reject(new Error(canary.token.value)),
    });
    await expect(session.run).resolves.toBe(exitCodes.internal);
    expect(
      session
        .logLines()
        .filter((line) => line['event'] === 'http_start_failed'),
    ).toEqual([expect.objectContaining({ code: 'internal' })]);
    assertNoCanary(session.text(), [canary.token, canary.email], 'stderr');
  });

  it('removes the days of the last use past 365 days at the start, and keeps the others', async () => {
    const state = privateDir('state');
    const before = createFileQuotaStore({
      stateDir: state,
      clock,
      pid: 4242,
      host: 'example-host',
    });
    const { prepareQuotaFolder } =
      await import('@ecclium/mcp-churchtools-core/composition');
    expect(prepareQuotaFolder(state).ok).toBe(true);
    const tenant = 'default' as Parameters<typeof before.noteLastUse>[0];
    const { bearerLastUseKey } =
      await import('@ecclium/mcp-churchtools-plugin-api');
    await before.noteLastUse(
      tenant,
      bearerLastUseKey('reader'),
      '2025-11-26' as IsoDate,
    );
    await before.noteLastUse(
      tenant,
      bearerLastUseKey('writer'),
      '2025-11-27' as IsoDate,
    );
    const session = setup({ environment: { ECCLIUM_STATE_DIR: state } });
    await session.bound;
    expect(
      session
        .logLines()
        .filter((line) => line['event'] === 'http_last_use_pruned'),
    ).toEqual([expect.objectContaining({ count: 1 })]);
    await expect(readBearerLastUse(before, 'reader')).resolves.toBeUndefined();
    await expect(readBearerLastUse(before, 'writer')).resolves.toBe(
      '2025-11-27',
    );
    session.signal('SIGTERM');
    await expect(session.run).resolves.toBe(exitCodes.terminated);
  });
});

describe('ecclium serve-http when a part fails', () => {
  it('ends with 69 when the proxy gives no tunnel, binds nothing and closes the audit file', async () => {
    const probe = vi.fn(() =>
      Promise.resolve({ ok: false as const, reason: 'refused' as const }),
    );
    const session = setup({
      environment: { ECCLIUM_EGRESS_PROXY: 'http://egress.example.org:3128' },
      extra: { probeProxy: probe },
    });
    await expect(session.run).resolves.toBe(exitCodes.unavailable);
    expect(probe).toHaveBeenCalledWith({
      proxy: 'http://egress.example.org:3128',
      origin: doubleOrigin,
    });
    expect(session.listened).toEqual([]);
    // The audit file was opened and closed again: its folder is there and
    // holds no file of a day, since no line was written.
    expect(readdirSync(join(session.state, 'audit'))).toEqual([]);
  });

  it('ends with 78 when the folder of the counters cannot be used, and binds nothing', async () => {
    const state = privateDir('state');
    // A folder quota that group and others may read is refused, here by
    // the check of the folder of state in the loader, before any file.
    mkdirSync(join(state, 'quota'), { mode: 0o755 });
    chmodSync(join(state, 'quota'), 0o755);
    const session = setup({ state });
    await expect(session.run).resolves.toBe(exitCodes.invalidConfig);
    expect(session.listened).toEqual([]);
    expect(readdirSync(state)).toEqual(['quota']);
  });

  it('ends with 70 when the docs index cannot be read, and says so', async () => {
    const { DocsIndexError } =
      await import('@ecclium/mcp-churchtools-docs-index');
    const session = setup({
      environment: { ECCLIUM_TOOLSETS: 'docs' },
      extra: {
        readDocs: () => {
          throw new DocsIndexError('missing');
        },
      },
    });
    await expect(session.run).resolves.toBe(exitCodes.internal);
    expect(session.listened).toEqual([]);
    expect(session.notices()).toEqual([startText('docs_index')]);
  });

  it('writes a fixed line and ends the process with 70 for a fault nothing caught', async () => {
    const session = setup();
    await session.bound;
    session.fault('rejection', new Error(canary.token.value));
    expect(session.exit).toHaveBeenCalledWith(exitCodes.internal);
    expect(
      session
        .logLines()
        .filter((line) => line['event'] === 'process_unhandled_rejection'),
    ).toEqual([expect.objectContaining({ code: 'internal' })]);
    assertNoCanary(session.text(), [canary.token], 'stderr');
    session.signal('SIGTERM');
    await expect(session.run).resolves.toBe(exitCodes.terminated);
  });

  it('warns and runs on when the days of the last use cannot be removed', async () => {
    const state = privateDir('state');
    const { prepareQuotaFolder } =
      await import('@ecclium/mcp-churchtools-core/composition');
    expect(prepareQuotaFolder(state).ok).toBe(true);
    // A file the store did not write: another tenant in it.
    privateFile(
      join(state, 'quota', 'default.last-use.json'),
      JSON.stringify({ v: 1, tenant: 'other-tenant', lastUse: {} }),
    );
    const session = setup({ state });
    await session.bound;
    expect(
      session
        .logLines()
        .filter((line) => line['event'] === 'http_last_use_not_pruned'),
    ).toHaveLength(1);
    session.signal('SIGTERM');
    await expect(session.run).resolves.toBe(exitCodes.terminated);
  });

  it('closes at once when a signal came while it bound', async () => {
    let finish: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let closed = 0;
    const session = setup({
      listen: async (settings) => {
        await late;
        return Object.freeze({
          address: settings.host ?? '127.0.0.1',
          port: settings.port,
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        }) as never;
      },
    });
    await vi.waitFor(() => {
      expect(session.notices()).toContain(serveHttpTexts.readOnly);
    });
    session.signal('SIGTERM');
    finish();
    await expect(session.run).resolves.toBe(exitCodes.terminated);
    expect(closed).toBe(1);
  });

  it('removes the days of the last use past 365 days on each new UTC day', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const session = setup();
      await session.bound;
      const store = createFileQuotaStore({
        stateDir: session.state,
        clock,
        pid: 4242,
        host: 'example-host',
      });
      const { bearerLastUseKey } =
        await import('@ecclium/mcp-churchtools-plugin-api');
      await store.noteLastUse(
        'default' as Parameters<typeof store.noteLastUse>[0],
        bearerLastUseKey('reader'),
        '2025-01-01' as IsoDate,
      );
      // The timer looks at least every hour.
      await vi.advanceTimersByTimeAsync(3_600_000);
      await vi.waitFor(() => {
        expect(
          session
            .logLines()
            .filter((line) => line['event'] === 'http_last_use_pruned'),
        ).toHaveLength(1);
      });
      await expect(readBearerLastUse(store, 'reader')).resolves.toBeUndefined();
      session.signal('SIGTERM');
      await expect(session.run).resolves.toBe(exitCodes.terminated);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the texts of ecclium serve-http', () => {
  const texts = [
    ...Object.values(serveHttpTexts),
    tokensText(1, 0),
    tokensText(2, 1),
    tokensText(1_200, 3),
    listeningText({ address: '127.0.0.1', port: 8765 }),
    listeningText({ address: '::1', port: 8765 }),
    bindText('address', undefined),
    bindText('allowed-hosts', undefined),
    bindText('port', undefined),
    bindText('listen', 'EADDRINUSE'),
    bindText('listen', 'EACCES'),
    bindText('listen', 'EADDRNOTAVAIL'),
    bindText('listen', undefined),
  ];

  // Chapter 9 of brand/README.md, as for the other texts of the command
  // line: «Sie», ss, quotes «so», no em dash, numbers from 1000 up as
  // 4'096; a port in an address is no such number.
  it.each(texts)('follows the rules of the brand in %s', (text) => {
    const plain = text.replace(/https?:\/\/\S+/g, '');
    expect(plain.replace(/(?<=\d)'(?=\d{3})/g, '')).not.toMatch(
      /[ß—–!"„“”'‚‘’]/,
    );
    expect(plain).not.toMatch(/\d{4}/);
    expect(text.split('‹').length).toBe(text.split('›').length);
    expect(text).not.toMatch(/\b(du|dein|deine|dich|dir)\b/i);
  });

  it('writes an address of IPv6 in brackets', () => {
    expect(listeningText({ address: '::1', port: 8765 })).toContain(
      '‹http://[::1]:8765/mcp›',
    );
  });

  it('names one token in the singular and many in the plural', () => {
    expect(tokensText(1, 0)).toContain('ein Token, das heute gilt');
    expect(tokensText(2, 0)).toContain('2 Tokens, die heute gelten');
    expect(tokensText(2, 0)).not.toContain('write');
  });
});
