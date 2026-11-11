/**
 * The pass of the runner over its routines (ADR 0033, ADR 0034): for each
 * routine whether it is due, the lock of the routine, the try, the run up
 * to its write or its draft, the end of the trigger, the audit line, the
 * notice and the release of the lock. `ecclium run-once` runs one pass,
 * the daemon runs one at each trigger; both go through here, so there is
 * one order of these steps.
 *
 * Where it stands in a run: around it. Loading and preparing the routines
 * comes before, in the composition root; reading, the model, the checks
 * and the write are the engine of `workflows`. This module only decides
 * what happens in which order and how the run ended. It has no network
 * and no files: every effect is a port the composition root builds.
 *
 * Why this order, step by step:
 *
 * 1. Due first, without the lock, so that a pass over routines that are
 *    not due touches no file of a lock.
 * 2. The lock of the routine, so that two processes never run it at once.
 *    A lock another process holds skips the routine and costs no try.
 * 3. Due again under the lock: the other process may have closed the
 *    trigger in between.
 * 4. A halt of writes or a configuration that only reads keeps the run
 *    from starting, before it counts a try: after a line of the audit that
 *    did not reach the file, the process writes nothing until a restart,
 *    and every read would fail on the same file (ADR 0029).
 * 5. The pipeline of the run with the token of its account. Without one,
 *    the run does not start and the trigger stays open.
 * 6. The try, counted before the run.
 * 7. A kill switch that hits the routine ends the run before its first
 *    read, so that a stopped routine sends no data to its model (decided
 *    on 10.11.2026), and closes the trigger as at the write.
 * 8. The run, with a deadline for reading and the model. A write that has
 *    begun is never aborted, and after the deadline none begins.
 * 9. The trigger closed after a final outcome, the audit line, the notice,
 *    and the lock released, also after a fault.
 *
 * A run by hand takes the last trigger, counts no try and closes the
 * trigger when its outcome is final. A preview takes the last trigger, no
 * lock, no try and no kill switch, writes nothing, closes nothing and
 * sends no notice.
 *
 * @packageDocumentation
 */
import type {
  AttemptStart,
  DueCheck,
  GuardedModel,
  Policy,
  Trigger,
} from '@ecclium/mcp-churchtools-core';
import type {
  AuditRunResult,
  AuditRunStep,
  Clock,
  Logger,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  executeRun,
  type PreparedRun,
  type RunRead,
  type RunWrite,
  writeRun,
} from '@ecclium/mcp-churchtools-workflows';

import {
  auditEndOf,
  type RunAuditEnd,
  type RunnerSeverity,
  type RunOutcome,
  severityOf,
  worseOf,
} from './outcome.js';

/** The longest audit duration, one day in milliseconds. */
const maxDurationMs = 86_400_000;

/** What the audit line of the end of a run holds besides how it ended. */
export interface RunEndLine extends RunAuditEnd {
  /** Which try of its trigger the run was; none by hand or for a preview. */
  readonly attempt?: number;
  /** The period of the run, such as `2026-W46`. */
  readonly period: string;
  /** How long the run took, in milliseconds. */
  readonly durationMs: number;
}

/**
 * A run the composition root opened: the ports of the engine, bound to the
 * actor of the routine, its account and its model, and the audit line of
 * its end, bound to the run.
 */
export interface OpenedRun {
  /** The ID of the run, which every audit and log line names. */
  readonly runId: string;
  /** Reads with the account of the routine. */
  readonly read: RunRead;
  /** Writes a section into the wiki with the same account. */
  readonly write: RunWrite;
  /** The model of the alias of the routine, behind its guard. */
  readonly model: GuardedModel;
  /** The logger of the run. */
  readonly log: Logger;
  /**
   * Writes the line of the end of the run into the audit.
   *
   * @returns Whether the audit file took it.
   */
  end(line: RunEndLine): boolean;
  /** Closes the transport of the run. It never rejects. */
  close(): Promise<void>;
}

/** The run opened, or why not, such as a token file the checks refuse. */
export type OpenRunResult =
  | { readonly ok: true; readonly run: OpenedRun }
  | { readonly ok: false; readonly code: string };

/** A draft of a run, to the file of its routine and period. */
export interface DraftCall {
  readonly routineId: string;
  /** The period of the run, such as `2026-W46`. */
  readonly period: string;
  /** The section, without the line of the marking. */
  readonly section: string;
}

/**
 * How the draft ended: written, refused by a kill switch (`policy_denied`,
 * final), or not written because its file failed (`internal`, a later try
 * may pass).
 */
export type DraftResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'policy_denied' | 'internal';
      readonly final: boolean;
    };

/** The notice of one run, without any content. */
export interface RunNotice {
  /** When the run ended, in UTC as ISO 8601. */
  readonly time: string;
  readonly routine: string;
  readonly period: string;
  /** The ID of the run. */
  readonly run: string;
  readonly result: AuditRunResult;
  readonly step?: AuditRunStep;
  /** The code of a failed run, of the core or of the engine. */
  readonly code?: string;
}

/** The lock of a routine, as the composition root takes it. */
export type RunnerLock =
  | {
      readonly kind: 'held';
      /** Releases the lock while it is still this one. Never throws. */
      release(): void;
    }
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed' };

/** The schedule of the routines, with the memory of runs (ADR 0034). */
export interface RunnerSchedule {
  /** Whether the routine is due. It never rejects for a failing store. */
  due(run: PreparedRun): Promise<DueCheck>;
  /** The last trigger of the routine, for a run by hand and a preview. */
  last(run: PreparedRun): Trigger;
  /** Counts a try of the trigger before the run begins. */
  start(run: PreparedRun, trigger: Trigger): Promise<AttemptStart>;
  /** Closes the trigger; false when the store did not count it. */
  close(run: PreparedRun, trigger: Trigger): Promise<boolean>;
}

/** What the composition root gives a pass. */
export interface RunnerPorts {
  readonly schedule: RunnerSchedule;
  /** The locks of the routines, one per process. */
  readonly locks: { acquire(routineId: string): RunnerLock };
  /** Whether the halt of writes of the process holds (ADR 0029). */
  writesHalted(): boolean;
  /** Whether the configuration only reads. */
  readonly readOnly: boolean;
  /**
   * The kill switches that hit the routine: `on` when none does; `off` or
   * `unknown`, when the folder cannot be checked, stop the run.
   */
  killSwitch(routineId: string): 'on' | 'off' | 'unknown';
  /** Opens a run: its pipeline, its account and its model. */
  open(run: PreparedRun): OpenRunResult;
  /** Writes the draft of a run with the output `draft`. */
  draft(call: DraftCall): DraftResult;
  /**
   * Sends the notice of a run to the channels of its routine.
   *
   * @returns Whether every channel took it.
   */
  notify(run: PreparedRun, notice: RunNotice): boolean;
  /** The checked policy. */
  readonly policy: Policy;
  /** The clock of the core. */
  readonly clock: Clock;
}

/** What a pass takes besides its ports. */
export interface PassOptions {
  /**
   * Stops the pass: it aborts reading and the model of the running run,
   * never a write, and no further run begins.
   */
  readonly signal: AbortSignal;
  /** The longest run, after which reading and the model are aborted. */
  readonly maxRunMs: number;
}

/**
 * What became of a routine in a pass: `ran`; `not_due`; `busy`, when
 * another process holds its lock; `halted`, when writes of the process are
 * halted; `read_only`, for a routine into the wiki while the configuration
 * only reads; `unavailable`, when the memory of runs did not answer;
 * `lock_failed`, when its lock could not be used; `not_opened`, when its
 * run could not be opened; `stopped`, when the pass was stopped before it;
 * `internal`, after a fault.
 */
export type RoutineStatus =
  | 'ran'
  | 'not_due'
  | 'busy'
  | 'halted'
  | 'read_only'
  | 'unavailable'
  | 'lock_failed'
  | 'not_opened'
  | 'stopped'
  | 'internal';

/** What became of a routine in a pass, without any content. */
export interface RoutineReport {
  readonly routineId: string;
  readonly status: RoutineStatus;
  /** How bad it is for the exit code. */
  readonly severity: RunnerSeverity;
  /** Why the run could not be opened, for `not_opened`. */
  readonly code?: string;
  /** How the run ended, for `ran`. */
  readonly outcome?: RunOutcome;
  readonly runId?: string;
  readonly period?: string;
  /** Which try of its trigger the run was; none by hand. */
  readonly attempt?: number;
  /** Whether the audit file took the line of the end of the run. */
  readonly recorded?: boolean;
  /**
   * Whether the store closed the trigger after a final outcome; absent
   * when the outcome was not final and nothing was closed.
   */
  readonly closed?: boolean;
  /** Whether every channel of the routine took the notice. */
  readonly notified?: boolean;
}

/** What became of every routine of a pass, and the worst of it. */
export interface PassReport {
  readonly routines: readonly RoutineReport[];
  readonly severity: RunnerSeverity;
}

/** What became of a preview, with the section when it rendered. */
export interface PreviewReport {
  readonly routineId: string;
  readonly status: 'ran' | 'not_opened' | 'internal';
  readonly severity: RunnerSeverity;
  readonly code?: string;
  readonly outcome?: RunOutcome;
  readonly runId?: string;
  readonly period?: string;
  readonly recorded?: boolean;
  /** The section as a run would write it, without the line of the marking. */
  readonly section?: string;
}

const failed = (
  step: AuditRunStep | undefined,
  code: string,
  final: boolean,
  more: Partial<RunOutcome> = {},
): RunOutcome =>
  Object.freeze({
    result: 'failed',
    ...(step === undefined ? {} : { step }),
    code,
    final,
    ...more,
  });

const report = (
  routineId: string,
  status: RoutineStatus,
  severity: RunnerSeverity,
  more: Partial<RoutineReport> = {},
): RoutineReport => Object.freeze({ routineId, status, severity, ...more });

const periodOf = (run: PreparedRun, trigger: Trigger): string =>
  trigger.period[run.loaded.routine.output.period];

const durationSince = (clock: Clock, start: number): number =>
  Math.min(Math.max(Math.round(clock.now() - start), 0), maxDurationMs);

// A signal that never aborts: a write that has begun always ends.
const unstoppable = (): AbortSignal => new AbortController().signal;

// One of the steps after a run, which must not keep the others from
// happening: a run that wrote still gets its audit line and its notice
// when closing the trigger fails. A port that throws counts as one that
// said no; the value is never looked at.
const afterwards = async (
  step: () => boolean | Promise<boolean>,
): Promise<boolean> => {
  try {
    return await step();
  } catch {
    return false;
  }
};

// The run itself, from the kill switch to the write or the draft. It never
// throws: a fault becomes a final internal failure, so that a defect does
// not try the same trigger three times.
const perform = async (
  run: PreparedRun,
  trigger: Trigger,
  opened: OpenedRun,
  ports: RunnerPorts,
  options: PassOptions,
): Promise<{ readonly outcome: RunOutcome; readonly section?: string }> => {
  const { routine } = run.loaded;
  try {
    // A kill switch stops the run before its first read (decided on
    // 10.11.2026): a stopped routine reads nothing and asks no model.
    if (ports.killSwitch(routine.id) !== 'on') {
      return { outcome: failed('write', 'policy_denied', true) };
    }
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(options.maxRunMs),
    ]);
    const rendered = await executeRun(
      run,
      trigger,
      {
        read: opened.read,
        model: opened.model,
        policy: ports.policy,
        log: opened.log,
        clock: ports.clock,
      },
      signal,
    );
    if (rendered.kind === 'failed') {
      return {
        outcome: failed(rendered.step, rendered.code, rendered.final, {
          ...(rendered.violations === undefined
            ? {}
            : { violations: rendered.violations }),
        }),
      };
    }
    // Past its longest time or stopped: no write begins, and a later try
    // may run it (ADR 0034).
    if (signal.aborted) {
      return { outcome: failed('write', 'network', false) };
    }
    if (routine.output.target === 'wiki') {
      const written = await writeRun(
        rendered,
        {
          write: opened.write,
          log: opened.log,
          clock: ports.clock,
          // A second write after a conflict is a new one: it begins only
          // before the deadline and the stop (ADR 0034).
          mayRetry: () => !signal.aborted,
        },
        unstoppable(),
      );
      switch (written.kind) {
        case 'written':
          return { outcome: Object.freeze({ result: 'written', final: true }) };
        case 'skipped':
          return {
            outcome: Object.freeze({ result: 'unchanged', final: true }),
          };
        case 'queued':
          return { outcome: Object.freeze({ result: 'queued', final: true }) };
        case 'failed':
          return {
            outcome: failed('write', written.code, written.final),
          };
      }
    }
    const drafted = ports.draft({
      routineId: routine.id,
      period: rendered.period,
      section: rendered.section,
    });
    return {
      outcome: drafted.ok
        ? Object.freeze({ result: 'drafted', final: true })
        : failed(
            'write',
            drafted.code,
            drafted.final,
            drafted.code === 'internal' ? { file: true } : {},
          ),
    };
  } catch {
    // The value is never looked at: it could hold data of the run.
    return { outcome: failed(undefined, 'internal', true) };
  }
};

// One routine, due or by hand.
const runRoutine = async (
  run: PreparedRun,
  byHand: boolean,
  ports: RunnerPorts,
  options: PassOptions,
): Promise<RoutineReport> => {
  const routineId = run.loaded.routine.id;
  if (options.signal.aborted) return report(routineId, 'stopped', 'ok');
  try {
    if (!byHand) {
      const check = await ports.schedule.due(run);
      if (check.status === 'unavailable') {
        return report(routineId, 'unavailable', 'temporary');
      }
      if (check.status !== 'due') return report(routineId, 'not_due', 'ok');
    }
    const lock = ports.locks.acquire(routineId);
    if (lock.kind === 'busy') {
      // Not a fault of a pass; but a run by hand did not happen.
      return report(routineId, 'busy', byHand ? 'temporary' : 'ok');
    }
    // A folder of locks that cannot be used is a fault of the setup, as
    // for the other folders of state (ADR 0033).
    if (lock.kind === 'failed') {
      return report(routineId, 'lock_failed', 'config');
    }
    try {
      let trigger: Trigger;
      if (byHand) {
        trigger = ports.schedule.last(run);
      } else {
        // Another process may have closed the trigger since the first
        // look.
        const again = await ports.schedule.due(run);
        if (again.status === 'unavailable') {
          return report(routineId, 'unavailable', 'temporary');
        }
        if (again.status !== 'due') {
          return report(routineId, 'not_due', 'ok');
        }
        trigger = again.trigger;
      }
      const period = periodOf(run, trigger);
      // Checked before a try counts (ADR 0029).
      if (ports.writesHalted()) {
        return report(routineId, 'halted', 'temporary', { period });
      }
      if (run.loaded.routine.output.target === 'wiki' && ports.readOnly) {
        return report(routineId, 'read_only', 'config', { period });
      }
      const opened = ports.open(run);
      if (!opened.ok) {
        return report(routineId, 'not_opened', 'config', {
          code: opened.code,
          period,
        });
      }
      try {
        let attempt: number | undefined;
        if (!byHand) {
          const start = await ports.schedule.start(run, trigger);
          if (!start.ok) {
            return start.reason === 'unavailable'
              ? report(routineId, 'unavailable', 'temporary', { period })
              : report(routineId, 'not_due', 'ok', { period });
          }
          attempt = start.attempt;
        }
        const began = ports.clock.now();
        const { outcome } = await perform(
          run,
          trigger,
          opened.run,
          ports,
          options,
        );
        // A final outcome ends the trigger, also by hand (ADR 0034).
        const closed = outcome.final
          ? await afterwards(() => ports.schedule.close(run, trigger))
          : undefined;
        const recorded = await afterwards(() =>
          opened.run.end({
            ...auditEndOf(outcome),
            ...(attempt === undefined ? {} : { attempt }),
            period,
            durationMs: durationSince(ports.clock, began),
          }),
        );
        const notified = await afterwards(() =>
          ports.notify(
            run,
            Object.freeze({
              time: new Date(ports.clock.now()).toISOString(),
              routine: routineId,
              period,
              run: opened.run.runId,
              result: outcome.result,
              ...(outcome.step === undefined ? {} : { step: outcome.step }),
              ...(outcome.code === undefined ? {} : { code: outcome.code }),
            }),
          ),
        );
        let severity = severityOf(outcome);
        if (!notified) severity = worseOf(severity, 'file');
        if (!recorded || closed === false) {
          severity = worseOf(severity, 'temporary');
        }
        return report(routineId, 'ran', severity, {
          outcome,
          runId: opened.run.runId,
          period,
          ...(attempt === undefined ? {} : { attempt }),
          recorded,
          ...(closed === undefined ? {} : { closed }),
          notified,
        });
      } finally {
        await opened.run.close();
      }
    } finally {
      lock.release();
    }
  } catch {
    // A port that threw: the value is never looked at, the lock is free,
    // and the pass goes on with the next routine.
    return report(routineId, 'internal', 'internal');
  }
};

/**
 * Runs every routine that is due, one after the other in the order of
 * their IDs, never two at once, so that no two runs ask ChurchTools at the
 * same time: each run has a pipeline and a throttle of its own.
 *
 * @param routines - The routines that passed their preparation.
 * @param ports - What the composition root built for the pass.
 * @param options - The signal that stops the pass and the longest run.
 * @returns What became of each routine and the worst of it, frozen. It
 *   never rejects.
 * @example
 * ```ts
 * const pass = await runDue(prepared, ports, { signal, maxRunMs });
 * return exitCodeOf(pass.severity);
 * ```
 */
export async function runDue(
  routines: readonly PreparedRun[],
  ports: RunnerPorts,
  options: PassOptions,
): Promise<PassReport> {
  const ordered = [...routines].sort((left, right) =>
    left.loaded.routine.id < right.loaded.routine.id ? -1 : 1,
  );
  const reports: RoutineReport[] = [];
  let severity: RunnerSeverity = 'ok';
  for (const run of ordered) {
    const done = await runRoutine(run, false, ports, options);
    reports.push(done);
    severity = worseOf(severity, done.severity);
  }
  return Object.freeze({ routines: Object.freeze(reports), severity });
}

/**
 * Runs one routine by hand, with the period of its last trigger, also when
 * it is not due. It counts no try, and a final outcome closes the trigger
 * as for a due run (ADR 0034).
 *
 * @param run - The routine, which passed its preparation.
 * @param ports - What the composition root built for the pass.
 * @param options - The signal that stops the run and the longest run.
 * @returns What became of the routine, frozen. It never rejects.
 * @example
 * ```ts
 * const done = await runByHand(prepared, ports, { signal, maxRunMs });
 * ```
 */
export async function runByHand(
  run: PreparedRun,
  ports: RunnerPorts,
  options: PassOptions,
): Promise<RoutineReport> {
  return runRoutine(run, true, ports, options);
}

/**
 * Runs one routine as a preview: it reads and asks the model like a run,
 * with the period of its last trigger, but takes no lock, counts no try,
 * looks at no kill switch, writes nothing, closes nothing and sends no
 * notice (ADR 0033). Its audit line says `preview` when the section
 * rendered, else how it failed.
 *
 * @param run - The routine, prepared for a preview.
 * @param ports - The schedule, the opening of a run, the policy and the
 *   clock.
 * @param options - The signal that stops the preview and the longest run.
 * @returns What became of the preview, with the section when it rendered,
 *   frozen. It never rejects.
 * @example
 * ```ts
 * const shown = await previewRoutine(prepared, ports, { signal, maxRunMs });
 * if (shown.section !== undefined) output.stdout(shown.section);
 * ```
 */
export async function previewRoutine(
  run: PreparedRun,
  ports: Pick<RunnerPorts, 'schedule' | 'open' | 'policy' | 'clock'>,
  options: PassOptions,
): Promise<PreviewReport> {
  const routineId = run.loaded.routine.id;
  try {
    const trigger = ports.schedule.last(run);
    const period = periodOf(run, trigger);
    const opened = ports.open(run);
    if (!opened.ok) {
      return Object.freeze({
        routineId,
        status: 'not_opened',
        severity: 'config',
        code: opened.code,
        period,
      });
    }
    try {
      const began = ports.clock.now();
      let outcome: RunOutcome;
      let section: string | undefined;
      try {
        const rendered = await executeRun(
          run,
          trigger,
          {
            read: opened.run.read,
            model: opened.run.model,
            policy: ports.policy,
            log: opened.run.log,
            clock: ports.clock,
          },
          AbortSignal.any([
            options.signal,
            AbortSignal.timeout(options.maxRunMs),
          ]),
        );
        if (rendered.kind === 'rendered') {
          outcome = Object.freeze({ result: 'preview', final: true });
          section = rendered.section;
        } else {
          outcome = failed(rendered.step, rendered.code, rendered.final, {
            ...(rendered.violations === undefined
              ? {}
              : { violations: rendered.violations }),
          });
        }
      } catch {
        outcome = failed(undefined, 'internal', true);
      }
      const recorded = opened.run.end({
        ...auditEndOf(outcome),
        period,
        durationMs: durationSince(ports.clock, began),
      });
      const severity = recorded
        ? severityOf(outcome)
        : worseOf(severityOf(outcome), 'temporary');
      return Object.freeze({
        routineId,
        status: 'ran',
        severity,
        outcome,
        runId: opened.run.runId,
        period,
        recorded,
        ...(section === undefined ? {} : { section }),
      });
    } finally {
      await opened.run.close();
    }
  } catch {
    return Object.freeze({
      routineId,
      status: 'internal',
      severity: 'internal',
    });
  }
}
