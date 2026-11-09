/**
 * The part of the composition root that binds a run of a routine (ADR
 * 0033): a new run, the actor of the routine and the level of its model,
 * fixed in the port the engine reads with, and a logger bound to the run.
 *
 * Why here: only the composition root sets actor and mode. The engine
 * gets a function that reads, never a request it could fill itself, so no
 * routine and no data can make a run read as another actor, interactively
 * or in another level than the policy allows. The runner, which comes
 * later, binds each run through this.
 *
 * @packageDocumentation
 */
import {
  createRunId,
  type LogLevel,
  type ModelRedaction,
  runAssignmentOf,
  type ToolPipeline,
} from '@ecclium/mcp-churchtools-core';
import {
  createLogger,
  type StderrLineWriter,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  Clock,
  Logger,
  ProviderInfo,
} from '@ecclium/mcp-churchtools-plugin-api';
import type { RunRead } from '@ecclium/mcp-churchtools-workflows';

/** What a run is bound with. */
export interface RunComposeOptions {
  /** The pipeline of the instance. */
  readonly pipeline: ToolPipeline;
  /** The ID of the routine. */
  readonly routineId: string;
  /** The level of the data for its model, as the preparation settled. */
  readonly redaction: ModelRedaction;
  /** The model of the routine, for the audit lines of its reads. */
  readonly provider?: ProviderInfo;
  /** Where the lines of the logger of the run go. */
  readonly logging: {
    readonly writer: StderrLineWriter;
    readonly minLevel: LogLevel;
  };
  /** The clock of the process. */
  readonly clock: Clock;
}

/** A run bound by the composition root. */
export interface ComposedRun {
  /** The ID of the run, which every audit and log line names. */
  readonly runId: string;
  /** Reads with the actor of the routine in the mode `unattended`. */
  readonly read: RunRead;
  /** The logger of the run. */
  readonly log: Logger;
}

/**
 * Binds one run of a routine.
 *
 * @param options - Pipeline, routine, level, model, logging and clock.
 * @returns The run, frozen.
 * @throws {TypeError} When the ID of the routine has another form.
 * @example
 * ```ts
 * const bound = composeRun({ pipeline, routineId, redaction, provider, logging, clock });
 * await executeRun(prepared, trigger, { read: bound.read, log: bound.log, model, policy, clock }, signal);
 * ```
 */
export function composeRun(options: RunComposeOptions): ComposedRun {
  const { pipeline, routineId, redaction, provider, clock } = options;
  const assignment = runAssignmentOf(routineId);
  const runId = createRunId();
  const run = Object.freeze({
    runId,
    routineId,
    ...(provider === undefined ? {} : { provider }),
  });
  const read: RunRead = (tool, input, maxEntries, signal) =>
    pipeline.callForRun(tool, input, {
      assignment,
      redaction,
      features: [],
      signal,
      run,
      maxEntries,
    });
  const log = createLogger({
    writer: options.logging.writer,
    clock,
    minLevel: options.logging.minLevel,
    bound: { tenantId: assignment.tenantId, runId, mode: 'unattended' },
  });
  return Object.freeze({ runId, read, log });
}
