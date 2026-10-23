/**
 * One server process over stdio, spoken to with raw JSON-RPC.
 *
 * The smoke test starts the server as a client would: one process, one
 * JSON-RPC message per line on stdin and stdout, everything else on
 * stderr. It keeps all output of the process in memory, to check it and to
 * look for leaks, and never prints any of it.
 *
 * @packageDocumentation
 */
import { spawn } from 'node:child_process';

/** How the server starts: an executable and its arguments. */
export interface ServerCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/** How the process ended. */
export interface Ended {
  /** The exit code, or `null` if a signal ended it or it never started. */
  readonly code: number | null;
  /** Whether the smoke test had to kill it after the deadline. */
  readonly killed: boolean;
}

/** The answer to one request. */
export type Answer =
  | { readonly kind: 'result'; readonly result: unknown }
  | { readonly kind: 'error' }
  | { readonly kind: 'none' };

/** A running server. */
export interface Session {
  /**
   * Sends a request and waits for its answer.
   *
   * @param method - The JSON-RPC method.
   * @param params - Its params.
   * @returns The result, an error, or `none` after the deadline or the end of the process.
   */
  request(method: string, params: Record<string, unknown>): Promise<Answer>;
  /**
   * Sends a notification.
   *
   * @param method - The JSON-RPC method.
   */
  notify(method: string): void;
  /**
   * Closes stdin, as a client does at the end of a connection, and waits
   * for the process to end.
   *
   * @returns How it ended.
   */
  finish(): Promise<Ended>;
  /**
   * Ends the process at once if it still runs, after a failure of the
   * smoke test itself, so that no server stays behind.
   */
  dispose(): void;
  /** Everything the process wrote to stdout so far. */
  stdout(): string;
  /** Everything the process wrote to stderr so far. */
  stderr(): string;
  /** How many lines on stdout were no JSON-RPC message. */
  foreignLines(): number;
}

/** Deadlines in milliseconds. Shorter in tests. */
export interface Deadlines {
  /** For the answer to one request. */
  readonly answer: number;
  /** For the end of the process after stdin closed. */
  readonly end: number;
}

/**
 * The deadlines of a real run. ct_whoami sends two requests one after the
 * other, each of which the server may wait for up to 30 seconds, so one
 * answer may take longer than that.
 */
export const defaultDeadlines: Deadlines = { answer: 75_000, end: 15_000 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Starts the server with exactly the given environment.
 *
 * Nothing of the environment of the smoke test reaches the child, so a
 * variable of the shell can neither break the start nor change what the
 * server does (ADR 0055).
 *
 * @param command - Executable and arguments.
 * @param env - The whole environment of the child.
 * @param deadlines - How long to wait.
 * @returns The session.
 */
export function startServer(
  command: ServerCommand,
  env: Readonly<Record<string, string>>,
  deadlines: Deadlines = defaultDeadlines,
): Session {
  const child = spawn(command.executable, [...command.args], {
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let rest = '';
  let foreign = 0;
  let nextId = 1;
  const waiting = new Map<number, (answer: Answer) => void>();

  const ended = new Promise<{ readonly code: number | null }>((resolve) => {
    child.once('error', () => {
      resolve({ code: null });
    });
    child.once('close', (code) => {
      resolve({ code });
    });
  });
  const state = { closed: false };
  void ended.then(() => {
    state.closed = true;
    for (const settle of waiting.values()) settle({ kind: 'none' });
    waiting.clear();
  });

  const handle = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      foreign += 1;
      return;
    }
    if (!isRecord(message) || message['jsonrpc'] !== '2.0') {
      foreign += 1;
      return;
    }
    const id = message['id'];
    // A request of the server can carry the same number; only an answer
    // settles a request of the smoke test.
    if (typeof id !== 'number' || 'method' in message) return;
    const settle = waiting.get(id);
    if (settle === undefined) return;
    waiting.delete(id);
    settle(
      'result' in message
        ? { kind: 'result', result: message['result'] }
        : { kind: 'error' },
    );
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    rest += chunk;
    let end = rest.indexOf('\n');
    while (end !== -1) {
      handle(rest.slice(0, end));
      rest = rest.slice(end + 1);
      end = rest.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  // A server that ended early closes its stdin; writing then fails, and
  // the request ends as `none` through the end of the process.
  child.stdin.on('error', () => undefined);

  const send = (message: Record<string, unknown>): void => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return {
    request(method, params) {
      // A process that has ended answers nothing more; no need to wait.
      if (state.closed) return Promise.resolve({ kind: 'none' });
      const id = nextId;
      nextId += 1;
      return new Promise<Answer>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve({ kind: 'none' });
        }, deadlines.answer);
        waiting.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method) {
      send({ jsonrpc: '2.0', method });
    },
    async finish() {
      child.stdin.end();
      const deadline = { passed: false };
      const timer = setTimeout(() => {
        deadline.passed = true;
        child.kill('SIGKILL');
      }, deadlines.end);
      const { code } = await ended;
      clearTimeout(timer);
      if (rest !== '') {
        handle(rest);
        rest = '';
      }
      return {
        code: deadline.passed ? null : code,
        killed: deadline.passed,
      };
    },
    dispose() {
      if (state.closed) return;
      child.stdin.end();
      child.kill('SIGKILL');
    },
    stdout: () => stdout,
    stderr: () => stderr,
    foreignLines: () => foreign,
  };
}
