/**
 * Which ping a pass of the runner sends to a monitoring service in the
 * format of Healthchecks (ADR 0009): none, a success or a failure. Only
 * what became of each routine decides, never the content of a run.
 *
 * Where it stands: after a pass, beside the metrics file. This module only
 * decides; the composition root sends the ping.
 *
 * The rule: a pass in which no routine was due sends nothing, so that the
 * daemon, which looks at least every 15 minutes, pings only when it ran
 * something. A failure is a run that failed for good, a run that failed
 * for a passing reason at a second or later try or by hand, a due routine
 * that could not begin its run, a run whose notice, line of the audit or
 * close of its trigger failed, a halt of writes in the process, or a
 * routine of the runner that does not start. The first try of a trigger
 * that failed for a passing reason sends nothing: the next try decides,
 * so that a short disturbance does not set off the monitoring. Why the
 * second try and not the last: the third try of an hourly routine would
 * fall on its next trigger and never comes, so a lasting disturbance would
 * never reach `/fail`.
 *
 * @packageDocumentation
 */
import type { RoutineReport } from './pass.js';

/** Whether a ping reports a pass that went well or one that failed. */
export type PingVerdict = 'success' | 'fail';

/** What decides the ping besides the reports. */
export interface PingContext {
  /**
   * How many routines of the runner do not start; for a run by hand,
   * where only the one routine counts, 0.
   */
  readonly refused: number;
  /**
   * Whether writes of the process are halted after a line of the audit
   * that did not reach its file (ADR 0029). The daemon then ends.
   */
  readonly halted: boolean;
}

// What one routine says about the pass: nothing, a success, a failure, or
// a failure that a later try may still turn.
type RoutineVerdict = 'none' | 'success' | 'fail' | 'open';

const verdictOf = (report: RoutineReport): RoutineVerdict => {
  switch (report.status) {
    // Nothing was due, the pass stopped at a signal before the routine, or
    // another process holds it and reports itself.
    case 'not_due':
    case 'stopped':
    case 'busy':
      return 'none';
    // The memory of runs did not answer; the next look asks again.
    case 'unavailable':
      return 'open';
    // A due routine that could not begin its run: writes halted after a
    // line of the audit that did not reach its file, a configuration that
    // only reads, a folder of locks that cannot be used, a run that could
    // not be opened, or a fault.
    case 'halted':
    case 'read_only':
    case 'lock_failed':
    case 'not_opened':
    case 'internal':
      return 'fail';
    case 'ran': {
      if (report.severity === 'ok') return 'success';
      // Only the first try of a trigger may still turn; a run by hand has
      // no try and so no further one.
      const firstTry =
        report.outcome?.result === 'failed' &&
        !report.outcome.final &&
        report.attempt === 1;
      return firstTry ? 'open' : 'fail';
    }
  }
};

/**
 * Decides the ping of a pass.
 *
 * @param reports - What became of each routine of the pass.
 * @param context - The routines that do not start and the halt of writes.
 * @returns `fail`, `success`, or undefined when the pass sends no ping.
 * @example
 * ```ts
 * pingOf(pass.routines, { refused: refused.length, halted: false }); // 'success'
 * ```
 */
export function pingOf(
  reports: readonly RoutineReport[],
  context: PingContext,
): PingVerdict | undefined {
  // A halt of writes comes only from a run of this process and ends the
  // daemon, so it is reported whatever the routines say.
  if (context.halted) return 'fail';
  const verdicts = new Set(reports.map(verdictOf));
  verdicts.delete('none');
  if (verdicts.size === 0) return undefined;
  if (verdicts.has('fail') || context.refused > 0) return 'fail';
  return verdicts.has('open') ? undefined : 'success';
}
