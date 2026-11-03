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
 * if there is one (ADR 0028). In the level `strict` the pipeline gets the
 * provider of the keys for pseudonyms, built from the key files (ADR
 * 0069). The start asks ChurchTools nothing:
 * `ct_whoami` checks the token, so the token leaves the process only for a
 * call. With an audit file, the start deletes the files of the folder
 * `audit` past their retention, and a timer starts the file of each new
 * UTC day also in a run without calls (ADR 0028). With a folder of keys,
 * the start and the same timer on each new UTC day destroy the day keys
 * of the snapshots past their retention of 30 days, and, with a folder of
 * state, remove their records of those days as well (ADR 0031).
 * When the
 * connection ends, the transport closes, the event
 * `audit_file_closed` counts the lines the audit file lost, the file
 * closes with the anchor of its chain, `audit_chain_anchor`, if it has a
 * line, the event `stdio_closed` counts the lines stderr lost, and the
 * process ends with the code of an earlier signal or 0. All state lives
 * in the closure of {@link serve}.
 *
 * @packageDocumentation
 */
import type { Readable, Writable } from 'node:stream';

import {
  createStdioIdentity,
  createStdioTenantResolver,
  type EccliumConfig,
  type ToolCatalog,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditFileWriter,
  createLogger,
  createStderrWriter,
  describeError,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  type ErrorCode,
  type IsoDate,
  isIsoDate,
} from '@ecclium/mcp-churchtools-plugin-api';
import { startStdioServer } from '@ecclium/mcp-churchtools-server/stdio';

import { composeToolPipeline } from '../compose/pipeline.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import type { WriteSyncFn } from '../send.js';
import { version } from '../version.js';

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
const anchorEvent = 'audit_chain_anchor';
const filesDeletedEvent = 'audit_files_deleted';
const filesKeptEvent = 'audit_files_not_deleted';
const dayKeysDestroyedEvent = 'day_keys_destroyed';
const dayKeysKeptEvent = 'day_keys_not_destroyed';
const snapshotsDeletedEvent = 'snapshots_deleted';
const snapshotsKeptEvent = 'snapshots_not_deleted';
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

const dayMs = 86_400_000;
const hourMs = 3_600_000;

/**
 * Milliseconds from a time to the next look of the timer of a long run at
 * the day: one second after the next UTC midnight, but at most an hour.
 * A timer of Node.js does not count the time a computer sleeps, so after
 * a sleep the next look comes within the hour, not a day late.
 *
 * @param now - Milliseconds since the Unix epoch, from the clock.
 * @returns The delay, or an hour when the time is no finite number.
 */
export const untilNextDay = (now: number): number =>
  Number.isFinite(now)
    ? Math.min(dayMs - (((now % dayMs) + dayMs) % dayMs) + 1000, hourMs)
    : hourMs;

/**
 * How many days after its own a snapshot stays readable: the day key of
 * the snapshots of a day is destroyed once 30 more days are over, so a
 * snapshot of a day D opens through D+30 and in no copy from D+31 on
 * (ADR 0031).
 */
export const snapshotRetentionDays = 30;

/**
 * The first UTC day whose day keys of snapshots stay at a time: the day of
 * the time less {@link snapshotRetentionDays}. Every day key of an earlier
 * day is past its retention.
 *
 * @param now - Milliseconds since the Unix epoch, from the clock.
 * @returns The day, or undefined when the time gives no day from 1970 to
 *   9999.
 * @example
 * ```ts
 * firstKeptSnapshotDay(Date.UTC(2026, 10, 3, 12)); // '2026-10-04'
 * ```
 */
export const firstKeptSnapshotDay = (now: number): IsoDate | undefined => {
  if (!Number.isFinite(now)) return undefined;
  // A day in UTC has no change of the clock, so 30 times its length back
  // is the same time of the day 30 days before.
  const cut = new Date(now - snapshotRetentionDays * dayMs);
  if (Number.isNaN(cut.getTime())) return undefined;
  const day = cut.toISOString().slice(0, 10);
  return isIsoDate(day) ? day : undefined;
};

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
  let dayTimer: ReturnType<typeof setTimeout> | undefined;
  // The destruction of the day keys past their retention, with the
  // records of the snapshots when there are any, once the pipeline has its
  // day keys (ADR 0031).
  let sweepDayKeys: (() => void) | undefined;
  // After the start, on each new UTC day through the timer, also without a
  // call. The timer looks at least every hour: it starts the audit file of
  // a new day when the clock shows one and destroys the day keys past
  // their retention, each even when the other throws. unref, so that the
  // timer holds nothing.
  const armDayTimer = (): void => {
    let now = Number.NaN;
    try {
      now = clock.now();
    } catch {
      // An hour, and then the clock again.
    }
    dayTimer = setTimeout(() => {
      try {
        auditFile?.tick();
      } finally {
        try {
          sweepDayKeys?.();
        } finally {
          armDayTimer();
        }
      }
    }, untilNextDay(now)).unref();
  };
  if (auditFile !== undefined) {
    // The anchors of the chain of the audit file and the counts of its
    // sweeps, at every level of the log as well. Only this logger may write
    // the fields of an anchor (ADR 0028).
    const anchorLogger = createLogger({
      writer,
      clock,
      minLevel: 'info',
      anchors: true,
    });
    auditFile.attach({
      anchor: ({ file, seq, hash }) => {
        anchorLogger.info(anchorEvent, { file, seq, hash });
      },
      swept: ({ deleted, kept, complete }) => {
        if (deleted > 0) {
          processLogger.info(filesDeletedEvent, {
            count: Math.min(deleted, maxCount),
          });
        }
        if (kept > 0 || !complete) {
          processLogger.warn(
            filesKeptEvent,
            kept > 0 ? { count: Math.min(kept, maxCount) } : {},
          );
        }
      },
    });
    // At the start, and then on each new UTC day through the timer.
    auditFile.sweep();
  }

  const crash =
    (event: typeof uncaughtEvent | typeof rejectionEvent) =>
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
    // Transport, keys, audit sink, counters and pipeline, built as for
    // every command that talks to ChurchTools (ADR 0056).
    const composed = composeToolPipeline({
      config,
      catalog,
      writer,
      clock,
      auditFile,
      createTransport: options.createTransport,
    });
    transport = composed.transport;
    const { pipeline } = composed;
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

    // The day keys of the snapshots past their retention go at the start
    // and then once on each new UTC day (ADR 0031). With the folder of
    // state, the keeper of the snapshots removes the records of those days
    // and destroys the day keys of the same days, also while the server
    // only reads or keeps no snapshots, so the lines count records;
    // without that folder the day keys alone go, so that keys of an
    // earlier run that wrote still go in time. A day whose records or keys
    // could not all go is tried again at the next look of the timer,
    // within the hour. The lines name a count only, never a path or the
    // message of an error.
    const { dayKeys, snapshots } = composed;
    const retention:
      | {
          readonly purge: (cut: IsoDate) => Promise<number>;
          readonly gone: (count: number) => void;
          readonly kept: () => void;
        }
      | undefined =
      snapshots !== undefined
        ? {
            purge: (cut) => snapshots.purgeBefore(cut),
            gone: (count) => {
              processLogger.info(snapshotsDeletedEvent, { count });
            },
            kept: () => {
              processLogger.warn(snapshotsKeptEvent);
            },
          }
        : dayKeys !== undefined
          ? {
              purge: (cut) => dayKeys.destroyBefore('snapshot', cut),
              gone: (count) => {
                processLogger.info(dayKeysDestroyedEvent, { count });
              },
              kept: () => {
                processLogger.warn(dayKeysKeptEvent);
              },
            }
          : undefined;
    if (retention !== undefined) {
      let sweptFor: IsoDate | undefined;
      let sweeping = false;
      sweepDayKeys = (): void => {
        let now = Number.NaN;
        try {
          now = clock.now();
        } catch {
          // No day without the clock, which the line below says.
        }
        const cut = firstKeptSnapshotDay(now);
        if (cut === undefined) {
          retention.kept();
          return;
        }
        if (sweeping || cut === sweptFor) return;
        sweeping = true;
        // A promise that rejected is caught here: unhandled, it would end
        // the process through the handler above.
        void Promise.resolve()
          .then(() => retention.purge(cut))
          .then(
            (count) => {
              sweptFor = cut;
              if (Number.isSafeInteger(count) && count > 0) {
                retention.gone(Math.min(count, maxCount));
              }
            },
            () => {
              retention.kept();
            },
          )
          .catch(() => undefined)
          .finally(() => {
            sweeping = false;
          });
      };
      sweepDayKeys();
    }
    if (auditFile !== undefined || retention !== undefined) armDayTimer();

    let signalCode: ExitCode | undefined;
    const onSignal =
      (event: typeof sigtermEvent | typeof sigintEvent, code: ExitCode) =>
      (): void => {
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
      clearTimeout(dayTimer);
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
    clearTimeout(dayTimer);
    auditFile?.close();
    return exitCodes.internal;
  }
}
