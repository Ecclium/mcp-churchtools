/**
 * One process of the runner (ADR 0033, ADR 0034): what `ecclium run-once`
 * and the daemon set up once, and a pass with the models of that pass.
 *
 * Once per process: the folders a pass needs, the audit file with the
 * anchors of its chain, the store with the memory of runs, the locks of
 * the routines, the halt of writes and the deletion past the retention.
 * Per pass: the models with their keys, read anew, so that a new key takes
 * effect with the next pass, and built only when a run needs one, so that
 * a pass over routines that are not due reads no key; the ports; and
 * after the pass the ping to the monitoring, with a transport of its own
 * that is gone again before the next look (ADR 0009). Tokens are read
 * anew for every run by its pipeline.
 *
 * Where it stands: the composition root of the runner. The commands
 * around it say on stderr what became of each routine and end the
 * process; nothing here ends it.
 *
 * @packageDocumentation
 */
import type {
  GuardedModel,
  PrivateFileCode,
} from '@ecclium/mcp-churchtools-core';
import {
  anchorEventOf,
  type AuditFileWriter,
  createDefaultTenantLogger,
  createFileQuotaStore,
  createLogger,
  createRoutineLocks,
  createStderrWriter,
  createWriteHalt,
  openAuditFile,
  prepareDayKeyFolder,
  preparePrivateFolder,
  prepareQueueFolder,
  prepareQuotaFolder,
  prepareSnapshotFolder,
  routineLockLimits,
  systemClock,
  writesHalted,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  createPingHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
  type PingHttpTransportOptions,
  type PingTransport,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';
import {
  type MetricsChainHead,
  type PassReport,
  pingOf,
  previewRoutine,
  type PreviewReport,
  type RoutineReport,
  runByHand,
  runDue,
} from '@ecclium/mcp-churchtools-runner';

import { composeModelProviders } from '../compose/model.js';
import { privateFileCodeOf } from '../compose/private-file-code.js';
import { keepsQueue } from '../compose/queue.js';
import {
  composeRetentionKeepers,
  createRetentionSweep,
} from '../compose/retention.js';
import { keepsSnapshots } from '../compose/snapshots.js';
import { userAgent } from '../version.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  auditFileMessage,
  dayKeyFolderMessage,
  type Message,
  queueFolderMessage,
  quotaFolderMessage,
  snapshotFolderMessage,
} from '../messages/index.js';
import type { Output } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import { metricsFolderOf, updateMetricsFile } from './metrics-file.js';
import { composeRunnerPorts, hostName, type ModelOfAlias } from './ports.js';
import type { RunnerMode, RunnerStart } from './start.js';
import {
  draftsFolderText,
  metricsFolderText,
  modelKeyText,
  providerText,
} from './texts.js';

/** A runner that started. */
export type StartedRunner = Extract<RunnerStart, { readonly ok: true }>;

/** What a process of the runner is built from, with replacements for tests. */
export interface RunnerProcessOptions {
  readonly started: StartedRunner;
  readonly mode: RunnerMode;
  readonly output: Output;
  /** Replaces `writeSync` for the lines of the log and the audit. */
  readonly writeSync?: WriteSyncFn;
  /** Replaces the transport to ChurchTools. */
  readonly createTransport?: (options: HttpTransportOptions) => HttpTransport;
  /** Replaces the transport to a model. */
  readonly createModelTransport?: Parameters<
    typeof composeModelProviders
  >[0]['createTransport'];
  /** Replaces the reading of the file of a key of a model. */
  readonly readModelKey?: Parameters<
    typeof composeModelProviders
  >[0]['readKey'];
  /** Replaces the transport to the ping of the runner (ADR 0009). */
  readonly createPingTransport?: (
    options: PingHttpTransportOptions,
  ) => PingTransport;
  /** Replaces the clock. */
  readonly clock?: Clock;
}

/** What a pass takes from the signals of the process. */
export interface PassWatch {
  /** Stops reading and the model, never a write. */
  readonly signal: AbortSignal;
  /** Marks a write that has begun until it ends. */
  readonly writing?: () => () => void;
}

/** What a pass leaves for the next one and for a monitoring. */
export interface PassAfter {
  /** When the runner looks at each routine that runs again, by ID. */
  readonly next: ReadonlyMap<string, number>;
  /**
   * Whether the metrics file holds the new metrics; undefined without
   * `ECCLIUM_RUNNER_METRICS_FILE`.
   */
  readonly metrics?: boolean;
}

/** An open process of the runner. */
export interface RunnerProcess {
  /** The logger of the process, at the level info at least. */
  readonly logger: Logger;
  /** The clock of the process. */
  readonly clock: Clock;
  /**
   * Deletes past their retention the audit files and the day keys of the
   * snapshots and of the queue with their records, at the start of the
   * process. A preview deletes nothing. It never throws.
   */
  sweep(): void;
  /**
   * Starts the audit file of a new UTC day, which deletes the audit files
   * past their retention, and deletes the day keys past theirs, once per
   * day, for the daemon at each wake. It never throws.
   */
  tick(): void;
  /**
   * One pass over the routines that are due, or the one routine by hand.
   *
   * @param watch - The signal and the mark of a write.
   * @returns What became of each routine. It never rejects.
   */
  pass(watch: PassWatch): Promise<PassReport>;
  /**
   * The preview of the one routine.
   *
   * @param watch - The signal.
   * @returns What became of the preview. It never rejects.
   */
  preview(watch: PassWatch): Promise<PreviewReport>;
  /**
   * After a pass: when the runner looks at each routine again, and the
   * metrics file with the head of the chain of the audit file.
   *
   * @param reports - What became of the routines of the pass.
   * @param looks - Whether the caller needs the next looks; they are
   *   asked for the metrics file in any case.
   * @returns The next looks, empty when nobody needs them, and whether the
   *   metrics file took them.
   */
  after(reports: readonly RoutineReport[], looks: boolean): Promise<PassAfter>;
  /**
   * After a pass: the ping to the address of `ECCLIUM_RUNNER_PING_URL_FILE`
   * (ADR 0009), a success or to `/fail` as `pingOf` decides, nothing for a
   * pass in which nothing was due, without an address or after a signal.
   * A ping that fails leaves the lines of its transport in the log and
   * changes no run and no exit code.
   *
   * @param reports - What became of the routines of the pass.
   * @param refused - How many routines of the runner do not start; 0 for
   *   a run by hand.
   * @param signal - The signal of the process, which aborts the ping.
   * @returns When the ping is sent or given up. It never rejects.
   */
  ping(
    reports: readonly RoutineReport[],
    refused: number,
    signal: AbortSignal,
  ): Promise<void>;
  /** Whether the halt of writes of the process holds (ADR 0029). */
  writesHalted(): boolean;
  /** Closes the audit file with the anchor of its chain. Never throws. */
  close(): void;
}

/** The open process, or the exit code of the problem that kept it shut. */
export type RunnerProcessResult =
  | { readonly ok: true; readonly process: RunnerProcess }
  | { readonly ok: false; readonly code: ExitCode };

// The highest count a log line takes.
const maxCount = 1_000_000;

// A text of the start about a folder it could not use, said of the runner.
const runnerText = (message: Message): string =>
  `${message.what.replace(', und der Start bricht ab.', ', und der Runner startet nicht.')} ${message.why} ${message.action}`;

/**
 * Opens a process of the runner: prepares its folders, opens its audit
 * file and builds what a pass needs once.
 *
 * @param options - The started runner, the mode of the call, the output,
 *   and replacements for tests.
 * @returns The open process, or 78 after a text on stderr for a folder or
 *   an audit file that cannot be used.
 * @throws {TypeError} Only for an internal error.
 * @example
 * ```ts
 * const opened = openRunnerProcess({ started, mode, output });
 * if (!opened.ok) return opened.code;
 * ```
 */
export function openRunnerProcess(
  options: RunnerProcessOptions,
): RunnerProcessResult {
  const { output, mode } = options;
  const { config, catalog, routines, refused, target } = options.started;
  const fail = (text: string): RunnerProcessResult => {
    output.stderr(text);
    return Object.freeze({ ok: false, code: exitCodes.invalidConfig });
  };
  // The start keeps a call by hand or a preview without its routine from
  // here, and the loader of the runner requires the folder of state.
  const running =
    mode.kind === 'due' ? routines : target === undefined ? [] : [target];
  const { stateDir } = config;
  if (stateDir === undefined || (mode.kind !== 'due' && target === undefined)) {
    return Object.freeze({ ok: false, code: exitCodes.invalidConfig });
  }
  const preview = mode.kind === 'preview';
  const prepared = prepareQuotaFolder(stateDir);
  if (!prepared.ok) return fail(runnerText(quotaFolderMessage(prepared.code)));

  // Each folder a pass writes into, made private before the first run. A
  // preview writes nothing.
  const steps: (readonly [() => void, (code: PrivateFileCode) => string])[] =
    [];
  const { draftsDir, metricsFile } = config;
  if (
    !preview &&
    draftsDir !== undefined &&
    running.some((run) => run.loaded.routine.output.target === 'draft')
  ) {
    steps.push([
      () => {
        preparePrivateFolder(draftsDir);
      },
      draftsFolderText,
    ]);
  }
  // The folders a write into the wiki needs, as the start over stdio and
  // `ecclium queue approve` prepare them: the day keys and the records of
  // the snapshots, and the queue of approvals (ADR 0031). Without them the
  // snapshot of every write fails and the write ends as an internal error.
  if (
    !preview &&
    running.some((run) => run.loaded.routine.output.target === 'wiki')
  ) {
    if (keepsSnapshots(config)) {
      const { keysDir } = config;
      steps.push(
        [
          () => {
            prepareDayKeyFolder(keysDir, 'snapshot');
          },
          (code) => runnerText(dayKeyFolderMessage(code)),
        ],
        [
          () => {
            prepareSnapshotFolder(stateDir);
          },
          (code) => runnerText(snapshotFolderMessage(code)),
        ],
      );
    }
    if (keepsQueue(config)) {
      steps.push([
        () => {
          prepareQueueFolder(stateDir);
        },
        (code) => runnerText(queueFolderMessage(code)),
      ]);
    }
  }
  if (!preview && metricsFile !== undefined) {
    steps.push([
      () => {
        preparePrivateFolder(metricsFolderOf(metricsFile));
      },
      metricsFolderText,
    ]);
  }
  for (const [prepare, text] of steps) {
    try {
      prepare();
    } catch (error) {
      const code = privateFileCodeOf(error);
      if (code === undefined) throw error;
      return fail(text(code));
    }
  }

  const clock = options.clock ?? systemClock;
  const opened = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!opened.ok) return fail(runnerText(auditFileMessage(opened.code)));
  const auditFile: AuditFileWriter = opened.writer;
  // Everything after the open of the audit file closes it again, also
  // after a fault.
  try {
    const writer = createStderrWriter(
      options.writeSync === undefined ? {} : { writeSync: options.writeSync },
    );
    // The anchor of the chain goes to the log when the file closes, after
    // a write and on a new day, as with the server (ADR 0028), and the
    // last one into the metrics file.
    const anchorLogger = createLogger({
      writer,
      clock,
      minLevel: 'info',
      anchors: true,
    });
    const processLogger = createLogger({ writer, clock, minLevel: 'info' });
    let head: MetricsChainHead | undefined;
    auditFile.attach({
      anchor: (anchor) => {
        const { file, seq, hash } = anchor;
        head = Object.freeze({ file, seq, hash });
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
    const modelLogger = createDefaultTenantLogger({
      writer,
      clock,
      minLevel: config.logLevel,
    });
    // Once per process: the memory of runs, the locks and the halt of
    // writes, which a line of the audit that did not reach the file sets
    // until a restart (ADR 0029).
    const store = createFileQuotaStore({
      stateDir,
      clock,
      pid: process.pid,
      host: hostName(),
    });
    const locks = createRoutineLocks({
      stateDir,
      clock,
      pid: process.pid,
      host: hostName(),
    });
    const writeHalt = createWriteHalt();
    // The deletion past the retention, which a preview leaves alone, since
    // it writes nothing (ADR 0031).
    const sweepDayKeys = preview
      ? undefined
      : createRetentionSweep({
          ...composeRetentionKeepers(config, clock),
          clock,
          logger: processLogger,
        });

    // The models of one pass, built when a run first needs one; the key of
    // each is read for this pass. A key file that cannot be used stops
    // only the routines of its model.
    const modelsOfPass = () => {
      const built = new Map<string, ModelOfAlias>();
      const closers: (() => Promise<void>)[] = [];
      const model = (alias: string): ModelOfAlias => {
        const known = built.get(alias);
        if (known !== undefined) return known;
        const provider = (config.providers ?? []).find(
          (item) => item.alias === alias,
        );
        let result: ModelOfAlias = Object.freeze({
          ok: false,
          code: 'run_model_unknown',
        });
        if (provider !== undefined) {
          output.stderr(providerText(provider));
          const made = composeModelProviders({
            providers: [provider],
            logger: modelLogger,
            clock,
            proxy: config.egressProxy,
            ...(options.readModelKey === undefined
              ? {}
              : { readKey: options.readModelKey }),
            ...(options.createModelTransport === undefined
              ? {}
              : { createTransport: options.createModelTransport }),
          });
          if (made.ok) {
            closers.push(() => made.close());
            const found: GuardedModel | undefined = made.models.get(alias);
            if (found !== undefined) {
              result = Object.freeze({ ok: true, model: found });
            }
          } else {
            output.stderr(modelKeyText(made.alias, made.code));
            result = Object.freeze({ ok: false, code: made.code });
          }
        }
        built.set(alias, result);
        return result;
      };
      return {
        model,
        close: () =>
          Promise.all(
            closers.map((close) => close().catch(() => undefined)),
          ).then(() => undefined),
      };
    };

    const portsOf = (
      model: (alias: string) => ModelOfAlias,
      writing: (() => () => void) | undefined,
    ) =>
      composeRunnerPorts({
        config,
        catalog,
        routines,
        model,
        ...(writing === undefined ? {} : { writing }),
        writer,
        clock,
        auditFile,
        store,
        locks,
        writeHalt,
        output,
        pid: process.pid,
        ...(options.createTransport === undefined
          ? {}
          : { createTransport: options.createTransport }),
      });

    const withModels = async <T>(
      watch: PassWatch,
      work: (ports: ReturnType<typeof portsOf>) => Promise<T>,
    ): Promise<T> => {
      const models = modelsOfPass();
      try {
        return await work(portsOf(models.model, watch.writing));
      } finally {
        await models.close();
      }
    };

    // The lines of the audit the metrics file last named, so that a pass
    // that wrote none adds no anchor to the log.
    let anchoredAt = 0;
    let open = true;

    const runner: RunnerProcess = Object.freeze({
      logger: processLogger,
      clock,
      sweep: () => {
        if (preview) return;
        try {
          auditFile.sweep();
        } finally {
          sweepDayKeys?.();
        }
      },
      tick: () => {
        try {
          auditFile.tick();
        } finally {
          sweepDayKeys?.();
        }
      },
      pass: (watch: PassWatch) =>
        withModels(watch, async (ports) => {
          const passOptions = {
            signal: watch.signal,
            maxRunMs: routineLockLimits.maxRunMs,
          };
          if (mode.kind !== 'due') {
            // The open of the process made sure of the routine.
            if (target === undefined) {
              return Object.freeze({ routines: [], severity: 'config' });
            }
            const done = await runByHand(target, ports, passOptions);
            return Object.freeze({
              routines: Object.freeze([done]),
              severity: done.severity,
            });
          }
          return runDue(routines, ports, passOptions);
        }),
      preview: (watch: PassWatch) => {
        // The open of the process made sure of the routine.
        const run = target;
        if (run === undefined) {
          return Promise.resolve(
            Object.freeze({
              routineId: mode.kind === 'due' ? '' : mode.routineId,
              status: 'internal',
              severity: 'internal',
            } as const),
          );
        }
        return withModels(watch, (ports) =>
          previewRoutine(run, ports, {
            signal: watch.signal,
            maxRunMs: routineLockLimits.maxRunMs,
          }),
        );
      },
      after: async (
        reports: readonly RoutineReport[],
        looks: boolean,
      ): Promise<PassAfter> => {
        const next = new Map<string, number>();
        // Each look reads the memory of runs; nobody needs them otherwise.
        if (!looks && metricsFile === undefined) {
          return Object.freeze({ next });
        }
        const ports = portsOf(
          () => Object.freeze({ ok: false, code: 'run_model_unknown' }),
          undefined,
        );
        for (const run of routines) {
          const check = await ports.schedule.due(run);
          next.set(run.loaded.routine.id, check.next);
        }
        if (metricsFile === undefined) return Object.freeze({ next });
        // The head of the chain of what this process wrote, flushed first,
        // so that the metrics file names lines that are on the disk.
        const { written } = auditFile.counts();
        if (written !== anchoredAt) {
          anchoredAt = written;
          auditFile.anchor();
        }
        const metrics = updateMetricsFile(
          metricsFile,
          {
            routineIds: [
              ...routines.map((run) => run.loaded.routine.id),
              ...refused.map((item) => item.routineId),
            ],
            refused,
            reports,
            next,
            chain: head,
          },
          process.pid,
        );
        return Object.freeze({ next, metrics });
      },
      ping: async (
        reports: readonly RoutineReport[],
        refusedCount: number,
        signal: AbortSignal,
      ): Promise<void> => {
        const url = config.runnerPingUrl;
        // After a signal the process ends without waiting for a ping.
        if (url === undefined || signal.aborted) return;
        let transport: PingTransport | undefined;
        try {
          const kind = pingOf(reports, {
            refused: refusedCount,
            halted: writesHalted(writeHalt),
          });
          if (kind === undefined) return;
          // With the logger of the transports to a model, bound to the
          // tenant at the level of the configuration, and through the
          // proxy of every transport (ADR 0035).
          transport = (options.createPingTransport ?? createPingHttpTransport)({
            url,
            userAgent,
            logger: modelLogger,
            clock,
            proxy: config.egressProxy,
          });
          await transport.ping(kind, { signal });
        } catch {
          // A failure of the transport has its line in the log; the error
          // itself is never looked at, and a ping that fails changes no
          // run and no exit code (ADR 0009).
        } finally {
          // Destroyed, not closed: no connection may keep `ecclium
          // run-once` alive, and closing would wait for a tunnel the
          // proxy holds.
          await transport?.destroy().catch(() => undefined);
        }
      },
      writesHalted: () => writesHalted(writeHalt),
      close: () => {
        if (!open) return;
        open = false;
        processLogger.info('audit_file_closed', {
          count: Math.min(auditFile.counts().failed, maxCount),
        });
        auditFile.close();
      },
    });
    return Object.freeze({ ok: true, process: runner });
  } catch (error) {
    auditFile.close();
    throw error;
  }
}
