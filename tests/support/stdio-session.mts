// The client side of a test against a server over stdio in a child process
// (ADR 0053): the check that stdout carries only JSON-RPC 2.0, one message
// per line, a session that writes to the stdin of the child and waits for
// its answers and its log lines on stderr, and the two eras of the
// protocol, each with the request that opens a connection.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';

import { vi } from 'vitest';

/** A parsed JSON object, such as one message or one log line. */
export type Json = Readonly<Record<string, unknown>>;

/** Reads a value along a path of keys, undefined where the path ends. */
export const at = (
  value: unknown,
  ...path: readonly (string | number)[]
): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === 'object' && current !== null
        ? (current as Readonly<Record<string | number, unknown>>)[key]
        : undefined,
    value,
  );

const responseKeys = new Set(['jsonrpc', 'id', 'result', 'error']);
const requestKeys = new Set(['jsonrpc', 'id', 'method', 'params']);

/**
 * Whether a line is one JSON-RPC 2.0 message: a request, a notification
 * or a response, with no member the specification does not name.
 */
export function isJsonRpc(line: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof message !== 'object' || message === null) return false;
  if (Array.isArray(message)) return false;
  const record = message as Json;
  const keys = Object.keys(record);
  if (record['jsonrpc'] !== '2.0') return false;
  const id = record['id'];
  if (typeof record['method'] === 'string') {
    return (
      keys.every((key) => requestKeys.has(key)) &&
      (id === undefined || typeof id === 'string' || typeof id === 'number')
    );
  }
  const answered = Object.hasOwn(record, 'result');
  const failed = Object.hasOwn(record, 'error');
  return (
    keys.every((key) => responseKeys.has(key)) &&
    answered !== failed &&
    (typeof id === 'string' ||
      typeof id === 'number' ||
      (id === null && failed))
  );
}

/**
 * What on stdout is not a JSON-RPC 2.0 message on a line of its own.
 *
 * @param stdout - Everything the child wrote to stdout.
 * @returns One entry per offending line, empty when there is none.
 */
export function protocolViolations(stdout: string): string[] {
  const problems: string[] = [];
  const lines = stdout.split('\n');
  const rest = lines.pop() ?? '';
  if (rest !== '') problems.push(`no line break after: ${rest.slice(0, 80)}`);
  lines.forEach((line, index) => {
    if (!isJsonRpc(line)) {
      problems.push(`line ${String(index + 1)}: ${line.slice(0, 80)}`);
    }
  });
  return problems;
}

/** The lines of a text that parse as JSON objects, in their order. */
export const jsonLines = (text: string): Json[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });

/** How the child ended, with everything it wrote. */
export interface Finished {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A running child and the means to talk to it. */
export interface Session {
  /** The child, for a signal or to end it after the test. */
  readonly child: ChildProcessWithoutNullStreams;
  /** Writes one message as a line. */
  readonly send: (message: Json) => void;
  /** Writes the text as it is. */
  readonly write: (text: string) => void;
  /** Waits for the response with the id. */
  readonly response: (id: number) => Promise<Json>;
  /** Waits for a JSON line on stderr that matches. */
  readonly logged: (match: (line: Json) => boolean) => Promise<Json>;
  /** Ends stdin and waits for the exit of the child. */
  readonly finish: () => Promise<Finished>;
  /** Waits for the exit of the child and leaves stdin open. */
  readonly ended: () => Promise<Finished>;
}

const timeouts = { timeout: 20_000, interval: 10 };

/**
 * Starts Node.js with the arguments and only the given environment, and
 * plays the client on its stdin and stdout.
 *
 * @param args - The options of Node.js and the script with its arguments.
 * @param env - The whole environment of the child.
 * @returns The session with the running child.
 */
export function startSession(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Session {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  // close, not exit: Node.js may report the exit before the last output
  // of the child, such as a line written while it exits, has arrived.
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
  });
  const ended = async (): Promise<Finished> => {
    const code = await exited;
    return { code, stdout, stderr };
  };
  // Waits until find returns a value, and gives up at once with the end of
  // stderr when the child has ended without it.
  const until = (find: () => Json | undefined, what: string): Promise<Json> => {
    const polled = vi.waitFor(() => {
      const found = find();
      if (found === undefined) throw new Error(`no ${what}`);
      return found;
    }, timeouts);
    const gone = exited.then(() => {
      const found = find();
      if (found !== undefined) return found;
      throw new Error(`the child ended without ${what}: ${stderr.slice(-400)}`);
    });
    polled.catch(() => undefined);
    gone.catch(() => undefined);
    return Promise.race([polled, gone]);
  };
  return {
    child,
    send: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    write: (text) => {
      child.stdin.write(text);
    },
    response: (id) =>
      until(
        () => jsonLines(stdout).find((line) => line['id'] === id),
        `response ${String(id)}`,
      ),
    logged: (match) =>
      until(() => jsonLines(stderr).find(match), 'such line on stderr'),
    finish: () => {
      child.stdin.end();
      return ended();
    },
    ended,
  };
}

const modernMeta: Json = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** One way to talk to the server: in the 2026 era or in the 2025 era. */
export interface Era {
  readonly name: 'modern' | 'legacy';
  /** Opens the connection with request 1 and waits for its answer. */
  readonly open: (session: Session) => Promise<Json>;
  /** The params of a request or notification in this era. */
  readonly params: (params: Json) => Json;
}

/** The 2026 era: no handshake, the metadata of the client on every request. */
export const modern: Era = {
  name: 'modern',
  open: (session) => {
    session.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: modernMeta },
    });
    return session.response(1);
  },
  params: (params) => ({ ...params, _meta: modernMeta }),
};

/** The 2025 era: initialize, then the notification that it is done. */
export const legacy: Era = {
  name: 'legacy',
  open: async (session) => {
    session.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'older-client', version: '0.9.0' },
      },
    });
    const answer = await session.response(1);
    session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return answer;
  },
  params: (params) => params,
};

/** Both eras, the newer first. */
export const eras: readonly Era[] = [modern, legacy];
