/**
 * `ecclium runner` (ADR 0033, ADR 0034): the daemon of the runner. It
 * starts once, then runs one pass over the routines that are due at each
 * trigger, through the same pass as `ecclium run-once --due`, so that both
 * have one order of steps and one reckoning of the schedule.
 *
 * When it looks: at its start, then at the earliest time any routine is
 * worth asking again, as `checkDue` names it, the next trigger or the
 * time of the next try, and at least every 15 minutes, so that a clock
 * that jumped or a timer that came late loses nothing. At each look it
 * starts the audit file of a new UTC day and deletes what is past its
 * retention (ADR 0028, ADR 0031).
 *
 * How it ends: after SIGTERM or SIGINT with 143 or 130, never cutting a
 * write; after a line of the audit that did not reach the file, which
 * halts every write of the process, with 75 at the end of that pass, so
 * that a restart lifts the halt (decided on 10.11.2026); with 70 after a
 * fault nothing caught. It does not start, with 78, when no routine
 * starts. Changes to routines, the policy and the providers take effect
 * with a restart; tokens and the keys of the models are read anew.
 *
 * @packageDocumentation
 */
import type { RoutineReport } from '@ecclium/mcp-churchtools-runner';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import { processRunnerHost, type SignalWatch, watchSignals } from './host.js';
import { openRunnerProcess } from './process.js';
import { reportStart, type RunOnceOptions } from './run-once.js';
import { startRunner } from './start.js';
import {
  daemonStartText,
  passSummaryText,
  refusedText,
  routineReportText,
  runnerProcessTexts,
} from './texts.js';

/** What `ecclium runner` needs, with replacements for tests. */
export interface RunnerDaemonOptions extends Omit<RunOnceOptions, 'mode'> {
  /** Only for tests: opens the process, such as one that halts writes. */
  readonly openProcess?: typeof openRunnerProcess;
}

/** The longest wait between two looks, 15 minutes. */
export const maxWaitMs = 15 * 60_000;

/** The shortest wait between two looks, so that no pass follows at once. */
export const minWaitMs = 1_000;

/**
 * How long the daemon waits before its next look.
 *
 * @param now - The time of the clock, in milliseconds.
 * @param next - When the runner looks at each routine again.
 * @returns The wait in milliseconds, from {@link minWaitMs} to
 *   {@link maxWaitMs}.
 * @example
 * ```ts
 * waitBefore(now, new Map([['weekly', now + 60_000]])); // 60_000
 * ```
 */
export function waitBefore(
  now: number,
  next: ReadonlyMap<string, number>,
): number {
  let wait = maxWaitMs;
  for (const time of next.values()) {
    if (Number.isFinite(time)) wait = Math.min(wait, time - now);
  }
  return Number.isFinite(wait)
    ? Math.min(Math.max(Math.round(wait), minWaitMs), maxWaitMs)
    : maxWaitMs;
}

// A line per routine that did something or could not, as `run-once`
// writes them, and the line of the pass when anything happened, so that a
// pass every 15 minutes over routines that are not due stays quiet.
const report = (
  options: RunnerDaemonOptions,
  routines: readonly RoutineReport[],
  refused: number,
): void => {
  const { output } = options;
  let said = false;
  for (const item of routines) {
    const text = routineReportText(item);
    if (text === undefined) continue;
    output.stderr(text);
    said = true;
  }
  if (said || refused > 0) {
    output.stderr(
      passSummaryText({
        ran: routines.filter((item) => item.status === 'ran').length,
        skipped: routines.filter(
          (item) => item.status !== 'ran' && item.status !== 'not_due',
        ).length,
        refused,
      }),
    );
  }
};

/**
 * Runs `ecclium runner` until a signal, a halt of writes or a fault ends
 * it.
 *
 * @param options - Environment, output, and replacements for tests.
 * @returns The exit code: 143 or 130 after a signal, 75 after a halt of
 *   writes, 78 or 64 when it does not start.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * process.exitCode = await runDaemon({ environment, execArgv, output });
 * ```
 */
export async function runDaemon(
  options: RunnerDaemonOptions,
): Promise<ExitCode> {
  const { output } = options;
  const host = options.host ?? processRunnerHost();
  const started = startRunner({
    environment: options.environment,
    execArgv: options.execArgv,
    mode: { kind: 'due' },
    ...(options.load === undefined ? {} : { load: options.load }),
    ...(options.routineFiles === undefined
      ? {}
      : { routineFiles: options.routineFiles }),
    ...(options.createCatalog === undefined
      ? {}
      : { createCatalog: options.createCatalog }),
  });
  if (!started.ok) return reportStart(output, started.problem);
  const { routines, refused } = started;
  for (const item of refused) output.stderr(refusedText(item));
  // A daemon without work would be a silent fault of the configuration.
  if (routines.length === 0) {
    output.stderr(runnerProcessTexts.no_routine);
    return exitCodes.invalidConfig;
  }

  const opened = (options.openProcess ?? openRunnerProcess)({
    started,
    mode: { kind: 'due' },
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
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  if (!opened.ok) return opened.code;
  const runner = opened.process;
  let watch: SignalWatch;
  try {
    watch = watchSignals(host, runner.logger, () =>
      output.stderr(runnerProcessTexts.signal),
    );
  } catch (error) {
    // The audit file closes also when the signals cannot be watched.
    runner.close();
    throw error;
  }
  try {
    output.stderr(
      daemonStartText({ routines: routines.length, refused: refused.length }),
    );
    runner.sweep();
    // A function, since a signal can come during any await below.
    const stopped = (): boolean => watch.signal.aborted;
    let first = true;
    while (!stopped()) {
      if (!first) {
        // A new UTC day starts its audit file and deletes what is past
        // its retention, also after a sleep of the computer.
        runner.tick();
        // The routines that do not start, at every pass (decided on
        // 10.11.2026), so that none is missing silently.
        for (const item of refused) output.stderr(refusedText(item));
      }
      first = false;
      const pass = await runner.pass(watch);
      report(options, pass.routines, refused.length);
      const after = await runner.after(pass.routines, true);
      if (after.metrics === false) {
        output.stderr(runnerProcessTexts.metrics_failed);
      }
      if (stopped()) break;
      // After a line of the audit that did not reach the file the process
      // writes nothing until a restart (ADR 0029).
      if (runner.writesHalted()) {
        output.stderr(runnerProcessTexts.halted);
        return exitCodes.tempFail;
      }
      await host.wait(waitBefore(runner.clock.now(), after.next), watch.signal);
    }
    return watch.code() ?? exitCodes.internal;
  } finally {
    watch.dispose();
    runner.close();
  }
}
