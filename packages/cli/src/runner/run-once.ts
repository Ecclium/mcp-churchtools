/**
 * `ecclium run-once` (ADR 0033, ADR 0034): one pass of the runner over the
 * routines that are due (`--due`), one routine by hand (`<Routine>`), or
 * a preview of one routine (`<Routine> --preview`), then the end of the
 * process. A container that cron starts every 15 minutes calls it with
 * `--due`; the daemon, later, runs the same pass at each trigger.
 *
 * Where it stands: the composition root of a call. It starts the runner,
 * makes the folders a pass needs, builds the models of the routines it
 * runs, the ports of the pass and the pass itself, reports each routine on
 * stderr, a preview on stdout and a notice where the routine says, and
 * ends with one exit code after sysexits: 0 when every run did its work or
 * nothing was due, 75 when a later call may pass, 74 when a file of the
 * runner failed, 65 when a run ended for good on its data or its answer,
 * 77 for a kill switch, the policy, a right or a refused token, 78 for the
 * configuration or a routine that does not start, 70 for an internal
 * error. Of several, the worst counts (ADR 0033).
 *
 * @packageDocumentation
 */
import {
  type ConfigResult,
  type ConfigSources,
  type GuardedModel,
  type PrivateFileCode,
  type ProviderSettings,
} from '@ecclium/mcp-churchtools-core';
import {
  anchorEventOf,
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
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';
import {
  type PassReport,
  previewRoutine,
  runByHand,
  type RunnerSeverity,
  runDue,
  worseOf,
} from '@ecclium/mcp-churchtools-runner';
import type { RoutineFileSystem } from '@ecclium/mcp-churchtools-workflows';

import { composeModelProviders } from '../compose/model.js';
import { privateFileCodeOf } from '../compose/private-file-code.js';
import { keepsQueue } from '../compose/queue.js';
import { keepsSnapshots } from '../compose/snapshots.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  auditFileMessage,
  dayKeyFolderMessage,
  type Message,
  problemText,
  queueFolderMessage,
  quotaFolderMessage,
  snapshotFolderMessage,
} from '../messages/index.js';
import { type Output, terminalLines } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import { composeRunnerPorts, hostName } from './ports.js';
import {
  type RunnerMode,
  type RunnerStartOptions,
  type RunnerStartProblem,
  startRunner,
} from './start.js';
import {
  modelKeyText,
  passSummaryText,
  previewReportText,
  providerText,
  refusedText,
  routineReportText,
  routinesProblemText,
  runnerStartTexts,
} from './texts.js';

/** What `ecclium run-once` needs, with replacements for tests. */
export interface RunOnceOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  readonly mode: RunnerMode;
  readonly output: Output;
  /** Replaces the loader of the configuration. */
  readonly load?: (sources: ConfigSources) => ConfigResult;
  /** Replaces the file functions of the loader of the routines. */
  readonly routineFiles?: RoutineFileSystem;
  /** Replaces the catalog, such as with the read tools of a test plugin. */
  readonly createCatalog?: RunnerStartOptions['createCatalog'];
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
  /** Replaces the clock. */
  readonly clock?: Clock;
  /** Stops the call; the daemon and the signals come later. */
  readonly signal?: AbortSignal;
}

// The ID of a routine, as its schema takes it.
const routinePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The exit code of a severity of the runner.
const exitCodeOf = (severity: RunnerSeverity): ExitCode => {
  switch (severity) {
    case 'ok':
      return exitCodes.ok;
    case 'temporary':
      return exitCodes.tempFail;
    case 'file':
      return exitCodes.ioError;
    case 'data':
      return exitCodes.dataError;
    case 'refused':
      return exitCodes.noPermission;
    case 'config':
      return exitCodes.invalidConfig;
    case 'internal':
      return exitCodes.internal;
  }
};

// A text of the start about a folder it could not use, said of the runner.
const runnerText = (message: Message): string =>
  `${message.what.replace(', und der Start bricht ab.', ', und der Runner startet nicht.')} ${message.why} ${message.action}`;

// The problem that keeps the runner from starting, on stderr.
const reportStart = (output: Output, problem: RunnerStartProblem): ExitCode => {
  switch (problem.kind) {
    case 'config':
      for (const item of problem.problems) output.stderr(problemText(item));
      return exitCodes.invalidConfig;
    case 'routines':
      output.stderr(routinesProblemText(problem.problem));
      return exitCodes.invalidConfig;
    case 'credential_mixed':
      output.stderr(runnerStartTexts.credential_mixed(problem.routineId));
      return exitCodes.invalidConfig;
    case 'read_only_wiki':
      output.stderr(runnerStartTexts.read_only_wiki(problem.routineId));
      return exitCodes.invalidConfig;
    case 'routine_unknown':
      output.stderr(runnerStartTexts.routine_unknown);
      return exitCodes.usage;
  }
};

/**
 * Runs `ecclium run-once`.
 *
 * @param options - Environment, what the call does, output, and
 *   replacements for tests.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * const code = await runOnce({ environment, execArgv, mode: { kind: 'due' }, output });
 * ```
 */
export async function runOnce(options: RunOnceOptions): Promise<ExitCode> {
  const { output, mode } = options;
  // The ID first, before any file is read; it is never repeated in a text.
  if (mode.kind !== 'due' && !routinePattern.test(mode.routineId)) {
    output.stderr(runnerStartTexts.routine_invalid);
    return exitCodes.usage;
  }
  const started = startRunner({
    environment: options.environment,
    execArgv: options.execArgv,
    mode,
    ...(options.load === undefined ? {} : { load: options.load }),
    ...(options.routineFiles === undefined
      ? {}
      : { routineFiles: options.routineFiles }),
    ...(options.createCatalog === undefined
      ? {}
      : { createCatalog: options.createCatalog }),
  });
  if (!started.ok) return reportStart(output, started.problem);
  const { config, catalog, routines, refused, target } = started;

  // Each routine that does not start, by name. For a call by hand or a
  // preview only the one routine decides the exit code.
  for (const item of refused) output.stderr(refusedText(item));
  let severity: RunnerSeverity =
    mode.kind === 'due' && refused.length > 0 ? 'config' : 'ok';
  if (mode.kind !== 'due' && target === undefined) {
    return exitCodes.invalidConfig;
  }
  const running =
    mode.kind === 'due' ? routines : target === undefined ? [] : [target];

  // The loader of the runner requires the folder of state.
  const { stateDir } = config;
  if (stateDir === undefined) return exitCodes.invalidConfig;
  const prepared = prepareQuotaFolder(stateDir);
  if (!prepared.ok) {
    output.stderr(runnerText(quotaFolderMessage(prepared.code)));
    return exitCodes.invalidConfig;
  }
  // The folder of the drafts, made private when a run may write one.
  if (
    mode.kind !== 'preview' &&
    config.draftsDir !== undefined &&
    running.some((run) => run.loaded.routine.output.target === 'draft')
  ) {
    try {
      preparePrivateFolder(config.draftsDir);
    } catch (error) {
      const code = privateFileCodeOf(error);
      if (code === undefined) throw error;
      output.stderr(
        `Der Ordner aus ‹ECCLIUM_DRAFTS_DIR› lässt sich nicht als privater Ordner verwenden, Code ‹${code}›, und der Runner startet nicht. Ein Entwurf enthält Namen von Personen; nur der Benutzer des Runners darf den Ordner lesen. Legen Sie ihn mit den Rechten 700 an, als der Benutzer, unter dem der Runner läuft.`,
      );
      return exitCodes.invalidConfig;
    }
  }
  // The folders a write into the wiki needs, as the start over stdio and
  // `ecclium queue approve` prepare them: the day keys and the records of
  // the snapshots, and the queue of approvals (ADR 0031). Without them the
  // snapshot of every write fails and the write ends as an internal error.
  // A preview writes nothing.
  if (
    mode.kind !== 'preview' &&
    running.some((run) => run.loaded.routine.output.target === 'wiki')
  ) {
    const steps: (readonly [() => void, (code: PrivateFileCode) => Message])[] =
      [];
    if (keepsSnapshots(config)) {
      const { keysDir } = config;
      steps.push(
        [
          () => {
            prepareDayKeyFolder(keysDir, 'snapshot');
          },
          dayKeyFolderMessage,
        ],
        [
          () => {
            prepareSnapshotFolder(stateDir);
          },
          snapshotFolderMessage,
        ],
      );
    }
    if (keepsQueue(config)) {
      steps.push([
        () => {
          prepareQueueFolder(stateDir);
        },
        queueFolderMessage,
      ]);
    }
    for (const [prepare, message] of steps) {
      try {
        prepare();
      } catch (error) {
        const code = privateFileCodeOf(error);
        if (code === undefined) throw error;
        output.stderr(runnerText(message(code)));
        return exitCodes.invalidConfig;
      }
    }
  }

  const clock = options.clock ?? systemClock;
  const opened = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!opened.ok) {
    output.stderr(runnerText(auditFileMessage(opened.code)));
    return exitCodes.invalidConfig;
  }
  const auditFile = opened.writer;
  // Everything after the open of the audit file closes it again, also
  // after a fault.
  let processLogger: ReturnType<typeof createLogger> | undefined;
  try {
    const writer = createStderrWriter(
      options.writeSync === undefined ? {} : { writeSync: options.writeSync },
    );
    // The anchor of the chain goes to the log when the file closes, as with
    // the server and `ecclium queue` (ADR 0028).
    const anchorLogger = createLogger({
      writer,
      clock,
      minLevel: 'info',
      anchors: true,
    });
    auditFile.attach({
      anchor: (anchor) => {
        const { file: name, seq, hash } = anchor;
        anchorLogger.info(anchorEventOf(anchor), { file: name, seq, hash });
      },
      swept: () => undefined,
    });
    processLogger = createLogger({ writer, clock, minLevel: 'info' });

    // Only the providers of the routines this call runs; the key of each is
    // read for this call, so a new key takes effect without a restart.
    const aliases = new Set(running.map((run) => run.model));
    const providers: ProviderSettings[] = (config.providers ?? []).filter(
      (provider) => aliases.has(provider.alias),
    );
    // One provider at a time: a key file that cannot be used stops only the
    // routines of its model, as a token file stops only its routine.
    const models = new Map<string, GuardedModel>();
    const refusedModels = new Map<string, string>();
    const closers: (() => Promise<void>)[] = [];
    const modelLogger = createDefaultTenantLogger({
      writer,
      clock,
      minLevel: config.logLevel,
    });
    for (const provider of providers) {
      output.stderr(providerText(provider));
      const built = composeModelProviders({
        providers: [provider],
        logger: modelLogger,
        clock,
        ...(options.readModelKey === undefined
          ? {}
          : { readKey: options.readModelKey }),
        ...(options.createModelTransport === undefined
          ? {}
          : { createTransport: options.createModelTransport }),
      });
      if (built.ok) {
        for (const [alias, model] of built.models) models.set(alias, model);
        closers.push(() => built.close());
      } else {
        refusedModels.set(built.alias, built.code);
        output.stderr(modelKeyText(built.alias, built.code));
      }
    }
    try {
      const ports = composeRunnerPorts({
        config,
        catalog,
        routines,
        models,
        refusedModels,
        writer,
        clock,
        auditFile,
        store: createFileQuotaStore({
          stateDir,
          clock,
          pid: process.pid,
          host: hostName(),
        }),
        locks: createRoutineLocks({
          stateDir,
          clock,
          pid: process.pid,
          host: hostName(),
        }),
        writeHalt: createWriteHalt(),
        output,
        pid: process.pid,
        ...(options.createTransport === undefined
          ? {}
          : { createTransport: options.createTransport }),
      });
      const passOptions = {
        signal: options.signal ?? new AbortController().signal,
        maxRunMs: routineLockLimits.maxRunMs,
      };
      if (mode.kind === 'preview') {
        // The start keeps a preview without its routine from here.
        if (target === undefined) return exitCodes.invalidConfig;
        const shown = await previewRoutine(target, ports, passOptions);
        if (shown.section !== undefined) {
          // Line by line: the terminal output makes one line safe and would
          // show each line break of the section as an escape.
          for (const raw of shown.section.trimEnd().split('\n')) {
            for (const line of terminalLines('', raw)) output.stdout(line);
          }
        }
        output.stderr(previewReportText(shown));
        return exitCodeOf(shown.severity);
      }
      let pass: PassReport;
      if (mode.kind === 'manual') {
        if (target === undefined) return exitCodes.invalidConfig;
        const done = await runByHand(target, ports, passOptions);
        pass = { routines: [done], severity: done.severity };
      } else {
        pass = await runDue(routines, ports, passOptions);
      }
      for (const item of pass.routines) {
        const text = routineReportText(item);
        if (text !== undefined) output.stderr(text);
      }
      output.stderr(
        passSummaryText({
          ran: pass.routines.filter((item) => item.status === 'ran').length,
          skipped: pass.routines.filter(
            (item) => item.status !== 'ran' && item.status !== 'not_due',
          ).length,
          refused: refused.length,
        }),
      );
      severity = worseOf(severity, pass.severity);
      return exitCodeOf(severity);
    } finally {
      await Promise.all(closers.map((close) => close().catch(() => undefined)));
    }
  } finally {
    processLogger?.info('audit_file_closed', {
      count: Math.min(auditFile.counts().failed, 1_000_000),
    });
    auditFile.close();
  }
}
