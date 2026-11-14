/**
 * The ports of a pass of the runner (ADR 0033, ADR 0034): what the pass in
 * the package `runner` may do, bound here, in the composition root, to the
 * files, the store and the pipelines of the process.
 *
 * Why here: the pass has no network and no files. The memory of runs, the
 * locks of the routines, the halt of writes, the kill switches, the
 * pipeline of each run with the token of its account, the draft as a file
 * and the notice all touch the disk or ChurchTools, and only the
 * composition root may build them (ADR 0056). Each run gets its own
 * pipeline, so that a new token takes effect with the next run; the halt
 * of writes, the locks and the store are one per process.
 *
 * @packageDocumentation
 */
import { hostname } from 'node:os';

import {
  closeTrigger,
  checkDue,
  type DueOptions,
  draftMarkingLineOf,
  type EccliumConfig,
  type GuardedModel,
  lastTrigger,
  runAssignmentOf,
  startAttempt,
  type ToolCatalog,
  type Trigger,
} from '@ecclium/mcp-churchtools-core';
import {
  appendPrivateLine,
  type AuditFileWriter,
  checkRunKillSwitches,
  createTenantContext,
  replacePrivateFile,
  type RoutineLocks,
  type StderrLineWriter,
  type WriteHalt,
  writesHalted,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type {
  Clock,
  IsoDate,
  QuotaStore,
} from '@ecclium/mcp-churchtools-plugin-api';
import type {
  DraftResult,
  RunEndLine,
  RunNotice,
  RunnerPorts,
} from '@ecclium/mcp-churchtools-runner';
import type { PreparedRun } from '@ecclium/mcp-churchtools-workflows';

import { composeRun } from '../compose/run.js';
import { composeRunPipeline } from '../compose/run-pipeline.js';
import type { Output } from '../output/index.js';

/** The model of an alias, or why there is none for this pass. */
export type ModelOfAlias =
  | { readonly ok: true; readonly model: GuardedModel }
  | { readonly ok: false; readonly code: string };

/** What the ports of a pass are built from. */
export interface RunnerPortsOptions {
  /** The configuration of the runner, with its folder of state and zone. */
  readonly config: EccliumConfig;
  readonly catalog: ToolCatalog;
  /** Every routine that passed its preparation, for the tools of an account. */
  readonly routines: readonly PreparedRun[];
  /**
   * The guarded model of an alias for this pass, built when a run first
   * needs it, or the code of its refused key file or `run_model_unknown`;
   * a run with a refused model does not start.
   */
  readonly model: (alias: string) => ModelOfAlias;
  /**
   * Marks a write that has begun until its run closes, so that no signal
   * cuts it or the steps after it. Leave it out where no signal is
   * watched.
   */
  readonly writing?: () => () => void;
  readonly writer: StderrLineWriter;
  readonly clock: Clock;
  readonly auditFile: AuditFileWriter;
  /** The store of quotas, which holds the memory of runs. */
  readonly store: QuotaStore;
  /** The locks of the routines, one per process. */
  readonly locks: RoutineLocks;
  /** The halt of writes, one per process. */
  readonly writeHalt: WriteHalt;
  /** Where a notice to `stdout` goes. */
  readonly output: Output;
  /** The ID of the process, for the temporary name of a draft. */
  readonly pid: number;
  /** Only for tests: builds the transport to ChurchTools. */
  readonly createTransport?: (options: HttpTransportOptions) => HttpTransport;
}

// The UTC day of a time, as the marking names it.
const dayOf = (time: number): IsoDate =>
  new Date(time).toISOString().slice(0, 10) as IsoDate;

/**
 * Builds the ports of one pass.
 *
 * @param options - Configuration, catalog, routines, models, writer,
 *   clock, audit file, store, locks, halt, output and process.
 * @returns The ports, frozen.
 * @throws {TypeError} When the configuration has no folder of the kill
 *   switches or no zone, which the loader of the runner requires.
 * @example
 * ```ts
 * const ports = composeRunnerPorts({ config, catalog, routines, model, writer, clock, auditFile, store, locks, writeHalt, output, pid: process.pid });
 * const pass = await runDue(routines, ports, { signal, maxRunMs });
 * ```
 */
export function composeRunnerPorts(options: RunnerPortsOptions): RunnerPorts {
  const { config, clock, writer, writing } = options;
  // The mark of a draft, released when its run closes.
  let draftRelease: (() => void) | undefined;
  // The folder of the kill switches is the one the loader named
  // (ADR 0029), never a path built here.
  const { killSwitchDir: stopDir, timeZone } = config;
  if (stopDir === undefined || timeZone === undefined) {
    throw new TypeError(
      'The runner needs its folder of the kill switches and its zone.',
    );
  }

  // The memory of runs counts per tenant (ADR 0034); the context names the
  // tenant and the actor of the routine and nothing a caller chose.
  const dueOptionsOf = (run: PreparedRun): DueOptions => {
    const routineId = run.loaded.routine.id;
    return {
      schedule: run.loaded.routine.schedule,
      timeZone,
      routineId,
      clock,
      store: options.store,
      ctx: createTenantContext({
        assignment: runAssignmentOf(routineId),
        instance: config.churchtoolsOrigin,
        mode: 'unattended',
        redaction: 'strict',
        readOnly: config.readOnly,
        features: [],
        clock,
        signal: new AbortController().signal,
        logging: { writer, minLevel: config.logLevel },
      }),
    };
  };

  const killSwitch = (routineId: string): 'on' | 'off' | 'unknown' =>
    checkRunKillSwitches(
      stopDir,
      runAssignmentOf(routineId).tenantId,
      routineId,
    );

  const open: RunnerPorts['open'] = (run) => {
    const routineId = run.loaded.routine.id;
    // A routine with checks of the core has no model (ADR 0033).
    let model: GuardedModel | undefined;
    if (run.model !== undefined) {
      const found = options.model(run.model);
      if (!found.ok) return Object.freeze({ ok: false, code: found.code });
      model = found.model;
    }
    const built = composeRunPipeline({
      config,
      catalog: options.catalog,
      writer,
      clock,
      auditFile: options.auditFile,
      createTransport: options.createTransport,
      routineId,
      writeHalt: options.writeHalt,
      // A routine without an entry reads with the own account of the
      // runner; only the runner passes this (ADR 0033, ADR 0036).
      ownAccount: true,
    });
    if (!built.ok) return Object.freeze({ ok: false, code: built.code });
    let bound: ReturnType<typeof composeRun>;
    try {
      bound = composeRun({
        pipeline: built.pipeline,
        run,
        runs: options.routines,
        config,
        ...(model === undefined ? {} : { provider: model.info }),
        logging: { writer, minLevel: config.logLevel },
        clock,
      });
    } catch (error) {
      // The transport of the run is open; the pass hears of the fault.
      void built.close().catch(() => undefined);
      throw error;
    }
    // The same tag as the reads of the run carry, so that the audit line
    // of its end names the same run, routine and model.
    const tag = Object.freeze({
      runId: bound.runId,
      routineId,
      ...(model === undefined ? {} : { provider: model.info }),
    });
    // A write that has begun is marked until the run closes, after the
    // end of its trigger, its audit line and its notice, so that no second
    // signal cuts any of them (ADR 0033). The mark is set with the first
    // call, so also during the search of the page; the first signal has
    // already ended that search, so a second one waits only for that end
    // (ADR 0036).
    let release: (() => void) | undefined;
    return Object.freeze({
      ok: true,
      run: Object.freeze({
        runId: bound.runId,
        read: bound.read,
        write:
          writing === undefined
            ? bound.write
            : (...args: Parameters<typeof bound.write>) => {
                release ??= writing();
                return bound.write(...args);
              },
        ...(model === undefined
          ? {
              // The checks of the core tell links to the own instance and
              // write the day of a change in the zone of the runner.
              checks: Object.freeze({
                origin: config.churchtoolsOrigin,
                timeZone,
              }),
            }
          : { model }),
        log: bound.log,
        end: (line: RunEndLine) =>
          built.pipeline.endRun({
            run: tag,
            result: line.result,
            ...(line.step === undefined ? {} : { step: line.step }),
            ...(line.code === undefined ? {} : { code: line.code }),
            ...(line.refused === undefined ? {} : { refused: line.refused }),
            ...(line.contentViolations === undefined
              ? {}
              : { contentViolations: line.contentViolations }),
            ...(line.attempt === undefined ? {} : { attempt: line.attempt }),
            period: line.period,
            durationMs: line.durationMs,
          }),
        close: () => {
          release?.();
          release = undefined;
          // Runs go one after the other, so a draft belongs to this one.
          draftRelease?.();
          draftRelease = undefined;
          return built.close().catch(() => undefined);
        },
      }),
    });
  };

  // A draft to the file of its routine and period, ended by the line of
  // the marking without a check code (ADR 0033). Every kill
  // switch that hits the routine stops it, also the one of every write;
  // ECCLIUM_READ_ONLY does not, since a draft writes nothing in
  // ChurchTools (ADR 0033).
  const draft: RunnerPorts['draft'] = (call): DraftResult => {
    const { draftsDir } = config;
    const inquiriesTo = config.policy.interactive.inquiriesTo;
    if (killSwitch(call.routineId) !== 'on') {
      return Object.freeze({ ok: false, code: 'policy_denied', final: true });
    }
    // The start refuses a draft without its folder and without whom to
    // ask; the check is for the types.
    if (draftsDir === undefined || inquiriesTo === undefined) {
      return Object.freeze({ ok: false, code: 'internal', final: false });
    }
    // A draft is marked like a write until its run closes, so that no
    // second signal cuts the steps after it (ADR 0033).
    draftRelease ??= writing?.();
    try {
      const line = draftMarkingLineOf(
        {
          date: dayOf(clock.now()),
          routine: call.routineId,
          run: call.period,
        },
        inquiriesTo,
      );
      replacePrivateFile(
        draftsDir,
        `${call.routineId}-${call.period}.md`,
        new TextEncoder().encode(`${call.section.trimEnd()}\n\n${line}\n`),
        { pid: options.pid },
      );
      return Object.freeze({ ok: true });
    } catch {
      // The value is never looked at: it could name the path.
      return Object.freeze({ ok: false, code: 'internal', final: false });
    }
  };

  // One JSON line per run, to each channel of the routine, never content.
  const notify: RunnerPorts['notify'] = (run, notice: RunNotice) => {
    const line = JSON.stringify({
      time: notice.time,
      routine: notice.routine,
      period: notice.period,
      run: notice.run,
      result: notice.result,
      ...(notice.step === undefined ? {} : { step: notice.step }),
      ...(notice.code === undefined ? {} : { code: notice.code }),
    });
    let taken = true;
    for (const { channel } of run.loaded.routine.notify) {
      if (channel === 'stdout') {
        taken = options.output.stdout(line) && taken;
      } else if (channel === 'file' && config.notifyFile !== undefined) {
        try {
          appendPrivateLine(config.notifyFile, line);
        } catch {
          taken = false;
        }
      } else {
        // A channel the start did not let through.
        taken = false;
      }
    }
    return taken;
  };

  return Object.freeze({
    schedule: Object.freeze({
      due: (run: PreparedRun) => checkDue(dueOptionsOf(run)),
      last: (run: PreparedRun) =>
        lastTrigger({
          schedule: run.loaded.routine.schedule,
          timeZone,
          clock,
        }),
      start: (run: PreparedRun, trigger: Trigger) =>
        startAttempt({ ...dueOptionsOf(run), trigger }),
      close: (run: PreparedRun, trigger: Trigger) =>
        closeTrigger({ ...dueOptionsOf(run), trigger }),
    }),
    locks: options.locks,
    writesHalted: () => writesHalted(options.writeHalt),
    readOnly: config.readOnly,
    killSwitch,
    open,
    draft,
    notify,
    policy: config.policy,
    clock,
  });
}

/**
 * The name of this host for the locks and the store, as the pipeline of
 * the server names it.
 *
 * @returns The name of the host.
 * @example
 * ```ts
 * createRoutineLocks({ stateDir, clock, pid: process.pid, host: hostName() });
 * ```
 */
export const hostName = (): string => hostname();
