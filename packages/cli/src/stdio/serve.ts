/**
 * The second stage of the start over stdio (ADR 0054, ADR 0055). The first
 * stage loads it with `import()` only after the start notices are out:
 * the server, its SDK and undici make fd 2 non-blocking while they load,
 * and the notices go out while it still blocks.
 *
 * Here the one stderr writer of the process comes into being, with the
 * logger and the audit sink that write through it, the handlers of the
 * process, the transport to the instance, the pipeline and the server.
 * The audit sink writes into the audit file that the first stage opened,
 * if there is one (ADR 0028). The start asks ChurchTools nothing:
 * `ct_whoami` checks the token, so the token leaves the process only for a
 * call. When the connection ends, the transport closes, the event
 * `audit_file_closed` counts the lines the audit file lost, the file
 * closes, the event `stdio_closed` counts the lines stderr lost, and the
 * process ends with the code of an earlier signal or 0. All state lives
 * in the closure of {@link serve}.
 *
 * @packageDocumentation
 */
import { hostname } from 'node:os';
import type { Readable, Writable } from 'node:stream';

import {
  createStdioIdentity,
  createStdioTenantResolver,
  createToolPipeline,
  type EccliumConfig,
  type ToolCatalog,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditFileWriter,
  createAuditSink,
  createDefaultTenantLogger,
  createFileQuotaStore,
  createLogger,
  createStderrWriter,
  describeError,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';
import { startStdioServer } from '@ecclium/mcp-churchtools-server/stdio';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import type { WriteSyncFn } from '../send.js';
import { userAgent, version } from '../version.js';

/** What the start needs of the process. Tests replace it. */
export interface StdioHost {
  /**
   * Adds a listener for a signal.
   *
   * @param signal - SIGINT or SIGTERM.
   * @param listener - Runs on every delivery of the signal.
   */
  readonly onSignal: (
    signal: 'SIGINT' | 'SIGTERM',
    listener: () => void,
  ) => void;
  /**
   * Adds a listener for an exception that nothing caught.
   *
   * @param listener - Gets the thrown value.
   */
  readonly onUncaughtException: (listener: (error: unknown) => void) => void;
  /**
   * Adds a listener for a rejection that nothing handled.
   *
   * @param listener - Gets the reason of the rejection.
   */
  readonly onUnhandledRejection: (listener: (reason: unknown) => void) => void;
  /**
   * Sets the code the process ends with once nothing holds it.
   *
   * @param code - The exit code.
   */
  readonly setExitCode: (code: ExitCode) => void;
  /**
   * Ends the process at once.
   *
   * @param code - The exit code.
   */
  readonly exit: (code: ExitCode) => void;
}

/** Replacements for tests, which the first stage passes on. */
export interface ServeReplacements {
  /** Replaces `writeSync` from `node:fs` for the stderr writer. */
  readonly writeSync?: WriteSyncFn;
  /**
   * Replaces the factory of the transport, such as with the test double of
   * ChurchTools. It gets what the real factory would get.
   */
  readonly createTransport?: (options: HttpTransportOptions) => HttpTransport;
  /** Where messages come from; stdin of the process if left out. */
  readonly input?: Readable;
  /** Where messages go; stdout of the process if left out. */
  readonly output?: Writable;
  /** Replaces the process for signals, exceptions and the exit. */
  readonly host?: StdioHost;
}

/** What the first stage hands over. */
export interface ServeOptions extends ServeReplacements {
  /** The checked configuration. */
  readonly config: EccliumConfig;
  /** The catalog the first stage built, which the registry accepted. */
  readonly catalog: ToolCatalog;
  /** Whether the start notices left a line without its line break. */
  readonly afterTornLine: boolean;
  /**
   * The audit file the first stage opened, which serve closes when the
   * connection ends or the start fails.
   */
  readonly auditFile?: AuditFileWriter;
}

// Fixed events of the start. They carry no field but a code or a count:
// the value an exception holds, a signal and its source never reach the
// log.
const uncaughtEvent = 'process_uncaught_exception';
const rejectionEvent = 'process_unhandled_rejection';
const startFailedEvent = 'stdio_start_failed';
const sigtermEvent = 'process_sigterm';
const sigintEvent = 'process_sigint';
const auditFileClosedEvent = 'audit_file_closed';
const closedEvent = 'stdio_closed';

/**
 * How long the process may take to end after the connection, in
 * milliseconds. Exiting at once could cut off an answer on stdout, so the
 * process ends on its own, and only something that still holds it then
 * meets the deadline.
 */
export const closeDeadlineMs = 5000;

// The highest count a log line takes.
const maxCount = 1_000_000;

// The process itself. Only properties are used: loading node:process
// would make fd 1 and fd 2 non-blocking (ADR 0054).
const processHost = (): StdioHost =>
  Object.freeze({
    onSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      process.on(signal, listener);
    },
    onUncaughtException: (listener: (error: unknown) => void) => {
      process.on('uncaughtException', listener);
    },
    onUnhandledRejection: (listener: (reason: unknown) => void) => {
      process.on('unhandledRejection', listener);
    },
    setExitCode: (code: ExitCode) => {
      process.exitCode = code;
    },
    exit: (code: ExitCode) => {
      process.exit(code);
    },
  });

// The code of a thrown value. describeError never throws, except with a
// RangeError when the stack is exhausted; then the code is internal
// (ADR 0054).
const codeOf = (value: unknown): ErrorCode => {
  try {
    return describeError(value).code;
  } catch {
    return 'internal';
  }
};

/**
 * Builds the process around the server over stdio and starts it. The
 * handlers for exceptions come right after the logger: each writes one
 * fixed event with the code of the value and ends the process with 70,
 * because its state is unknown then. SIGTERM and SIGINT write a fixed
 * event, close the server and let the process end with 143 or 130; a
 * second signal ends it at once. The mode of every call is `interactive`,
 * written here as a literal and never taken from the configuration, an
 * argument or a request (ADR 0003, ADR 0024).
 *
 * @param options - Configuration, catalog and the torn line of the
 *   notices, and replacements for tests.
 * @returns Undefined once the server runs; the process then gets its exit
 *   code when the connection ends. 70 when the start failed after the
 *   stderr writer came into being, after a fixed event.
 * @throws {TypeError} When the stderr writer or the logger cannot be
 *   built; nothing has been written to stderr then.
 * @example
 * ```ts
 * const code = serve({ config, catalog, afterTornLine: torn });
 * ```
 */
export function serve(options: ServeOptions): ExitCode | undefined {
  const { config, catalog, auditFile } = options;
  const host = options.host ?? processHost();
  const writer = createStderrWriter({
    afterTornLine: options.afterTornLine,
    ...(options.writeSync === undefined
      ? {}
      : { writeSync: options.writeSync }),
  });
  const clock = systemClock;
  const minLevel = config.logLevel;
  // Only this logger, which the mount gets, may name a prompt, and only one
  // the catalog offers (ADR 0065).
  const logger = createLogger({
    writer,
    clock,
    minLevel,
    prompts: new Set(catalog.prompts().map((prompt) => prompt.name)),
  });
  // The fixed events of a signal and of the end, at every level of the
  // log: the count of lost lines is the only trace of that loss, and the
  // signal explains the exit code (ADR 0054).
  const processLogger = createLogger({ writer, clock, minLevel: 'info' });

  const crash =
    (event: string) =>
    (value: unknown): void => {
      try {
        logger.error(event, { code: codeOf(value) });
      } finally {
        host.exit(exitCodes.internal);
      }
    };
  host.onUncaughtException(crash(uncaughtEvent));
  host.onUnhandledRejection(crash(rejectionEvent));

  let transport: HttpTransport | undefined;
  try {
    transport = (options.createTransport ?? createHttpTransport)({
      origin: config.churchtoolsOrigin,
      token: config.churchtoolsToken,
      userAgent,
      // Bound to the tenant default, so that the lines of the transport
      // name the same tenant as the lines and the audit of a call.
      logger: createDefaultTenantLogger({ writer, clock, minLevel }),
      clock,
    });
    const pipeline = createToolPipeline({
      catalog,
      audit: createAuditSink({
        writer,
        clock,
        isKnownTool: catalog.has,
        ...(auditFile === undefined ? {} : { file: auditFile }),
      }),
      transport,
      origin: config.churchtoolsOrigin,
      requestsPerMinute: config.churchtoolsRequestsPerMinute,
      clock,
      logging: { writer, minLevel },
      // The counters of the read budget, in the folder the first stage
      // prepared. Without the folder of state there is no store, and no
      // tool with sensitivity special runs (ADR 0063).
      ...(config.stateDir === undefined
        ? {}
        : {
            quota: createFileQuotaStore({
              stateDir: config.stateDir,
              clock,
              pid: process.pid,
              host: hostname(),
            }),
          }),
    });
    const server = startStdioServer({
      catalog,
      pipeline,
      identity: createStdioIdentity(config),
      resolver: createStdioTenantResolver(),
      mode: 'interactive',
      redaction: config.redaction,
      readOnly: config.readOnly,
      logger,
      version,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.output === undefined ? {} : { output: options.output }),
    });

    let signalCode: ExitCode | undefined;
    const onSignal = (event: string, code: ExitCode) => (): void => {
      if (signalCode !== undefined) {
        host.exit(code);
        return;
      }
      signalCode = code;
      processLogger.info(event);
      // Closing ends the connection, and the end below ends the process.
      void server.close();
    };
    host.onSignal('SIGTERM', onSignal(sigtermEvent, exitCodes.terminated));
    host.onSignal('SIGINT', onSignal(sigintEvent, exitCodes.interrupted));

    const open = transport;
    void server.closed.then(async () => {
      const code = signalCode ?? exitCodes.ok;
      host.setExitCode(code);
      // Armed before the transport closes, which waits for running
      // requests, so that nothing can hold the process past the deadline.
      // unref, so that the deadline itself holds nothing.
      setTimeout(() => {
        host.exit(code);
      }, closeDeadlineMs).unref();
      try {
        await open.close();
      } catch {
        // The process ends either way, and the reason would name nothing
        // an operator could act on.
      }
      // After the transport: a call that still ends writes its line into
      // the file. stdio_closed stays the last line.
      if (auditFile !== undefined) {
        processLogger.info(auditFileClosedEvent, {
          count: Math.min(auditFile.counts().failed, maxCount),
        });
        auditFile.close();
      }
      processLogger.info(closedEvent, {
        count: Math.min(writer.stats().failed, maxCount),
      });
    });
    return undefined;
  } catch (error) {
    logger.error(startFailedEvent, { code: codeOf(error) });
    void transport?.close().catch(() => undefined);
    auditFile?.close();
    return exitCodes.internal;
  }
}
