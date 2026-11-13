/**
 * `ecclium run-once` (ADR 0033, ADR 0034): one pass of the runner over the
 * routines that are due (`--due`), one routine by hand (`<Routine>`), or
 * a preview of one routine (`<Routine> --preview`), then the end of the
 * process. A container that cron starts every 15 minutes calls it with
 * `--due`; the daemon `ecclium runner` runs the same pass at each trigger.
 *
 * Where it stands: the command around a process of the runner. It starts
 * the runner, opens the process, watches the signals, reports each routine
 * on stderr, a preview on stdout and a notice where the routine says,
 * writes the metrics file, and ends with one exit code after sysexits: 0
 * when every run did its work or nothing was due, 75 when a later call may
 * pass, 74 when a file of the runner failed, 65 when a run ended for good
 * on its data or its answer, 77 for a kill switch, the policy, a right or
 * a refused token, 78 for the configuration or a routine that does not
 * start, 70 for an internal error. Of several, the worst counts
 * (ADR 0033). After SIGTERM or SIGINT it ends with 143 or 130, before any
 * other code.
 *
 * @packageDocumentation
 */
import type {
  ConfigResult,
  ConfigSources,
} from '@ecclium/mcp-churchtools-core';
import {
  type HttpTransport,
  type HttpTransportOptions,
  probeEgressProxy,
  type ProxyProbe,
  type ProxyProbeOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';
import {
  type PassReport,
  type RunnerSeverity,
  worseOf,
} from '@ecclium/mcp-churchtools-runner';
import type { RoutineFileSystem } from '@ecclium/mcp-churchtools-workflows';

import type { composeModelProviders } from '../compose/model.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  egressProxyText,
  problemText,
  warningText,
} from '../messages/index.js';
import { type Output, terminalLines } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import {
  processRunnerHost,
  type RunnerHost,
  type SignalWatch,
  watchSignals,
} from './host.js';
import { openRunnerProcess, type RunnerProcessOptions } from './process.js';
import {
  type RunnerMode,
  type RunnerStart,
  type RunnerStartOptions,
  type RunnerStartProblem,
  startRunner,
} from './start.js';
import {
  passSummaryText,
  previewReportText,
  refusedText,
  routineReportText,
  routinesProblemText,
  runnerProcessTexts,
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
  /** Replaces the transport to the ping of the runner (ADR 0009). */
  readonly createPingTransport?: RunnerProcessOptions['createPingTransport'];
  /** Replaces the clock. */
  readonly clock?: Clock;
  /** Replaces the process for its signals, faults, end and waits. */
  readonly host?: RunnerHost;
  /** Replaces the check of the proxy at the start (ADR 0035). */
  readonly probeProxy?: (options: ProxyProbeOptions) => Promise<ProxyProbe>;
}

// The ID of a routine, as its schema takes it.
const routinePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The exit code of a severity of the runner, after sysexits.
 *
 * @param severity - How bad a pass or a run ended.
 * @returns The exit code.
 * @example
 * ```ts
 * exitCodeOf('temporary'); // 75
 * ```
 */
export const exitCodeOf = (severity: RunnerSeverity): ExitCode => {
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

/**
 * The problem that keeps the runner from starting, on stderr.
 *
 * @param output - Where the text goes.
 * @param problem - The problem.
 * @returns 78, or 64 for a routine by hand that is not in the folder.
 * @example
 * ```ts
 * if (!started.ok) return reportStart(output, started.problem);
 * ```
 */
export const reportStart = (
  output: Output,
  problem: RunnerStartProblem,
): ExitCode => {
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
 * The egress at every start of the runner (ADR 0035): the warnings about
 * a runner without its proxy and a proxy of the shell, then, with a
 * proxy, a tunnel to ChurchTools without a request, before the first run
 * reads anything.
 *
 * @param output - Where the texts go.
 * @param started - The started runner.
 * @param probe - Replaces the check of the proxy, for tests.
 * @returns Undefined when the runner may go on, else 69.
 * @example
 * ```ts
 * const stopped = await startEgress(output, started, undefined);
 * if (stopped !== undefined) return stopped;
 * ```
 */
export const startEgress = async (
  output: Output,
  started: Extract<RunnerStart, { readonly ok: true }>,
  probe: ((options: ProxyProbeOptions) => Promise<ProxyProbe>) | undefined,
): Promise<ExitCode | undefined> => {
  for (const code of started.warnings) output.stderr(warningText(code));
  const { egressProxy, churchtoolsOrigin } = started.config;
  if (egressProxy === undefined) return undefined;
  const checked = await (probe ?? probeEgressProxy)({
    proxy: egressProxy,
    origin: churchtoolsOrigin,
  });
  if (checked.ok) return undefined;
  output.stderr(egressProxyText(checked.reason));
  return exitCodes.unavailable;
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
  const stopped = await startEgress(output, started, options.probeProxy);
  if (stopped !== undefined) return stopped;
  const { refused, target } = started;

  // Each routine that does not start, by name. For a call by hand or a
  // preview only the one routine decides the exit code.
  for (const item of refused) output.stderr(refusedText(item));
  let severity: RunnerSeverity =
    mode.kind === 'due' && refused.length > 0 ? 'config' : 'ok';
  if (mode.kind !== 'due' && target === undefined) {
    return exitCodes.invalidConfig;
  }

  const opened = openRunnerProcess({
    started,
    mode,
    output,
    ...(options.writeSync === undefined
      ? {}
      : { writeSync: options.writeSync }),
    ...(options.createTransport === undefined
      ? {}
      : { createTransport: options.createTransport }),
    ...(options.createModelTransport === undefined
      ? {}
      : { createModelTransport: options.createModelTransport }),
    ...(options.readModelKey === undefined
      ? {}
      : { readModelKey: options.readModelKey }),
    ...(options.createPingTransport === undefined
      ? {}
      : { createPingTransport: options.createPingTransport }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  if (!opened.ok) return opened.code;
  const runner = opened.process;
  let watch: SignalWatch;
  try {
    watch = watchSignals(
      options.host ?? processRunnerHost(),
      runner.logger,
      () => output.stderr(runnerProcessTexts.signal),
    );
  } catch (error) {
    // The audit file closes also when the signals cannot be watched.
    runner.close();
    throw error;
  }
  try {
    runner.sweep();
    if (mode.kind === 'preview') {
      const shown = await runner.preview(watch);
      if (shown.section !== undefined) {
        // Line by line: the terminal output makes one line safe and would
        // show each line break of the section as an escape.
        for (const raw of shown.section.trimEnd().split('\n')) {
          for (const line of terminalLines('', raw)) output.stdout(line);
        }
      }
      output.stderr(previewReportText(shown));
      return watch.code() ?? exitCodeOf(shown.severity);
    }
    const pass: PassReport = await runner.pass(watch);
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
    // The metrics file carries the values of the routines this call did
    // not run; it mirrors only and decides about no run (ADR 0033).
    const after = await runner.after(pass.routines, false);
    if (after.metrics === false) {
      output.stderr(runnerProcessTexts.metrics_failed);
      severity = worseOf(severity, 'file');
    }
    // The ping to the monitoring, after the metrics file; it changes no
    // exit code (ADR 0009). For a run by hand only its routine counts.
    await runner.ping(
      pass.routines,
      mode.kind === 'due' ? refused.length : 0,
      watch.signal,
    );
    return watch.code() ?? exitCodeOf(severity);
  } finally {
    watch.dispose();
    runner.close();
  }
}
