/**
 * Probe 14: which protocol version a client sends over HTTP.
 *
 * A dummy server, no part of Ecclium: no ChurchTools, no data, one empty
 * tool. It stands open without sign-in only for the duration of a probe
 * (ADR 0073), so that a person can connect claude.ai and ChatGPT to it and
 * see which headers of the protocol and which version in the body these
 * clients send, and whether the MCP SDK accepts them.
 *
 * Every request passes a recorder first. It notes what the request shows
 * (see `lib/protocol-probe.mts`) and only then hands the request to
 * `createMcpHandler` of the SDK, the entry Ecclium will use over HTTP. So a
 * request the SDK refuses is recorded as well, with the refusal. Without
 * the switch `ECCLIUM_SPIKE_PROTOCOL_STRICT=ja` the probe is lenient in one
 * case only, the one the prepared rule of ADR 0073 covers: the header names
 * one supported version and the body another. Then it asks the SDK a second
 * time with the header of the body and records both answers.
 *
 * Limits that make «only for the duration of the probe» hold in code: it
 * binds to 127.0.0.1 only (a tunnel on the same machine makes it public),
 * it ends itself after 60 minutes (at most 120) or after 500 requests, and
 * a body may have 1 MiB. Paths are random, one per client, and never
 * appear in the output.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { homedir, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CallToolRequest,
  type CallToolResult,
  createMcpHandler,
  type jsonSchemaValidator,
  type ListToolsResult,
  McpServer,
  type McpServerFactory,
  type Tool,
} from '@modelcontextprotocol/server';

import { checkNodeEnvironment } from './lib/env.mts';
import { Guard } from './lib/guard.mts';
import {
  exitCodes,
  installCrashHandlers,
  integrityLines,
  writeError,
  type Io,
} from './lib/output.mts';
import {
  adjustment,
  allowEntry,
  blockRequest,
  classifyPath,
  entryJson,
  observe,
  outputWords,
  pathLabels,
  readVerdict,
  summarize,
  type Ending,
  type Entry,
  type ProbeRequest,
  type Verdict,
} from './lib/protocol-probe.mts';

/** The version of the SDK behind the recorder, as the root pins it. */
export const sdkVersion = '2.3.1';

/** The only address the probe binds to. */
export const bindAddress = '127.0.0.1';

/** Upper bound of a body, as ADR 0073 sets it for Ecclium. */
export const maxBodyBytes = 1024 * 1024;

/** After this many requests the probe ends. */
export const maxEntries = 500;

/** Minutes until the probe ends, unless the variable says otherwise. */
export const defaultMinutes = 60;

/** The most minutes the variable may ask for. */
export const maxMinutes = 120;

/** Port, unless `ECCLIUM_SPIKE_PORT` names another. */
export const defaultPort = 8787;

// How long the probe waits for the SDK to finish an answer.
const answerTimeoutMs = 10_000;

// Headers that reach the SDK. Everything else, the host and the addresses
// of a proxy included, stays with the recorder.
const forwardedHeaders = new Set([
  'content-type',
  'accept',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
  'mcp-session-id',
  'last-event-id',
]);

/** The one tool of the probe. It does nothing and returns no data. */
export const emptyTool: Tool = Object.freeze<Tool>({
  name: 'empty',
  description:
    'Does nothing and returns no data. It exists only for a probe of the protocol version.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

// fromJsonSchema and elicitInput are the only ways a value of a client
// reaches the bundled fast-uri of the SDK 2.3.1; the probe uses neither,
// and like the mount of Ecclium it refuses validation outright (ADR 0059).
const refusingValidator: jsonSchemaValidator = Object.freeze({
  getValidator: (): never => {
    throw new Error('JSON Schema validation is switched off (ADR 0059).');
  },
});

/**
 * Builds the server behind the recorder: one empty tool, no prompts, no
 * resources, no list that changes.
 *
 * @returns The factory for `createMcpHandler`.
 */
export function createServerFactory(): McpServerFactory {
  return () => {
    const instance = new McpServer(
      { name: 'ecclium-protocol-probe', version: '0.0.0' },
      { jsonSchemaValidator: refusingValidator },
    );
    instance.server.registerCapabilities({ tools: { listChanged: false } });
    instance.server.setRequestHandler('tools/list', (): ListToolsResult => ({
      tools: [emptyTool],
    }));
    instance.server.setRequestHandler(
      'tools/call',
      (request: CallToolRequest): CallToolResult =>
        request.params.name === emptyTool.name
          ? { content: [{ type: 'text', text: 'leer' }] }
          : { content: [{ type: 'text', text: 'unbekannt' }], isError: true },
    );
    return instance;
  };
}

/** Settings of one run of the probe. */
export interface ProbeOptions {
  /** Answer as the SDK does, without the prepared rule of ADR 0073. */
  readonly strict: boolean;
  /** The paths of the clients, in the order of the labels. */
  readonly paths: readonly string[];
  /** The guard of the run. */
  readonly guard: Guard;
  /** Where the output goes. */
  readonly io: Io;
  /** The clock, in milliseconds. */
  readonly now: () => number;
  /** Called once the last allowed request is recorded. */
  readonly onLimit: () => void;
}

/** The recorder with the SDK behind it, without a socket. */
export interface ProbeApp {
  /**
   * Records one request, then answers it.
   *
   * @param request - The request.
   * @param address - Address of the socket, only for the block list.
   * @returns The answer for the client.
   */
  readonly handle: (
    request: ProbeRequest,
    address: string | undefined,
  ) => Promise<Response>;
  /** The recorded entries. */
  readonly entries: () => readonly Entry[];
  /** How many lines the guard held back. */
  readonly withheld: () => number;
  /** Stops recording and closes the SDK handler. */
  readonly close: () => Promise<void>;
}

/**
 * Creates the recorder with the SDK behind it.
 *
 * @param options - Settings of the run.
 * @returns The recorder.
 */
export function createProbeApp(options: ProbeOptions): ProbeApp {
  const { guard, io } = options;
  const handler = createMcpHandler(createServerFactory(), {
    legacy: 'stateless',
    responseMode: 'json',
    maxRequestBodySize: maxBodyBytes,
    // The errors carry values of the request; the verdict is enough.
    onerror: () => undefined,
  });
  const startedAt = options.now();
  const entries: Entry[] = [];
  let withheld = 0;
  // Read through a function, so that a check after an await reads the
  // current value and not one the compiler narrowed before it.
  const state = { open: true };
  const isOpen = (): boolean => state.open;

  const callSdk = async (
    request: ProbeRequest,
    headers: Headers,
  ): Promise<{ readonly verdict: Verdict; readonly response: Response }> => {
    const forwarded = new Headers();
    for (const [name, value] of headers) {
      if (forwardedHeaders.has(name) || name.startsWith('mcp-param-')) {
        forwarded.set(name, value);
      }
    }
    try {
      const answer = await handler.fetch(
        new Request('http://localhost/mcp', {
          method: request.method,
          headers: forwarded,
          ...(request.method === 'POST' && typeof request.body === 'string'
            ? { body: request.body }
            : {}),
        }),
      );
      let timer: NodeJS.Timeout | undefined;
      const text = await Promise.race([
        answer.text(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            resolve(undefined);
          }, answerTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (text === undefined) {
        void answer.body?.cancel().catch(() => undefined);
        return attrappe(504);
      }
      const contentType = answer.headers.get('content-type');
      const out = new Headers({ 'cache-control': 'no-store' });
      if (contentType !== null) {
        out.set('content-type', contentType);
      }
      const allow = answer.headers.get('allow');
      if (allow !== null) {
        out.set('allow', allow);
      }
      const empty = text === '' || [204, 205, 304].includes(answer.status);
      return {
        verdict: readVerdict(answer.status, contentType, text),
        response: new Response(empty ? null : text, {
          status: answer.status,
          headers: out,
        }),
      };
    } catch {
      return attrappe(500);
    }
  };

  const record = (entry: Entry): void => {
    entries.push(entry);
    allowEntry(guard, entry);
    const line = entryJson(entry);
    const findings = guard.check(line);
    if (findings.length === 0) {
      io.stdout(`${JSON.stringify(line)}\n`);
    } else {
      withheld += 1;
      io.stdout(
        `${JSON.stringify({ nr: entry.nr, zurueckgehalten: true, stellen: findings })}\n`,
      );
    }
    if (entries.length === maxEntries) {
      state.open = false;
      options.onLimit();
    }
  };

  const handle = async (
    request: ProbeRequest,
    address: string | undefined,
  ): Promise<Response> => {
    if (!state.open) {
      return new Response(null, { status: 503 });
    }
    blockRequest(guard, request, address);
    const path = classifyPath(request.path, options.paths);
    const observation = observe(request, path);
    let strict: Verdict;
    let adjusted: Verdict | undefined;
    let response: Response;
    if (!path.mcp) {
      ({ verdict: strict, response } = attrappe(404));
    } else if (request.tooLarge === true) {
      ({ verdict: strict, response } = attrappe(413));
    } else if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
      ({ verdict: strict, response } = attrappe(405));
    } else if (observation.methode === 'subscriptions/listen') {
      // The SDK would open a stream of server-sent events; Ecclium refuses
      // it before the SDK (ADR 0073), and so does the probe.
      ({ verdict: strict, response } = refuseListen(request.body));
    } else {
      ({ verdict: strict, response } = await callSdk(request, request.headers));
      const version = options.strict
        ? undefined
        : adjustment(observation, strict);
      if (version !== undefined) {
        const headers = new Headers(request.headers);
        headers.set('mcp-protocol-version', version);
        ({ verdict: adjusted, response } = await callSdk(request, headers));
      }
    }
    // The run may have ended while the SDK answered.
    if (!isOpen()) {
      return new Response(null, { status: 503 });
    }
    record({
      nr: entries.length + 1,
      sekunde: Math.max(0, Math.floor((options.now() - startedAt) / 1000)),
      observation,
      streng: strict,
      ...(adjusted === undefined ? {} : { angeglichen: adjusted }),
    });
    return response;
  };

  return {
    handle,
    entries: () => entries,
    withheld: () => withheld,
    close: async () => {
      state.open = false;
      await handler.close();
    },
  };
}

function attrappe(status: number): {
  readonly verdict: Verdict;
  readonly response: Response;
} {
  return {
    verdict: { status, von: 'Attrappe' },
    response: new Response(null, {
      status,
      headers: { 'cache-control': 'no-store' },
    }),
  };
}

function refuseListen(body: string | undefined): {
  readonly verdict: Verdict;
  readonly response: Response;
} {
  let id: unknown = null;
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
      id = parsed.id;
    }
  } catch {
    // The observation already says the body was not valid.
  }
  const safeId = typeof id === 'string' || typeof id === 'number' ? id : null;
  return {
    verdict: { status: 200, von: 'Attrappe', fehler: -32601 },
    response: Response.json(
      {
        jsonrpc: '2.0',
        id: safeId,
        error: { code: -32601, message: 'Method not found' },
      },
      { headers: { 'cache-control': 'no-store' } },
    ),
  };
}

/** Settings to start the probe on a socket. */
export interface StartOptions {
  readonly port: number;
  readonly strict: boolean;
  /** How long the probe runs at most, in milliseconds. */
  readonly durationMs: number;
  readonly io: Io;
  readonly now?: () => number;
}

/** A started probe. */
export interface RunningProbe {
  /** The address it listens on, always {@link bindAddress}. */
  readonly address: string;
  /** The port it listens on. */
  readonly port: number;
  /** The random paths, in the order of the labels. */
  readonly paths: readonly string[];
  /** Ends the probe, as a signal does. */
  readonly stop: () => void;
  /** Resolves with the exit code once the probe has ended. */
  readonly finished: Promise<number>;
}

/**
 * Starts the probe on 127.0.0.1.
 *
 * @param options - Settings of the run.
 * @returns The running probe.
 * @throws {Error} If the port cannot be bound.
 */
export async function startProbe(options: StartOptions): Promise<RunningProbe> {
  const now = options.now ?? Date.now;
  const paths = pathLabels.map(
    () => `/${randomBytes(18).toString('base64url')}`,
  );
  const guard = new Guard();
  guard.allowFixed(...outputWords);
  for (const value of [
    userInfo().username,
    homedir(),
    options.port,
    ...paths,
  ]) {
    guard.block(value);
  }
  for (const path of paths) {
    guard.block(path.slice(1));
  }

  let finish: (ending: Ending) => void = () => undefined;
  const app = createProbeApp({
    strict: options.strict,
    paths,
    guard,
    io: options.io,
    now,
    onLimit: () => {
      finish('Obergrenze');
    },
  });
  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16_384 },
    (req, res) => {
      void serve(app, req, res);
    },
  );
  server.maxConnections = 64;
  await listen(server, options.port);
  const bound = server.address();
  const port =
    typeof bound === 'object' && bound !== null ? bound.port : options.port;
  const address =
    typeof bound === 'object' && bound !== null ? bound.address : bindAddress;
  guard.block(port);

  const finished = new Promise<number>((resolve) => {
    let ended = false;
    const deadline = setTimeout(() => {
      finish('Frist');
    }, options.durationMs);
    finish = (ending) => {
      if (ended) {
        return;
      }
      ended = true;
      clearTimeout(deadline);
      server.close();
      server.closeAllConnections();
      void app.close().finally(() => {
        resolve(writeSummary(app, guard, options, now, ending));
      });
    };
  });
  return {
    address,
    port,
    paths,
    stop: () => {
      finish('Signal');
    },
    finished,
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindAddress, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function writeSummary(
  app: ProbeApp,
  guard: Guard,
  options: StartOptions,
  now: () => number,
  ending: Ending,
): number {
  const date = new Date(now());
  const datum = [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getFullYear()),
  ].join('.');
  guard.allowFixed(datum, sdkVersion, app.entries().length, app.withheld());
  const summary = summarize(app.entries(), {
    datum,
    modus: options.strict ? 'streng' : 'nachsichtig',
    sdk: sdkVersion,
    ende: ending,
    zurueckgehalten: app.withheld(),
  });
  // The counts per path and form are numbers the probe made.
  allowCounts(guard, summary);
  const findings = guard.check(summary);
  if (findings.length > 0) {
    options.io.stdout(
      `${JSON.stringify({ zurueckgehalten: true, stellen: findings })}\n`,
    );
    return exitCodes.withheld;
  }
  options.io.stdout(`${JSON.stringify(summary)}\n`);
  return app.withheld() > 0 ? exitCodes.withheld : exitCodes.ok;
}

function allowCounts(guard: Guard, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      allowCounts(guard, item);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === 'anfragen' || key === 'anzahl') &&
        typeof item === 'number'
      ) {
        guard.allowFixed(item);
      }
      allowCounts(guard, item);
    }
  }
}

async function serve(
  app: ProbeApp,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) {
          headers.append(name, item);
        }
      }
    }
    // The query is never kept, only the path decides.
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const { text, tooLarge } = await readBody(req);
    const response = await app.handle(
      {
        method: req.method ?? 'GET',
        path,
        headers,
        body: text,
        ...(tooLarge ? { tooLarge } : {}),
      },
      req.socket.remoteAddress,
    );
    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      out[name] = value;
    });
    if (tooLarge) {
      out['connection'] = 'close';
    }
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { 'cache-control': 'no-store' });
    }
    res.end();
  }
}

// Reads a body up to the limit. Beyond it the rest is drained up to four
// times the limit, so the answer 413 still reaches the client, and then
// the connection is dropped.
async function readBody(
  req: IncomingMessage,
): Promise<{ readonly text: string | undefined; readonly tooLarge: boolean }> {
  const tooLarge = { text: undefined, tooLarge: true } as const;
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > 4 * maxBodyBytes) {
    req.destroy();
    return tooLarge;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > 4 * maxBodyBytes) {
      req.destroy();
      return tooLarge;
    }
    if (size <= maxBodyBytes) {
      chunks.push(piece);
    }
  }
  if (size > maxBodyBytes) {
    return tooLarge;
  }
  return {
    text: size === 0 ? undefined : Buffer.concat(chunks).toString('utf8'),
    tooLarge: false,
  };
}

const notes = {
  portUngueltig:
    'Abbruch: ECCLIUM_SPIKE_PORT muss eine ganze Zahl von 1024 bis 65535 sein.',
  minutenUngueltig:
    'Abbruch: ECCLIUM_SPIKE_MINUTES muss eine ganze Zahl von 1 bis 120 sein.',
  modusUngueltig:
    'Abbruch: ECCLIUM_SPIKE_PROTOCOL_STRICT muss «ja» oder «nein» sein.',
  portBelegt:
    'Abbruch: Der Port ist belegt oder lässt sich nicht binden. Wählen Sie mit ECCLIUM_SPIKE_PORT einen anderen.',
} as const;

function readInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!/^\d{1,6}$/.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return number >= min && number <= max ? number : undefined;
}

/**
 * Starts the probe as a program, with the real environment.
 *
 * @param moduleUrl - `import.meta.url` of this file.
 * @returns The exit code.
 */
export async function main(moduleUrl: string): Promise<number> {
  const io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  installCrashHandlers(io);
  try {
    checkNodeEnvironment(process.env);
  } catch (error) {
    return writeError(error, io);
  }
  const port = readInteger(
    process.env['ECCLIUM_SPIKE_PORT'],
    defaultPort,
    1024,
    65_535,
  );
  const minutes = readInteger(
    process.env['ECCLIUM_SPIKE_MINUTES'],
    defaultMinutes,
    1,
    maxMinutes,
  );
  const strictValue = process.env['ECCLIUM_SPIKE_PROTOCOL_STRICT'] ?? 'nein';
  if (port === undefined) {
    io.stderr(`${notes.portUngueltig}\n`);
    return exitCodes.configuration;
  }
  if (minutes === undefined) {
    io.stderr(`${notes.minutenUngueltig}\n`);
    return exitCodes.configuration;
  }
  if (strictValue !== 'ja' && strictValue !== 'nein') {
    io.stderr(`${notes.modusUngueltig}\n`);
    return exitCodes.configuration;
  }
  for (const line of integrityLines(dirname(fileURLToPath(moduleUrl)))) {
    io.stderr(`${line}\n`);
  }
  let probe: RunningProbe;
  try {
    probe = await startProbe({
      port,
      strict: strictValue === 'ja',
      durationMs: minutes * 60_000,
      io,
    });
  } catch {
    io.stderr(`${notes.portBelegt}\n`);
    return exitCodes.configuration;
  }
  io.stderr(
    [
      `Die Attrappe hört auf http://${bindAddress}:${String(probe.port)}, Modus ${strictValue === 'ja' ? 'streng' : 'nachsichtig'}.`,
      `Sie endet nach ${String(minutes)} Minuten oder ${String(maxEntries)} Anfragen von selbst, Ctrl-C beendet sie früher.`,
      'Pfade für die Connectors, nur hier und nie in der Ausgabe:',
      ...pathLabels.map(
        (label, index) => `  ${label}  ${probe.paths[index] ?? ''}`,
      ),
      '',
    ].join('\n'),
  );
  process.once('SIGINT', probe.stop);
  process.once('SIGTERM', probe.stop);
  return probe.finished;
}

if (import.meta.main) {
  process.exitCode = await main(import.meta.url);
}
