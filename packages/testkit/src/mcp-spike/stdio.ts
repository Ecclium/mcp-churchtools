/**
 * Start of the elicitation spike over stdio. stdout carries only the
 * protocol, written by the stdio transport of the SDK, and the record of
 * the spike goes to stderr from here alone (ADR 0053).
 *
 * Run it from the build, `node packages/testkit/dist/mcp-spike/stdio.js`,
 * with stderr redirected to a file; the run guide in
 * `docs/research/mcp-sdk-und-elicitation.md` gives the details.
 *
 * @packageDocumentation
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Transport } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';

import { createSpikeLog } from './log.js';
import { observeTransport } from './observe.js';
import { createSpikeCodec, createSpikeServer } from './server.js';

/** What the spike is started with; the start fills it from this process. */
export interface SpikeStart {
  /** Carries the messages. */
  readonly transport: Transport;
  /** Receives each line of the record. */
  readonly write: (line: string) => void;
  /** The current time in milliseconds since the epoch. */
  readonly now: () => number;
  /** The key for the `requestState`, at least 32 random bytes. */
  readonly key: Uint8Array;
  /** A fresh random value per question. */
  readonly newNonce: () => string;
  /** Names this process in the record. */
  readonly instanceId: string;
}

/**
 * Reads the version of the installed SDK, whose manifest is not exported.
 *
 * @returns The version, or undefined if the manifest has none.
 */
function sdkVersion(): unknown {
  const entry = import.meta.resolve('@modelcontextprotocol/server');
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', entry), 'utf8'),
  );
  return typeof manifest === 'object' && manifest !== null
    ? (manifest as Readonly<Record<string, unknown>>)['version']
    : undefined;
}

/**
 * Serves the spike over the given transport. Separate from {@link main},
 * so that tests can run the same composition over their own streams.
 *
 * @param start - Transport, record and sources of time and randomness.
 * @returns The handle of `serveStdio`, to close the connection.
 * @example
 * ```ts
 * const handle = startSpike({
 *   transport: new StdioServerTransport(input, output),
 *   write: (line) => lines.push(line),
 *   now: () => Date.now(),
 *   key: randomBytes(32),
 *   newNonce: () => randomBytes(8).toString('hex'),
 *   instanceId: randomUUID(),
 * });
 * ```
 */
export function startSpike(start: SpikeStart): StdioServerHandle {
  const log = createSpikeLog(start.write, start.now);
  log.event('process_start', {
    instanceId: start.instanceId,
    sdkVersion: sdkVersion(),
  });
  const factory = createSpikeServer({
    codec: createSpikeCodec(start.key),
    log,
    now: start.now,
    newNonce: start.newNonce,
  });
  return serveStdio(factory, {
    legacy: 'serve',
    transport: observeTransport(start.transport, log, start.now),
    // An error of the entry, never its message: it may quote a request.
    onerror: () => {
      log.event('entry_error', { kind: 'other' });
    },
  });
}

/**
 * Starts the spike on stdin and stdout of this process, with the record on
 * stderr. A crash ends the process with a fixed line, without stack or
 * path, because the record may be passed on.
 *
 * @returns The handle of `serveStdio`.
 * @example
 * ```ts
 * if (import.meta.main) main();
 * ```
 */
export function main(): StdioServerHandle {
  const write = (line: string): void => {
    process.stderr.write(line);
  };
  const now = (): number => Date.now();
  const log = createSpikeLog(write, now);
  const fail =
    (kind: 'uncaught_exception' | 'unhandled_rejection') => (): void => {
      log.event('process_failed', { kind });
      process.exit(1);
    };
  process.on('uncaughtException', fail('uncaught_exception'));
  process.on('unhandledRejection', fail('unhandled_rejection'));
  return startSpike({
    transport: new StdioServerTransport(),
    write,
    now,
    key: randomBytes(32),
    newNonce: () => randomBytes(8).toString('hex'),
    instanceId: randomUUID(),
  });
}

if (import.meta.main) main();
