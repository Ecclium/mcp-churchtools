/**
 * MCP over stdio. In this mode stdout carries only the protocol, written by
 * the stdio transport of the SDK. No module reachable from here may write to
 * stdout (ADR 0053).
 *
 * The server builds the mount from what the composition root hands it and
 * serves it with `serveStdio` of the SDK, which picks the era from the
 * first message of a connection and binds one instance to it. Older
 * clients are served, not refused (ADR 0053). The transport is built here,
 * with a limit of {@link maxStdioMessageBytes} on the input it holds
 * unread instead of the 10 MiB of the SDK: input past it ends the
 * connection. Signals and the exit of the process belong to the
 * composition root, which the server tells when the connection has ended.
 *
 * By default the transport reads stdin and writes stdout of the process.
 * Tests pass streams of their own; the transport of the SDK still writes
 * every byte, so no code of Ecclium writes the protocol itself.
 *
 * This entry hands out only its own functions and types, never the mount,
 * the factory or an object of the SDK.
 *
 * @packageDocumentation
 */
import type { Readable, Writable } from 'node:stream';

import type { ToolCatalog, ToolPipeline } from '@ecclium/mcp-churchtools-core';
import { createMcpMount } from '@ecclium/mcp-churchtools-core/mcp';
import type {
  Identity,
  Logger,
  Mode,
  RedactionLevel,
  TenantResolver,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';

/**
 * The most input the transport over stdio holds unread, in bytes: 1 MiB
 * instead of the 10 MiB of the SDK. The SDK checks it before it splits
 * lines, against the rest of an unfinished message plus the chunk that
 * just came in, so it is no limit per message. On a pipe a chunk holds at
 * most 64 KiB, so a message of up to 1 MiB less 64 KiB, line break
 * included, always passes. Input past the limit ends the connection before
 * anything parses it, and every message in it is dropped without an
 * answer. The pipeline limits the depth and the number of values of an
 * input, not its size, so this is the only bound on size before the schema
 * of the tool (ADR 0053).
 */
export const maxStdioMessageBytes = 1024 * 1024;

/** What the composition root builds the server over stdio from. */
export interface StdioServerOptions {
  /** The frozen catalog of tools, the same the pipeline runs. */
  readonly catalog: ToolCatalog;
  /** The pipeline every call runs through. */
  readonly pipeline: ToolPipeline;
  /** The checked identity of the start, the same for every call. */
  readonly identity: Identity;
  /** Assigns tenant and actor to the identity, once per call. */
  readonly resolver: TenantResolver;
  /** How calls run, set by the composition root only. */
  readonly mode: Mode;
  /** The level of redaction of every call. */
  readonly redaction: RedactionLevel;
  /** Whether the server only reads. */
  readonly readOnly: boolean;
  /** Receives fixed events of the server, never a message of the SDK. */
  readonly logger: Logger;
  /**
   * The version of the server, which the client reads in `serverInfo`: 1
   * to 32 printable ASCII characters without spaces.
   */
  readonly version: string;
  /** Where messages come from; stdin of the process if left out. */
  readonly input?: Readable;
  /** Where messages go; stdout of the process if left out. */
  readonly output?: Writable;
}

/** A running server over stdio. */
export interface StdioServer {
  /**
   * Ends the connection: closes the instance and the transport, which
   * stops reading input. It never rejects.
   */
  close(): Promise<void>;
  /**
   * Settles once the connection has ended, whichever way: the end or the
   * close of the input, an error of the output, unread input past
   * {@link maxStdioMessageBytes} or {@link StdioServer.close}. It never
   * rejects, and the composition root ends the process on it.
   */
  readonly closed: Promise<void>;
}

// The event of an error of the connection. It carries no field: the SDK
// puts what a client sent into the message of such an error.
const connectionErrorEvent = 'mcp_stdio_error';

// The transport of the SDK with a signal when it has closed. Every way to
// the end of a connection runs through its close: the end and the close of
// the input, an error of the output, input past the limit and the close of
// the handle of serveStdio. serveStdio takes onclose for itself, so the
// signal hangs on close and touches no callback of the SDK. It also comes
// when closing fails, so that the composition root never waits for an end
// that has already happened.
class ClosingStdioTransport extends StdioServerTransport {
  readonly #ended: () => void;

  constructor(
    input: Readable | undefined,
    output: Writable | undefined,
    ended: () => void,
  ) {
    super(input, output, { maxBufferSize: maxStdioMessageBytes });
    this.#ended = ended;
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      this.#ended();
    }
  }
}

/**
 * Builds the mount and serves it over stdio. The first message of the
 * connection picks the era: `server/discover` or a request with the
 * envelope of 2026 binds an instance of that era, `initialize` one of the
 * 2025 era. Each instance comes from the factory of the mount.
 *
 * An error of the connection, such as a message that is no JSON-RPC or
 * unread input past {@link maxStdioMessageBytes}, writes the fixed event
 * `mcp_stdio_error` and never its message. Input past the limit also ends
 * the connection. Every message in it is dropped without an answer and
 * without an audit line. That can also hit a message just under 1 MiB
 * that a client sends right before another. `closed` settles once the
 * connection has ended, whichever way.
 *
 * @param options - What the mount needs, the version, and the streams if
 *   not stdin and stdout.
 * @returns The running server, frozen: `close` and `closed`.
 * @throws {TypeError} When the version breaks its form; the message never
 *   holds the value.
 * @example
 * ```ts
 * const server = startStdioServer({ catalog, pipeline, identity, resolver,
 *   mode: 'interactive', redaction: 'standard', readOnly: true, logger,
 *   version: '0.1.0' });
 * await server.closed;
 * ```
 */
export function startStdioServer(options: StdioServerOptions): StdioServer {
  const { logger, input, output } = options;
  const mount = createMcpMount({
    catalog: options.catalog,
    pipeline: options.pipeline,
    identity: options.identity,
    resolver: options.resolver,
    mode: options.mode,
    redaction: options.redaction,
    readOnly: options.readOnly,
    logger,
    version: options.version,
  });
  let ended = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    ended = resolve;
  });
  // Without streams the transport of the SDK takes stdin and stdout of the
  // process itself, so this module never touches process.stdout (ADR 0053).
  const transport = new ClosingStdioTransport(input, output, ended);
  const handle = serveStdio(mount.factory, {
    legacy: 'serve',
    transport,
    // Only the fixed event. serveStdio calls this inside a try, so a
    // logger that throws never breaks the connection; a test holds the SDK
    // to that.
    onerror: () => {
      logger.error(connectionErrorEvent);
    },
  });
  return Object.freeze({
    __proto__: null,
    close: async (): Promise<void> => {
      await handle.close();
    },
    closed,
  });
}
