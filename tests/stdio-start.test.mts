import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createServer as createTcpServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertNoCanary,
  assertPlanted,
  findCanaries,
  makeCanaries,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  auditFileText,
  problemText,
  toolsetsText,
  warningText,
} from '../packages/cli/src/messages/index.ts';
import { fixedSentences } from '../packages/core/src/errors/index.ts';
import { specialReadBudget } from '../packages/core/src/quota/index.ts';
import {
  type Certificate,
  findOpenssl,
  makeCertificate,
} from './support/certificates.mts';
import { blockedMarker, guardPreload } from './support/no-network.mts';
import {
  at,
  type Era,
  eras,
  type Finished,
  type Json,
  jsonLines,
  legacy,
  modern,
  protocolViolations,
  type Session,
  startSession,
} from './support/stdio-session.mts';

// The real start over stdio, as a client runs it: `ecclium stdio`, that is
// packages/cli/src/bin.ts, in a child process from source, with the
// resolution hook of the stdio test, the condition @ecclium/source, the
// network guard alone in NODE_OPTIONS (ADR 0052), only the variables a
// client sets for the server and the token in a file with mode 0600 in a
// temporary folder. The unit tests of the start replace the process, the
// stderr writer and the transport; here all of them are real.
//
// The configuration takes neither an IP address nor localhost as the
// address of ChurchTools, and the guard refuses every name resolution. So
// the first case lets the guard refuse the connection to demo.example, and
// the others load tests/fixtures/start/redirect.mts, which sends that host
// to a server of this test on 127.0.0.1. The server speaks TLS with a
// certificate that openssl makes for demo.example in the temporary folder,
// which the child trusts through NODE_EXTRA_CA_CERTS, and plays ChurchTools
// with synthetic answers. The guard and an internal error both end the
// process with 70, so every case checks the lines on stdout and stderr,
// never the exit code alone (ADR 0053, ADR 0054, ADR 0055).

const bin = fileURLToPath(
  new URL('../packages/cli/src/bin.ts', import.meta.url),
);
const hooks = new URL('fixtures/stdio/hooks.mts', import.meta.url).href;

/** The option that preloads a file of tests/fixtures/start/, with a query. */
const preload = (name: string): string =>
  `--import=${new URL(`fixtures/start/${name}`, import.meta.url).href}`;

const host = 'demo.example';
const canary = makeCanaries();
const [firstName = '', lastName = ''] = canary.name.cores;
const timeout = 60_000;

let folder = '';
let tokenFile = '';
let certificate: Certificate = { key: '', cert: '' };
const children: ChildProcessWithoutNullStreams[] = [];
const servers: (() => Promise<void>)[] = [];

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'ecclium-start-'));
  tokenFile = join(folder, 'token');
  // The loader refuses a token file that others may read.
  writeFileSync(tokenFile, canary.token.value, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  certificate = makeCertificate(findOpenssl(), folder, 'demo', host);
}, timeout);

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.all(servers.map((close) => close()));
  if (folder !== '') rmSync(folder, { recursive: true, force: true });
});

/** How a child starts, beyond what every child gets. */
interface Launch {
  /** The address of ChurchTools. */
  readonly origin: string;
  /** Where the token comes from: the file or the variable. */
  readonly token?: 'file' | 'variable';
  /** Files of tests/fixtures/start/ to preload, after the hook. */
  readonly preloads?: readonly string[];
  /** More variables. */
  readonly env?: Readonly<Record<string, string>>;
  /** The arguments of the executable; `stdio` if left out. */
  readonly args?: readonly string[];
}

const launch = (options: Launch): Session => {
  const session = startSession(
    [
      '--conditions=@ecclium/source',
      `--import=${hooks}`,
      ...(options.preloads ?? []).map(preload),
      bin,
      ...(options.args ?? ['stdio']),
    ],
    {
      // Only these variables: the network guard, and the address and the
      // token as a client sets them. The shell that runs the tests may hold
      // variables of the project, and options of Node.js in NODE_OPTIONS,
      // such as one for TLS, would change what the start reports.
      NODE_OPTIONS: guardPreload,
      ECCLIUM_CHURCHTOOLS_URL: options.origin,
      ...(options.token === 'variable'
        ? { ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value }
        : { ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenFile }),
      ...options.env,
    },
  );
  children.push(session.child);
  return session;
};

/** A child that reaches a server of this test over TLS. */
const overTls = (origin: string): Launch => ({
  origin,
  preloads: ['redirect.mts'],
  env: { NODE_EXTRA_CA_CERTS: certificate.cert },
});

/** A request as a server of this test saw it. */
interface Seen {
  readonly path: string;
  /** The header lines as name: value, in the order of the request. */
  readonly headers: readonly string[];
}

/** A server of this test on 127.0.0.1. */
interface TestServer {
  /** The address for the child: demo.example with the port. */
  readonly origin: string;
  /** Every request that came, for a server with TLS and HTTP. */
  readonly requests: readonly Seen[];
  /** How many connections came. */
  readonly connections: () => number;
}

/** Listens on a free port of 127.0.0.1 and gives the address for the child. */
const listen = (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolve(`https://${host}:${String(port)}`);
    });
  });

/** Answers a request as ChurchTools would, or holds or drops it. */
type Answer = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * Starts a server with TLS and HTTP that shows the certificate of the test
 * and answers every request with the answer.
 */
const serveTls = async (answer: Answer): Promise<TestServer> => {
  const requests: Seen[] = [];
  let connections = 0;
  const server = createTlsServer(
    {
      key: readFileSync(certificate.key),
      cert: readFileSync(certificate.cert),
    },
    (request, response) => {
      const raw = request.rawHeaders;
      const headers: string[] = [];
      for (let index = 0; index + 1 < raw.length; index += 2) {
        headers.push(`${raw[index] ?? ''}: ${raw[index + 1] ?? ''}`);
      }
      requests.push({ path: request.url ?? '', headers });
      answer(request, response);
    },
  );
  server.on('secureConnection', () => {
    connections += 1;
  });
  servers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const origin = await listen(server);
  return { origin, requests, connections: () => connections };
};

/** Starts a server that closes every connection at once, before TLS. */
const serveReset = async (): Promise<TestServer> => {
  let connections = 0;
  const server = createTcpServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  servers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const origin = await listen(server);
  return { origin, requests: [], connections: () => connections };
};

const json = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

// Synthetic answers: an account whose names and e-mail address are
// canaries, and rights of which two are set, one of them with a list.
const churchTools: Answer = (request, response) => {
  if (request.url === '/api/whoami?only_allow_authenticated=true') {
    json(response, {
      data: {
        id: 7,
        guid: '00000000-0000-0000-0000-000000000007',
        firstName,
        lastName,
        email: canary.email.value,
      },
    });
  } else if (request.url === '/api/permissions/global') {
    json(response, {
      data: {
        churchcore: { 'administer settings': false },
        churchwiki: { 'view category': [12, 0, 3], view: true, edit: false },
      },
    });
  } else {
    response.writeHead(404);
    response.end();
  }
};

// The set rights as ct_whoami lists them: sorted, the IDs ascending.
const rights = {
  status: 'known',
  modules: [
    {
      module: 'churchwiki',
      rights: [
        { right: 'view' },
        { right: 'view category', ids: [0, 3, 12], idCount: 3 },
      ],
    },
  ],
};

/** Calls ct_whoami with the id and waits for the answer. */
const whoami = (session: Session, era: Era, id: number): Promise<Json> => {
  session.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: era.params({ name: 'ct_whoami', arguments: {} }),
  });
  return session.response(id);
};

/** The lines of a text, without the empty rest after the last break. */
const linesOf = (text: string): string[] => text.split('\n').slice(0, -1);

const isJsonLine = (line: string): boolean => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
};

/** A log line without its time stamp, which must be there. */
const withoutTs = (line: Json | undefined): Json => {
  const { ts, ...rest } = line ?? {};
  expect(typeof ts).toBe('string');
  return rest;
};

/** Checks that stderr starts with the notices and then holds only JSON. */
const expectNoticesThenJson = (
  stderr: string,
  notices: readonly string[],
): void => {
  expect(stderr.endsWith('\n')).toBe(true);
  const lines = linesOf(stderr);
  expect(lines.slice(0, notices.length)).toEqual(notices);
  expect(
    lines.slice(notices.length).filter((line) => !isJsonLine(line)),
  ).toEqual([]);
};

/** The audit lines of the calls. */
const auditOf = (stderr: string): Json[] =>
  jsonLines(stderr).filter((line) => line['type'] === 'tool_call');

/** The log lines of the transport, whose events start with http_. */
const transportOf = (stderr: string): Json[] =>
  jsonLines(stderr).filter(
    (line) =>
      typeof line['event'] === 'string' && line['event'].startsWith('http_'),
  );

/** The events of the log, in their order. */
const eventsOf = (stderr: string): unknown[] =>
  jsonLines(stderr).flatMap((line) =>
    line['event'] === undefined ? [] : [line['event']],
  );

/** The parts of the path of the certificate that must stay out of stderr. */
const pathParts = (): string[] => [
  folder,
  basename(folder),
  basename(certificate.cert),
];

/** Whether an answer is the result of a call that ended with network. */
const expectNetworkResult = (answer: Json): void => {
  expect(at(answer, 'result', 'isError')).toBe(true);
  expect(at(answer, 'result', 'content', 0)).toEqual({
    type: 'text',
    text: fixedSentences.network,
  });
};

/** The audit line of a call of ct_whoami in the mode of the start. */
const callAudit = (outcome: 'ok' | 'error', errorCode?: string): Json => ({
  type: 'tool_call',
  tenantId: 'default',
  mode: 'interactive',
  tool: 'ct_whoami',
  outcome,
  ...(errorCode === undefined ? {} : { errorCode }),
});

describe.each(eras)('the stdio start in the $name era', { timeout }, (era) => {
  let server: TestServer;
  let listed: Json;
  let called: Json;
  let finished: Finished;
  beforeAll(async () => {
    server = await serveTls(churchTools);
    const session = launch(overTls(server.origin));
    await era.open(session);
    session.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: era.params({}),
    });
    listed = await session.response(2);
    called = await whoami(session, era, 3);
    finished = await session.finish();
  }, timeout);

  it('writes only JSON-RPC 2.0 on stdout, line by line', () => {
    expect(protocolViolations(finished.stdout)).toEqual([]);
    expect(jsonLines(finished.stdout).map((line) => line['id'])).toEqual([
      1, 2, 3,
    ]);
  });

  it('lists exactly ct_whoami', () => {
    const tools = at(listed, 'result', 'tools') as readonly Json[];
    expect(tools.map((tool) => tool['name'])).toEqual(['ct_whoami']);
  });

  it('returns the account with the e-mail address masked and the set rights', () => {
    expect(at(called, 'result', 'isError')).toBeUndefined();
    const { email, ...account } = at(
      called,
      'result',
      'structuredContent',
    ) as Json;
    expect(account).toEqual({ id: 7, firstName, lastName, rights });
    expect(email).toMatch(/^[a-z0-9]\*\*\*@example\.org$/);
  });

  it('writes the warning about the trust store first, then only JSON, and no part of the path', () => {
    expectNoticesThenJson(finished.stderr, [
      warningText('trust_store_extended'),
    ]);
    for (const part of pathParts()) {
      expect(finished.stderr).not.toContain(part);
    }
  });

  it('records the call in the audit and the requests under the tenant default', () => {
    expect(auditOf(finished.stderr)).toEqual([
      expect.objectContaining(callAudit('ok')),
    ]);
    expect(transportOf(finished.stderr)).toEqual([
      expect.objectContaining({
        event: 'http_response',
        tenantId: 'default',
        status: 200,
      }),
      expect.objectContaining({
        event: 'http_response',
        tenantId: 'default',
        status: 200,
      }),
    ]);
  });

  it('gives the log line of the call the event ID of its audit line', () => {
    const [audit, ...rest] = auditOf(finished.stderr);
    expect(rest).toEqual([]);
    const calls = jsonLines(finished.stderr).filter(
      (line) => line['event'] === 'tool_call',
    );
    expect(calls).toHaveLength(1);
    expect(audit?.['eventId']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The nil UUID is the placeholder of a failed ID, not an ID.
    expect(audit?.['eventId']).not.toBe('00000000-0000-0000-0000-000000000000');
    expect(calls[0]?.['eventId']).toBe(audit?.['eventId']);
  });

  it('sends the token only in the header of each request', () => {
    expect(server.requests.map((request) => request.path)).toEqual([
      '/api/whoami?only_allow_authenticated=true',
      '/api/permissions/global',
    ]);
    const authorization = server.requests.flatMap((request) =>
      request.headers.filter((line) => line.startsWith('authorization: ')),
    );
    assertPlanted(authorization, [canary.token], 'the requests');
    expect(authorization).toEqual([
      `authorization: Login ${canary.token.value}`,
      `authorization: Login ${canary.token.value}`,
    ]);
    assertNoCanary(finished.stdout, [canary.token, canary.email], 'stdout');
    assertNoCanary(finished.stderr, canary.all, 'stderr');
  });

  it('ends with 0 when stdin ends, after stdio_closed with the count of lost lines', () => {
    expect(finished.code).toBe(0);
    expect(withoutTs(jsonLines(finished.stderr).at(-1))).toEqual({
      level: 'info',
      event: 'stdio_closed',
      count: 0,
    });
  });
});

describe('the token in the environment', { timeout }, () => {
  let server: TestServer;
  let called: Json;
  let finished: Finished;
  beforeAll(async () => {
    server = await serveTls(churchTools);
    const session = launch({ ...overTls(server.origin), token: 'variable' });
    await legacy.open(session);
    called = await whoami(session, legacy, 2);
    finished = await session.finish();
  }, timeout);

  it('gives a warning among the start notices', () => {
    expectNoticesThenJson(finished.stderr, [
      warningText('token_from_environment'),
      warningText('trust_store_extended'),
    ]);
  });

  it('goes out in the header and nowhere else', () => {
    expect(at(called, 'result', 'structuredContent', 'id')).toBe(7);
    assertPlanted(server.requests, [canary.token], 'the requests');
    assertNoCanary(finished.stdout, [canary.token, canary.email], 'stdout');
    assertNoCanary(finished.stderr, canary.all, 'stderr');
    expect(finished.code).toBe(0);
  });
});

describe('a call whose connection fails', { timeout }, () => {
  it('ends with network when the guard refuses it, and the guard ends the process with 70', async () => {
    const server = await serveReset();
    const session = launch({ origin: server.origin });
    await modern.open(session);
    const answer = await whoami(session, modern, 2);
    const { code, stdout, stderr } = await session.finish();
    // network, not policy_denied: the mode of the call is interactive.
    expectNetworkResult(answer);
    expect(auditOf(stderr)).toEqual([
      expect.objectContaining(callAudit('error', 'network')),
    ]);
    const blocked = linesOf(stderr).filter((line) => !isJsonLine(line));
    expect(blocked.length).toBeGreaterThan(0);
    for (const line of blocked) {
      expect(line).toContain(blockedMarker);
    }
    expect(stderr).toContain(
      `TCP-Verbindung zu ${new URL(server.origin).host}`,
    );
    expect(eventsOf(stderr)).not.toContain('process_uncaught_exception');
    expect(server.connections()).toBe(0);
    expect(code).toBe(70);
    assertNoCanary(stdout, [canary.token], 'stdout');
    assertNoCanary(stderr, [canary.token], 'stderr');
  });

  it('ends with network when the server closes the connection at once', async () => {
    const server = await serveReset();
    const session = launch({
      origin: server.origin,
      preloads: ['redirect.mts'],
    });
    await modern.open(session);
    const answer = await whoami(session, modern, 2);
    const { code, stdout, stderr } = await session.finish();
    expectNetworkResult(answer);
    expect(server.connections()).toBeGreaterThan(0);
    expectNoticesThenJson(stderr, []);
    expect(transportOf(stderr)).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        tenantId: 'default',
        code: 'network',
      }),
    );
    expect(auditOf(stderr)).toEqual([
      expect.objectContaining(callAudit('error', 'network')),
    ]);
    expect(eventsOf(stderr).at(-1)).toBe('stdio_closed');
    expect(code).toBe(0);
    assertNoCanary(stdout, [canary.token], 'stdout');
    assertNoCanary(stderr, [canary.token], 'stderr');
  });

  it('ends with network when the server drops it after reading the header with the token', async () => {
    const server = await serveTls((request) => {
      request.socket.destroy();
    });
    const session = launch(overTls(server.origin));
    await legacy.open(session);
    const answer = await whoami(session, legacy, 2);
    const { code, stdout, stderr } = await session.finish();
    expectNetworkResult(answer);
    const authorization = server.requests.flatMap((request) =>
      request.headers.filter((line) => line.startsWith('authorization: ')),
    );
    assertPlanted(authorization, [canary.token], 'the requests');
    expect(authorization[0]).toBe(`authorization: Login ${canary.token.value}`);
    expectNoticesThenJson(stderr, [warningText('trust_store_extended')]);
    for (const part of pathParts()) {
      expect(stderr).not.toContain(part);
    }
    expect(transportOf(stderr)).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        tenantId: 'default',
        code: 'network',
      }),
    );
    expect(auditOf(stderr)).toEqual([
      expect.objectContaining(callAudit('error', 'network')),
    ]);
    expect(code).toBe(0);
    assertNoCanary(stdout, [canary.token], 'stdout');
    assertNoCanary(stderr, [canary.token], 'stderr');
  });
});

describe('the end of the process', { timeout }, () => {
  it('ends a held call with network in the audit and the process with 143 on SIGTERM', async () => {
    // The server never answers, so only the end of the server ends the call.
    const server = await serveTls(() => undefined);
    const session = launch(overTls(server.origin));
    await legacy.open(session);
    session.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: legacy.params({ name: 'ct_whoami', arguments: {} }),
    });
    await vi.waitFor(
      () => {
        expect(server.requests).toHaveLength(1);
      },
      { timeout: 20_000, interval: 10 },
    );
    session.child.kill('SIGTERM');
    const { code, stdout, stderr } = await session.ended();
    expectNoticesThenJson(stderr, [warningText('trust_store_extended')]);
    const events = jsonLines(stderr);
    const sigterm = events.findIndex(
      (line) => line['event'] === 'process_sigterm',
    );
    const audit = events.findIndex((line) => line['type'] === 'tool_call');
    const closed = events.findIndex((line) => line['event'] === 'stdio_closed');
    expect(events[sigterm]).toMatchObject({ level: 'info' });
    expect(events[audit]).toMatchObject(callAudit('error', 'network'));
    expect(events[closed]).toMatchObject({ count: 0 });
    expect(sigterm).toBeLessThan(audit);
    expect(audit).toBeLessThan(closed);
    // The server ended, so the call gets no answer.
    expect(protocolViolations(stdout)).toEqual([]);
    expect(jsonLines(stdout).map((line) => line['id'])).toEqual([1]);
    expect(code).toBe(143);
  });
});

const crashCanary = makeCanary('token');

describe(
  'an error that nothing catches in the running server',
  { timeout },
  () => {
    const crash = async (
      how: 'throw' | 'reject' | 'bare',
    ): Promise<Finished> => {
      const session = launch({
        origin: `https://${host}`,
        preloads: [`crash.mts?${how}`],
        env: { START_FIXTURE_CANARY: crashCanary.value },
      });
      // With the first answer the handlers of the start are in place.
      await modern.open(session);
      session.child.kill('SIGUSR2');
      return session.ended();
    };

    it.each([
      ['throw', 'process_uncaught_exception'],
      ['reject', 'process_unhandled_rejection'],
    ] as const)(
      'ends the process with ?%s after one fixed line and 70',
      async (how, event) => {
        const { code, stdout, stderr } = await crash(how);
        const lines = linesOf(stderr);
        expect(lines).toHaveLength(1);
        expect(withoutTs(JSON.parse(lines[0] ?? '{}') as Json)).toEqual({
          level: 'error',
          event,
          code: 'internal',
        });
        expect(code).toBe(70);
        assertNoCanary(stdout, [crashCanary, canary.token], 'stdout');
        assertNoCanary(stderr, [crashCanary, canary.token], 'stderr');
      },
    );

    it('shows the canary without the handlers of the start, and Node.js ends with 1', async () => {
      const { code, stderr } = await crash('bare');
      expect(findCanaries(stderr, [crashCanary])).not.toEqual([]);
      expect(eventsOf(stderr)).toEqual([]);
      expect(code).toBe(1);
    });
  },
);

describe('the way over stdio', { timeout }, () => {
  // Names under which the ES module of node:util loads.
  const util = ['node:util', 'util', 'node:sys', 'sys'];

  // Starts the executable with the arguments and the recorder, and gives
  // the built-in modules it imported as ES modules.
  const imported = async (
    name: string,
    args: readonly string[],
  ): Promise<{ finished: Finished; modules: string[] }> => {
    const record = join(folder, `${name}.json`);
    const session = launch({
      origin: `https://${host}`,
      preloads: ['imports.mts'],
      env: { START_FIXTURE_RECORD: record },
      args,
    });
    const finished = await session.finish();
    return {
      finished,
      modules: JSON.parse(readFileSync(record, 'utf8')) as string[],
    };
  };

  it('never loads node:util as an ES module', async () => {
    const { finished, modules } = await imported('stdio', ['stdio']);
    expect(finished.code).toBe(0);
    expect(eventsOf(finished.stderr)).toEqual(['stdio_closed']);
    // A module the start imports as an ES module: the record works.
    expect(modules).toContain('node:util/types');
    for (const name of util) {
      expect(modules).not.toContain(name);
    }
  });

  it('records node:util for the command line in main.ts', async () => {
    const { finished, modules } = await imported('help', ['--help']);
    expect(finished.code).toBe(0);
    expect(modules).toContain('node:util');
  });
});

describe('stderr that nobody reads', { timeout }, () => {
  const calls = 1000;

  it('holds back no answer on stdout, and stdio_closed counts the lost lines', async () => {
    const session = launch({ origin: `https://${host}` });
    // Paused before the first data: the pipe fills and stays full.
    session.child.stderr.pause();
    await modern.open(session);
    for (let id = 2; id < calls + 2; id += 1) {
      session.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: modern.params({ name: 'ct_not_there', arguments: {} }),
      });
    }
    await session.response(calls + 1);
    // Reads stderr again until it stays quiet, so that the line at the end
    // finds room in the pipe.
    let last = Date.now();
    session.child.stderr.on('data', () => {
      last = Date.now();
    });
    session.child.stderr.resume();
    await vi.waitFor(
      () => {
        if (Date.now() - last < 300) throw new Error('stderr still drains');
      },
      { timeout: 20_000, interval: 50 },
    );
    const { code, stdout, stderr } = await session.finish();
    expect(protocolViolations(stdout)).toEqual([]);
    expect(jsonLines(stdout)).toHaveLength(calls + 1);
    const closed = jsonLines(stderr).findLast(
      (line) => line['event'] === 'stdio_closed',
    );
    expect(closed?.['count']).toBeGreaterThan(0);
    expect(code).toBe(0);
  });
});

// The audit file at the real start (ADR 0028): with ECCLIUM_STATE_DIR the
// start writes every audit line into a file of its own first and the copy
// to stderr after it. Calls of an unknown tool need no instance, so these
// cases run without a server of this test.
describe('the audit file of the real start', { timeout }, () => {
  /** A folder of state with the mode given, inside the folder of the test. */
  const stateDirWith = (mode: number): string => {
    const made = mkdtempSync(join(folder, 'state-'));
    chmodSync(made, mode);
    return made;
  };

  /** Starts with the folder of state and calls an unknown tool n times. */
  const callUnknown = async (
    stateDir: string,
    calls: number,
    pauseStderr = false,
  ): Promise<Finished> => {
    const session = launch({
      origin: `https://${host}`,
      env: { ECCLIUM_STATE_DIR: stateDir },
    });
    if (pauseStderr) session.child.stderr.pause();
    await modern.open(session);
    for (let id = 2; id < calls + 2; id += 1) {
      session.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: modern.params({ name: 'ct_not_there', arguments: {} }),
      });
    }
    await session.response(calls + 1);
    if (pauseStderr) {
      let last = Date.now();
      session.child.stderr.on('data', () => {
        last = Date.now();
      });
      session.child.stderr.resume();
      await vi.waitFor(
        () => {
          if (Date.now() - last < 300) throw new Error('stderr still drains');
        },
        { timeout: 20_000, interval: 50 },
      );
    }
    return session.finish();
  };

  /** The lines of the one audit file in the folder of state. */
  const fileLines = (stateDir: string): Json[] => {
    const audit = join(stateDir, 'audit');
    const names = readdirSync(audit);
    expect(names).toHaveLength(1);
    expect(statSync(audit).mode & 0o777).toBe(0o700);
    // Mode and content through one descriptor, so both belong to the same
    // file.
    const fd = openSync(join(audit, names[0] ?? ''), 'r');
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      return jsonLines(readFileSync(fd, 'utf8'));
    } finally {
      closeSync(fd);
    }
  };

  it('writes each audit line into a file with 0600 in a folder with 0700, the same as the copy', async () => {
    const stateDir = stateDirWith(0o700);
    const { code, stderr } = await callUnknown(stateDir, 3);
    expect(code).toBe(0);
    const inFile = fileLines(stateDir);
    expect(inFile).toHaveLength(3);
    expect(inFile).toEqual(auditOf(stderr));
    expect(inFile[0]).toMatchObject({
      tool: 'ct_unknown',
      outcome: 'error',
      errorCode: 'not_found',
    });
    const events = eventsOf(stderr);
    expect(events.slice(-2)).toEqual(['audit_file_closed', 'stdio_closed']);
    expect(
      jsonLines(stderr).find((line) => line['event'] === 'audit_file_closed'),
    ).toMatchObject({ count: 0 });
  });

  it('keeps every audit line in the file while nobody reads stderr', async () => {
    const stateDir = stateDirWith(0o700);
    const calls = 1000;
    const { code, stdout, stderr } = await callUnknown(stateDir, calls, true);
    expect(code).toBe(0);
    expect(jsonLines(stdout)).toHaveLength(calls + 1);
    expect(fileLines(stateDir)).toHaveLength(calls);
    // stderr lost copies, the file lost nothing.
    const closed = jsonLines(stderr).findLast(
      (line) => line['event'] === 'stdio_closed',
    );
    expect(closed?.['count']).toBeGreaterThan(0);
  });

  it('ends with 78 for a folder of state that others may open, and creates nothing', async () => {
    const stateDir = stateDirWith(0o755);
    const session = launch({
      origin: `https://${host}`,
      env: { ECCLIUM_STATE_DIR: stateDir },
    });
    const { code, stdout, stderr } = await session.ended();
    expect(code).toBe(78);
    expect(stdout).toBe('');
    expect(linesOf(stderr)).toEqual([
      problemText({ code: 'state_dir_mode', variable: 'ECCLIUM_STATE_DIR' }),
    ]);
    expect(existsSync(join(stateDir, 'audit'))).toBe(false);
    assertNoCanary(stderr, [canary.token], 'stderr');
  });

  it('ends with 78 for the toolset persons without a folder of state, before any connection', async () => {
    const session = launch({
      origin: `https://${host}`,
      env: { ECCLIUM_TOOLSETS: 'persons' },
    });
    const { code, stdout, stderr } = await session.ended();
    expect(code).toBe(78);
    expect(stdout).toBe('');
    expect(linesOf(stderr)).toEqual([
      problemText({
        code: 'toolsets_without_state_dir',
        variable: 'ECCLIUM_STATE_DIR',
      }),
      warningText('persons_toolset_enabled'),
    ]);
  });

  // The switch of phase 1 for the search tools stops the start with a
  // pointer to the toolset that replaced it (ADR 0062).
  it('ends with 78 for the replaced switch of the search tools, before any connection', async () => {
    const session = launch({
      origin: `https://${host}`,
      env: { ECCLIUM_SEARCH_TOOLS: 'true' },
    });
    const { code, stdout, stderr } = await session.ended();
    expect(code).toBe(78);
    expect(stdout).toBe('');
    expect(linesOf(stderr)).toEqual([
      problemText({
        code: 'search_tools_replaced',
        variable: 'ECCLIUM_SEARCH_TOOLS',
      }),
    ]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'ends with 78 when the folder audit cannot be created',
    async () => {
      const stateDir = stateDirWith(0o500);
      const session = launch({
        origin: `https://${host}`,
        env: { ECCLIUM_STATE_DIR: stateDir },
      });
      const { code, stdout, stderr } = await session.ended();
      chmodSync(stateDir, 0o700);
      expect(code).toBe(78);
      expect(stdout).toBe('');
      expect(linesOf(stderr)).toEqual([
        auditFileText('audit_file_folder_unavailable'),
      ]);
      expect(stderr).not.toContain(stateDir);
    },
  );
});

// The search tools at the real start (ADR 0060, ADR 0028): with the
// toolset persons and a folder of state the start lists them, a call
// returns ID and names, and its line stands in the audit file without the
// term or a name. When the line cannot reach the file, the result stays
// back. The server of this test plays ChurchTools: persons whose names are
// canaries, a group whose name is one.
describe.skipIf(process.getuid?.() === 0)(
  'the search tools at the real start',
  { timeout },
  () => {
    const term = makeCanary('name');
    const person = makeCanaries();
    const [personFirst = '', personLast = ''] = person.name.cores;
    const group = makeCanary('name');

    /** A folder of state with 0700 inside the folder of the test. */
    const freshStateDir = (): string => {
      const made = mkdtempSync(join(folder, 'search-'));
      chmodSync(made, 0o700);
      return made;
    };

    // Answers the two searches; with `lock`, a search for persons first
    // deletes the audit file and locks its folder, so the line of the call
    // cannot reach a file.
    const searches =
      (stateDir: string, lock: boolean): Answer =>
      (request, response) => {
        const url = request.url ?? '';
        if (url.startsWith('/api/persons?')) {
          if (lock) {
            const audit = join(stateDir, 'audit');
            for (const name of readdirSync(audit)) rmSync(join(audit, name));
            chmodSync(audit, 0o500);
          }
          json(response, {
            data: [
              {
                id: 11,
                firstName: personFirst,
                lastName: personLast,
                email: person.email.value,
                mobile: person.phone.value,
              },
            ],
            meta: { count: 1 },
          });
        } else if (url.startsWith('/api/groups?')) {
          json(response, {
            data: [{ id: 21, name: group.value, information: {} }],
            meta: { count: 1 },
          });
        } else {
          churchTools(request, response);
        }
      };

    /** Calls one search tool with the term and waits for the answer. */
    const search = (
      session: Session,
      era: Era,
      id: number,
      name: string,
    ): Promise<Json> => {
      session.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: era.params({ name, arguments: { query: term.value } }),
      });
      return session.response(id);
    };

    /** The lines of the one audit file in a folder of state. */
    const fileLines = (stateDir: string): Json[] => {
      const audit = join(stateDir, 'audit');
      const names = readdirSync(audit);
      expect(names).toHaveLength(1);
      return jsonLines(readFileSync(join(audit, names[0] ?? ''), 'utf8'));
    };

    describe.each(eras)('in the $name era', (era) => {
      let stateDir = '';
      let server: TestServer;
      let listed: Json;
      let persons: Json;
      let groups: Json;
      let finished: Finished;

      beforeAll(async () => {
        stateDir = freshStateDir();
        server = await serveTls(searches(stateDir, false));
        const launched = overTls(server.origin);
        const session = launch({
          ...launched,
          env: {
            ...launched.env,
            ECCLIUM_TOOLSETS: 'persons',
            ECCLIUM_STATE_DIR: stateDir,
          },
        });
        await era.open(session);
        session.send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: era.params({}),
        });
        listed = await session.response(2);
        persons = await search(session, era, 3, 'ct_persons_search');
        groups = await search(session, era, 4, 'ct_groups_search');
        finished = await session.finish();
      }, timeout);

      it('lists the six tools of persons and groups and the global search next to ct_whoami and warns at the start', () => {
        const tools = at(listed, 'result', 'tools') as Json[];
        expect(tools.map((tool) => tool['name'])).toEqual([
          'ct_groups_get',
          'ct_groups_get_members',
          'ct_groups_search',
          'ct_persons_get',
          'ct_persons_get_groups',
          'ct_persons_search',
          'ct_search',
          'ct_whoami',
        ]);
        expect(linesOf(finished.stderr)).toContain(
          warningText('persons_toolset_enabled'),
        );
        expect(linesOf(finished.stderr)).toContain(toolsetsText(['persons']));
        expect(protocolViolations(finished.stdout)).toEqual([]);
      });

      it('returns ID and names of the person and of the group, nothing else', () => {
        expect(at(persons, 'result', 'isError')).toBeUndefined();
        expect(at(persons, 'result', 'structuredContent')).toEqual({
          persons: [{ id: 11, firstName: personFirst, lastName: personLast }],
          more: false,
          notice: null,
        });
        const named = at(groups, 'result', 'structuredContent', 'groups', 0);
        expect((named as Json)['id']).toBe(21);
        expect(String((named as Json)['name'])).toContain(group.value);
        assertNoCanary(
          finished.stdout,
          [person.email, person.phone, canary.token],
          'stdout',
        );
      });

      it('sends exactly query, page and limit for each search', () => {
        const paths = server.requests.map((seen) => seen.path);
        expect(paths).toHaveLength(2);
        for (const [index, pathname] of [
          '/api/persons',
          '/api/groups',
        ].entries()) {
          const url = new URL(
            paths[index] ?? '',
            'https://placeholder.example',
          );
          expect(url.pathname).toBe(pathname);
          expect([...url.searchParams]).toEqual([
            ['query', term.value],
            ['page', '1'],
            ['limit', '51'],
          ]);
        }
      });

      it('records both calls in the audit file, without the term or a name', () => {
        const inFile = fileLines(stateDir);
        expect(inFile).toEqual(auditOf(finished.stderr));
        expect(inFile.map((line) => [line['tool'], line['outcome']])).toEqual([
          ['ct_persons_search', 'ok'],
          ['ct_groups_search', 'ok'],
        ]);
        assertNoCanary(
          [inFile, finished.stderr],
          [term, person.name, group, person.email, person.phone],
          'audit and stderr',
        );
      });
    });

    // The read budget at the real start (ADR 0063): the counter lies in the
    // folder of state and survives a restart. The file says that the actor
    // has one call left today.
    describe('the read budget across a restart', () => {
      let stateDir = '';
      let first: Json;
      let second: Json;
      let secondRun: Finished;
      let day = '';
      const counted = (): unknown =>
        JSON.parse(
          readFileSync(join(stateDir, 'quota', `default-${day}.json`), 'utf8'),
        );

      beforeAll(async () => {
        // The children count on the UTC day of their own clock. Close to
        // midnight, the test waits for the new day, so that both runs count
        // on the day of the file.
        const now = Date.now();
        const untilMidnight = 86_400_000 - (now % 86_400_000);
        if (untilMidnight < 20_000) {
          await new Promise((resolve) => {
            setTimeout(resolve, untilMidnight + 1000);
          });
        }
        day = new Date().toISOString().slice(0, 10);
        stateDir = freshStateDir();
        const quota = join(stateDir, 'quota');
        mkdirSync(quota, { mode: 0o700 });
        chmodSync(quota, 0o700);
        writeFileSync(
          join(quota, `default-${day}.json`),
          JSON.stringify({
            v: 1,
            tenant: 'default',
            day,
            counts: {
              'user:stdio:local-stdio': {
                special_reads: specialReadBudget - 1,
              },
            },
          }),
          { mode: 0o600 },
        );
        const server = await serveTls(searches(stateDir, false));
        const run = async (): Promise<readonly [Json, Finished]> => {
          const launched = overTls(server.origin);
          const session = launch({
            ...launched,
            env: {
              ...launched.env,
              ECCLIUM_TOOLSETS: 'persons',
              ECCLIUM_STATE_DIR: stateDir,
            },
          });
          await modern.open(session);
          const answer = await search(session, modern, 2, 'ct_persons_search');
          return [answer, await session.finish()];
        };
        [first] = await run();
        [second, secondRun] = await run();
      }, timeout);

      it('lets the last call of the day through and counts every call in the file', () => {
        expect(at(first, 'result', 'isError')).toBeUndefined();
        expect(counted()).toMatchObject({
          counts: {
            'user:stdio:local-stdio': {
              special_reads: specialReadBudget + 1,
            },
          },
        });
      });

      it('refuses the next call after the restart, with the reason in the log', () => {
        expect(at(second, 'result', 'isError')).toBe(true);
        expect(at(second, 'result', 'content', 0, 'text')).toBe(
          `The daily budget of ${String(specialReadBudget)} calls of tools with special personal data is used up. It resets at 00:00 UTC.`,
        );
        const denied = auditOf(secondRun.stderr).at(-1);
        expect(denied).toMatchObject({
          tool: 'ct_persons_search',
          outcome: 'denied',
          errorCode: 'policy_denied',
        });
        const reason = jsonLines(secondRun.stderr).find(
          (line) => line['event'] === 'read_budget_exhausted',
        );
        expect(reason?.['eventId']).toBe(denied?.['eventId']);
        expect(protocolViolations(secondRun.stdout)).toEqual([]);
        assertNoCanary(secondRun.stdout, [person.name], 'stdout');
      });

      it('leaves no lock and no other file in the folder quota', () => {
        expect(readdirSync(join(stateDir, 'quota'))).toEqual([
          `default-${day}.json`,
        ]);
      });
    });

    describe('when the line cannot reach the audit file', () => {
      let stateDir = '';
      let persons: Json;
      let finished: Finished;

      beforeAll(async () => {
        stateDir = freshStateDir();
        const server = await serveTls(searches(stateDir, true));
        const launched = overTls(server.origin);
        const session = launch({
          ...launched,
          env: {
            ...launched.env,
            ECCLIUM_TOOLSETS: 'persons',
            ECCLIUM_STATE_DIR: stateDir,
          },
        });
        await modern.open(session);
        persons = await search(session, modern, 2, 'ct_persons_search');
        finished = await session.finish();
      }, timeout);

      afterAll(() => {
        if (stateDir !== '') chmodSync(join(stateDir, 'audit'), 0o700);
      });

      it('holds the result back with policy_denied and never writes a name to stdout', () => {
        expect(at(persons, 'result', 'isError')).toBe(true);
        expect(at(persons, 'result', 'content', 0, 'text')).toBe(
          'The call could not be recorded in the audit file, so its result is held back. Ask the operator to check the audit file.',
        );
        assertNoCanary(finished.stdout, [person.name], 'stdout');
        expect(protocolViolations(finished.stdout)).toEqual([]);
      });

      it('says denied in the copy on stderr', () => {
        expect(auditOf(finished.stderr)).toEqual([
          expect.objectContaining({
            tool: 'ct_persons_search',
            outcome: 'denied',
            errorCode: 'policy_denied',
          }),
        ]);
        assertNoCanary(finished.stderr, [term, person.name], 'stderr');
      });
    });
  },
);

describe.each(eras)(
  'the prompts of the real start in the $name era',
  { timeout },
  (era) => {
    let server: TestServer;
    let listed: Json;
    let rota: Json;
    let draft: Json;
    let friday: Json;
    let finished: Finished;
    const keywords = `Kaffee ${canary.name.value}`;

    beforeAll(async () => {
      const stateDir = mkdtempSync(join(folder, 'prompts-'));
      chmodSync(stateDir, 0o700);
      server = await serveTls(churchTools);
      const launched = overTls(server.origin);
      const session = launch({
        ...launched,
        env: {
          ...launched.env,
          ECCLIUM_TOOLSETS: 'events,wiki',
          ECCLIUM_STATE_DIR: stateDir,
        },
      });
      await era.open(session);
      const ask = (id: number, method: string, params: Json) => {
        session.send({
          jsonrpc: '2.0',
          id,
          method,
          params: era.params(params),
        });
        return session.response(id);
      };
      listed = await ask(2, 'prompts/list', {});
      rota = await ask(3, 'prompts/get', {
        name: 'dienstplan_wochenende',
        arguments: { samstag: '2026-10-31' },
      });
      draft = await ask(4, 'prompts/get', {
        name: 'wiki_seite_entwerfen',
        arguments: { stichworte: keywords },
      });
      friday = await ask(5, 'prompts/get', {
        name: 'dienstplan_wochenende',
        arguments: { samstag: '2026-10-30' },
      });
      finished = await session.finish();
    }, timeout);

    it('lists both prompts of the core with their required arguments', () => {
      const prompts = at(listed, 'result', 'prompts') as readonly Json[];
      expect(
        prompts.map((prompt) => [prompt['name'], prompt['title']]),
      ).toEqual([
        ['dienstplan_wochenende', 'Dienstplan-Überblick für ein Wochenende'],
        ['wiki_seite_entwerfen', 'Wiki-Seite aus Stichworten'],
      ]);
      expect(
        prompts.map((prompt) =>
          (prompt['arguments'] as readonly Json[]).map((argument) => [
            argument['name'],
            argument['required'],
          ]),
        ),
      ).toEqual([[['samstag', true]], [['stichworte', true]]]);
    });

    it('returns each prompt as one message of the person and asks ChurchTools nothing', () => {
      for (const [answer, start] of [
        [
          rota,
          'Überblick über den Dienstplan für das Wochenende von Samstag, 2026-10-31,',
        ],
        [draft, 'Entwurf einer Seite für das Wiki in ChurchTools'],
      ] as const) {
        const messages = at(answer, 'result', 'messages') as readonly Json[];
        expect(messages).toHaveLength(1);
        expect(at(messages, 0, 'role')).toBe('user');
        expect(at(messages, 0, 'content', 'type')).toBe('text');
        expect(
          String(at(messages, 0, 'content', 'text')).startsWith(start),
        ).toBe(true);
      }
      expect(
        String(at(draft, 'result', 'messages', 0, 'content', 'text')),
      ).toContain(keywords);
      expect(server.requests).toEqual([]);
    });

    it('refuses a Friday with invalid params and the fixed sentence', () => {
      expect(at(friday, 'error', 'code')).toBe(-32602);
      expect(at(friday, 'error', 'message')).toBe(
        'The argument samstag is missing or does not fit. Its description in the list of prompts says what it takes.',
      );
    });

    it('writes only JSON-RPC on stdout, a log line per prompt and no audit line', () => {
      expect(protocolViolations(finished.stdout)).toEqual([]);
      expect(
        jsonLines(finished.stderr)
          .filter((line) => String(line['event']).startsWith('prompt_'))
          .map((line) => [line['event'], line['prompt'], line['code']]),
      ).toEqual([
        ['prompt_served', 'dienstplan_wochenende', undefined],
        ['prompt_served', 'wiki_seite_entwerfen', undefined],
        ['prompt_refused', 'dienstplan_wochenende', 'validation'],
      ]);
      expect(auditOf(finished.stderr)).toEqual([]);
      expect(finished.stderr).not.toContain(canary.name.value);
    });
  },
);
