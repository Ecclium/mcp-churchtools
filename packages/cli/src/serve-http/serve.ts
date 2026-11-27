/**
 * `ecclium serve-http` (ADR 0073, ADR 0074): the server over HTTP with
 * static bearer tokens, as one process that runs until a signal.
 *
 * The start runs in this order, and every check comes before the port:
 * the configuration over HTTP, which requires the folder of state and the
 * file of the tokens and refuses writes (78), the catalog of tools (70 for
 * a refusal of the registry or a docs index that cannot be read), the file
 * of the tokens, the audit file and the folder of the counters (78), the
 * proxy (69). Only then come the stderr writer, the pipeline and the
 * binding; an error of the binding ends with 78 as well.
 * The server reads; writing over HTTP comes with a later version.
 *
 * While it runs, the audit file of a new UTC day starts and the files past
 * their retention go, as over stdio, and the days of the last use of the
 * tokens that lie more than 365 days back go at the start and at every
 * look of the timer of the day, at least once an hour: a look with nothing
 * to remove costs one read and no lock. SIGTERM and SIGINT close the server: no new connection, the
 * running requests end within ten seconds, then the transport and the
 * audit file close, and the command ends with 143 or 130. A second signal
 * ends the process at once. SIGHUP is left to the process, so that a
 * server under `nohup` stays.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import {
  type ConfigResult,
  type ConfigSources,
  createBearerSignIn,
  createBearerTenantResolver,
  loadConfig,
  pruneBearerLastUses,
  readBearerTokensFile,
  type RefusalReason,
  refusalReasons,
  RegistryRefusal,
  type ToolCatalog,
  toolsetOf,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditFileWriter,
  anchorEventOf,
  createLogger,
  createStderrWriter,
  describeError,
  openAuditFile,
  prepareQuotaFolder,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  type HttpTransport,
  type HttpTransportOptions,
  type ProxyProbe,
  type ProxyProbeOptions,
  probeEgressProxy,
} from '@ecclium/mcp-churchtools-core/http';
import { DocsIndexError } from '@ecclium/mcp-churchtools-docs-index';
import type {
  Clock,
  ErrorCode,
  TenantId,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  HttpBindError,
  type HttpBindReason,
  type HttpListener,
  type HttpListenOptions,
  listenHttp,
} from '@ecclium/mcp-churchtools-server/http';

import { untilNextDay } from '../compose/day-timer.js';
import { composeToolPipeline } from '../compose/pipeline.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  auditFileText,
  egressProxyText,
  emptyToolsetText,
  problemText,
  quotaFolderText,
  refusalText,
  startText,
  toolsetsText,
  warningText,
} from '../messages/index.js';
import type { Output } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import {
  createStdioCatalog,
  type StdioCatalogOptions,
} from '../stdio/catalog.js';
import { tokensFileText } from '../token/texts.js';
import { version } from '../version.js';
import {
  bindText,
  listeningText,
  serveHttpTexts,
  tokensText,
} from './texts.js';

/** What the server over HTTP needs of its process. Tests replace it. */
export interface ServeHttpHost {
  /**
   * Adds a listener for a signal.
   *
   * @param signal - SIGINT or SIGTERM.
   * @param listener - Runs on every delivery of the signal.
   * @returns A function that removes the listener again.
   */
  readonly onSignal: (
    signal: 'SIGINT' | 'SIGTERM',
    listener: () => void,
  ) => () => void;
  /**
   * Adds a listener for an exception or a rejection that nothing caught.
   *
   * @param listener - Gets which of the two it was and the thrown value.
   * @returns A function that removes the listener again.
   */
  readonly onFault: (
    listener: (kind: 'exception' | 'rejection', value: unknown) => void,
  ) => () => void;
  /**
   * Ends the process at once.
   *
   * @param code - The exit code.
   */
  readonly exit: (code: ExitCode) => void;
}

/** What `ecclium serve-http` needs, with replacements for tests. */
export interface ServeHttpOptions {
  /** The environment of the process, which the command line took over. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The options Node.js was started with, for the options of TLS. */
  readonly execArgv: readonly string[];
  /** Where the texts for the operator go. */
  readonly output: Output;
  /** Replaces the loader of the configuration. */
  readonly load?: (sources: ConfigSources) => ConfigResult;
  /** Replaces `writeSync` from `node:fs` for the stderr writer. */
  readonly writeSync?: WriteSyncFn;
  /** Replaces the factory of the transport, such as with a double. */
  readonly createTransport?: (options: HttpTransportOptions) => HttpTransport;
  /** Replaces the binding, such as with one on a port the system picks. */
  readonly listen?: (options: HttpListenOptions) => Promise<HttpListener>;
  /** Replaces the process for signals, faults and the exit. */
  readonly host?: ServeHttpHost;
  /** Replaces the clock. */
  readonly clock?: Clock;
  /** Replaces the check of the proxy at the start (ADR 0035). */
  readonly probeProxy?: (options: ProxyProbeOptions) => Promise<ProxyProbe>;
  /** Replaces the reader of the docs index. */
  readonly readDocs?: StdioCatalogOptions['readDocs'];
}

/**
 * How long the process may take to end after a signal, in milliseconds:
 * the ten seconds the running requests get, and five more.
 */
export const closeDeadlineMs = 15_000;

// The highest count a log line takes.
const maxCount = 1_000_000;

// The process itself. Only properties of the global process are used, as
// in the rest of the command line.
const processHttpHost = (): ServeHttpHost =>
  Object.freeze({
    onSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      process.on(signal, listener);
      return () => {
        process.off(signal, listener);
      };
    },
    onFault: (
      listener: (kind: 'exception' | 'rejection', value: unknown) => void,
    ) => {
      const exception = (error: unknown): void => {
        listener('exception', error);
      };
      const rejection = (reason: unknown): void => {
        listener('rejection', reason);
      };
      process.on('uncaughtException', exception);
      process.on('unhandledRejection', rejection);
      return () => {
        process.off('uncaughtException', exception);
        process.off('unhandledRejection', rejection);
      };
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

// Whether a thrown value is the refusal of the docs index, without running
// code of a proxy.
const isDocsIndexError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  !isProxy(error) &&
  error instanceof DocsIndexError;

// An own data property of an error of this workspace; a getter never runs.
const ownOf = (error: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(error, key)?.value;

// The reason of a refusal of the registry, or undefined for anything else.
const refusalOf = (error: unknown): RefusalReason | undefined => {
  if (
    typeof error !== 'object' ||
    error === null ||
    isProxy(error) ||
    !(error instanceof RegistryRefusal)
  ) {
    return undefined;
  }
  const reason = ownOf(error, 'reason');
  return refusalReasons.find((known) => known === reason);
};

// The reason and the code of the system of an error of the binding, or
// undefined for anything else.
const bindOf = (
  error: unknown,
):
  | { readonly reason: HttpBindReason; readonly code: string | undefined }
  | undefined => {
  if (
    typeof error !== 'object' ||
    error === null ||
    isProxy(error) ||
    !(error instanceof HttpBindError)
  ) {
    return undefined;
  }
  const reason = ownOf(error, 'reason');
  const code = ownOf(error, 'code');
  const reasons: readonly HttpBindReason[] = [
    'address',
    'allowed-hosts',
    'port',
    'listen',
  ];
  const known = reasons.find((item) => item === reason);
  return known === undefined
    ? undefined
    : { reason: known, code: typeof code === 'string' ? code : undefined };
};

// The UTC day of the clock, as YYYY-MM-DD.
const dayOf = (clock: Clock): string =>
  new Date(clock.now()).toISOString().slice(0, 10);

/**
 * Runs `ecclium serve-http` until a signal ends it.
 *
 * @param options - Environment, output, and replacements for tests.
 * @returns The exit code: 143 after SIGTERM, 130 after SIGINT, 78 for an
 *   invalid configuration, a file of the tokens, an audit file or a folder
 *   that cannot be used, or an address and port it cannot bind, 69 for a
 *   proxy without a tunnel to ChurchTools, 70 for a refusal of the
 *   registry or a fault after the start notices.
 * @throws {TypeError} For an internal error before the stderr writer,
 *   which the command line turns into 70.
 * @example
 * ```ts
 * process.exitCode = await runServeHttp({ environment, execArgv, output });
 * ```
 */
export async function runServeHttp(
  options: ServeHttpOptions,
): Promise<ExitCode> {
  const { output } = options;
  const clock = options.clock ?? systemClock;
  const loaded = (options.load ?? loadConfig)({
    environment: options.environment,
    transport: 'http',
    execArgv: options.execArgv,
  });
  for (const problem of loaded.report.problems) {
    output.stderr(problemText(problem));
  }
  for (const code of loaded.report.warnings) output.stderr(warningText(code));
  if (!loaded.ok) return exitCodes.invalidConfig;
  const { config } = loaded;
  const { stateDir, httpTokensFile } = config;
  // The loader requires both over HTTP and refuses writes there; this
  // holds the types to it.
  if (stateDir === undefined || httpTokensFile === undefined) {
    return exitCodes.invalidConfig;
  }

  let catalog: ToolCatalog;
  try {
    catalog = createStdioCatalog(
      config,
      options.readDocs === undefined ? {} : { readDocs: options.readDocs },
    );
  } catch (error) {
    // With the toolset docs and no usable index the start stops, as over
    // stdio (ADR 0066).
    if (isDocsIndexError(error)) {
      output.stderr(startText('docs_index'));
      return exitCodes.internal;
    }
    const reason = refusalOf(error);
    if (reason === undefined) throw error;
    output.stderr(refusalText(reason));
    return exitCodes.internal;
  }
  // Which toolsets are on, and each one that brings no tool (ADR 0062).
  const { toolsets } = config;
  if (toolsets.length > 0) output.stderr(toolsetsText(toolsets));
  for (const name of toolsets) {
    if (
      !catalog.list().some((entry) => toolsetOf(entry.meta.domain) === name)
    ) {
      output.stderr(emptyToolsetText(name));
    }
  }

  // The file of the tokens must be valid at the start, so that a typo does
  // not wait for the first client. While the server runs it reads the file
  // anew for every request (ADR 0074).
  const tokens = readBearerTokensFile(httpTokensFile);
  if (!tokens.ok) {
    output.stderr(tokensFileText(tokens.code, tokens.field, tokens.line));
    return exitCodes.invalidConfig;
  }
  const today = dayOf(clock);
  const valid = tokens.entries.filter(
    (entry) => entry.createdAt <= today && today <= entry.expiresAt,
  );
  output.stderr(
    valid.length === 0
      ? serveHttpTexts.noToken
      : tokensText(
          valid.length,
          valid.filter((entry) => entry.scopes.includes('write')).length,
        ),
  );
  output.stderr(serveHttpTexts.readOnly);

  // Every call over HTTP goes into the audit file before its result
  // (ADR 0028), and the counters and the last use lie next to it.
  const opened = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!opened.ok) {
    output.stderr(auditFileText(opened.code));
    return exitCodes.invalidConfig;
  }
  const auditFile = opened.writer;
  let handedOver = false;
  try {
    const prepared = prepareQuotaFolder(stateDir);
    if (!prepared.ok) {
      output.stderr(quotaFolderText(prepared.code));
      return exitCodes.invalidConfig;
    }
    // With a proxy, a tunnel to ChurchTools before the first call, without
    // a request to ChurchTools (ADR 0035).
    if (config.egressProxy !== undefined) {
      const checked = await (options.probeProxy ?? probeEgressProxy)({
        proxy: config.egressProxy,
        origin: config.churchtoolsOrigin,
      });
      if (!checked.ok) {
        output.stderr(egressProxyText(checked.reason));
        return exitCodes.unavailable;
      }
    }
    handedOver = true;
    return await serve({ ...options, clock, config, catalog, auditFile });
  } finally {
    if (!handedOver) auditFile.close();
  }
}

/** What the second part of the start gets. */
interface ServeParts extends ServeHttpOptions {
  readonly clock: Clock;
  readonly config: Extract<ConfigResult, { readonly ok: true }>['config'];
  readonly catalog: ToolCatalog;
  readonly auditFile: AuditFileWriter;
}

// The writer, the loggers, the pipeline and the binding, and then the
// wait for a signal. Every failure here writes a fixed line and closes
// what is open.
const serve = async (parts: ServeParts): Promise<ExitCode> => {
  const { output, clock, config, catalog, auditFile } = parts;
  const host = parts.host ?? processHttpHost();
  const writer = createStderrWriter(
    parts.writeSync === undefined ? {} : { writeSync: parts.writeSync },
  );
  const minLevel = config.logLevel;
  const prompts = new Set(catalog.prompts().map((prompt) => prompt.name));
  const logger = createLogger({ writer, clock, minLevel, prompts });
  // The fixed lines of a signal, of the end and of the sweeps, at every
  // level of the log (ADR 0054).
  const processLogger = createLogger({ writer, clock, minLevel: 'info' });
  const anchorLogger = createLogger({
    writer,
    clock,
    minLevel: 'info',
    anchors: true,
  });
  auditFile.attach({
    anchor: (anchor) => {
      const { file, seq, hash } = anchor;
      anchorLogger.info(anchorEventOf(anchor), { file, seq, hash });
    },
    swept: ({ deleted, kept, complete }) => {
      if (deleted > 0) {
        processLogger.info('audit_files_deleted', {
          count: Math.min(deleted, maxCount),
        });
      }
      if (kept > 0 || !complete) {
        processLogger.warn(
          'audit_files_not_deleted',
          kept > 0 ? { count: Math.min(kept, maxCount) } : {},
        );
      }
    },
  });

  let signalled: ExitCode | undefined;
  let wake: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const onSignal =
    (event: 'process_sigterm' | 'process_sigint', code: ExitCode) =>
    (): void => {
      if (signalled !== undefined) {
        host.exit(code);
        return;
      }
      signalled = code;
      processLogger.info(event);
      output.stderr(serveHttpTexts.signal);
      wake();
    };
  const removers = [
    host.onSignal('SIGTERM', onSignal('process_sigterm', exitCodes.terminated)),
    host.onSignal('SIGINT', onSignal('process_sigint', exitCodes.interrupted)),
    host.onFault((kind, value) => {
      try {
        logger.error(
          kind === 'exception'
            ? 'process_uncaught_exception'
            : 'process_unhandled_rejection',
          { code: codeOf(value) },
        );
      } finally {
        host.exit(exitCodes.internal);
      }
    }),
  ];
  const removeListeners = (): void => {
    for (const remove of removers) {
      try {
        remove();
      } catch {
        // The command ends either way.
      }
    }
  };

  let transport: HttpTransport | undefined;
  let dayTimer: ReturnType<typeof setTimeout> | undefined;
  // Set once the close begins, so that a look of the timer that was still
  // running then arms no new one.
  let closing = false;
  let listener: HttpListener | undefined;
  const closeAll = async (): Promise<void> => {
    closing = true;
    clearTimeout(dayTimer);
    try {
      await transport?.close();
    } catch {
      // The process ends either way, and the reason names nothing an
      // operator could act on.
    }
    processLogger.info('audit_file_closed', {
      count: Math.min(auditFile.counts().failed, maxCount),
    });
    auditFile.close();
  };
  try {
    auditFile.sweep();
    // Transport, keys, audit sink, counters and pipeline, as for every
    // command that talks to ChurchTools (ADR 0056).
    const composed = composeToolPipeline({
      config,
      catalog,
      writer,
      clock,
      auditFile,
      createTransport: parts.createTransport,
    });
    transport = composed.transport;
    const quota = composed.quota;
    // The days of the last use past their retention, at the start and on
    // each new UTC day (ADR 0074). A store that fails never stops the
    // server, as with the note of a day.
    const prune = async (): Promise<void> => {
      if (quota === undefined) return;
      try {
        const count = await pruneBearerLastUses(quota);
        if (count > 0) {
          processLogger.info('http_last_use_pruned', {
            count: Math.min(count, maxCount),
          });
        }
      } catch {
        processLogger.warn('http_last_use_not_pruned');
      }
    };
    await prune();
    const armDayTimer = (): void => {
      if (closing) return;
      let now = Number.NaN;
      try {
        now = clock.now();
      } catch {
        // An hour, and then the clock again.
      }
      dayTimer = setTimeout(() => {
        try {
          auditFile.tick();
        } finally {
          void prune().finally(armDayTimer);
        }
      }, untilNextDay(now)).unref();
    };
    armDayTimer();

    const signIn = createBearerSignIn({
      tokensFile: config.httpTokensFile ?? '',
      clock,
      ...(quota === undefined ? {} : { lastUse: { store: quota, logger } }),
    });
    listener = await (parts.listen ?? listenHttp)({
      catalog,
      pipeline: composed.pipeline,
      authenticate: (request) => signIn(request.headers.get('authorization')),
      resolver: createBearerTenantResolver(),
      // Written here as a literal, never taken from the configuration, an
      // argument or a request (ADR 0003, ADR 0024).
      mode: 'interactive',
      redaction: config.redaction,
      readOnly: config.readOnly,
      logger,
      // The lines of a prompt name the tenant of the request (ADR 0065).
      promptLoggerFor: (tenantId: TenantId) =>
        createLogger({
          writer,
          clock,
          minLevel,
          prompts,
          bound: { tenantId },
        }),
      version,
      host: config.httpAddress,
      port: config.httpPort,
      ...(config.allowedHosts === undefined
        ? {}
        : { allowedHosts: config.allowedHosts }),
    });
  } catch (error) {
    const bind = bindOf(error);
    if (bind === undefined) {
      logger.error('http_start_failed', { code: codeOf(error) });
    } else {
      output.stderr(bindText(bind.reason, bind.code));
    }
    await closeAll();
    removeListeners();
    return bind === undefined ? exitCodes.internal : exitCodes.invalidConfig;
  }

  output.stderr(listeningText(listener));
  await stopped;
  const code = signalled ?? exitCodes.internal;
  // Armed before the close, which waits for running requests, so that
  // nothing can hold the process past the deadline. unref, so that the
  // deadline itself holds nothing.
  setTimeout(() => {
    host.exit(code);
  }, closeDeadlineMs).unref();
  await listener.close();
  await closeAll();
  processLogger.info('http_closed', {
    count: Math.min(writer.stats().failed, maxCount),
  });
  removeListeners();
  return code;
};
