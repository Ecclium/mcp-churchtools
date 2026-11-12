/**
 * The part of the composition root that binds a run of a routine (ADR
 * 0033): a new run, the actor of the routine and the level of its model,
 * fixed in the ports the engine reads and writes with, and a logger bound
 * to the run.
 *
 * Why here: only the composition root sets actor and mode. The engine
 * gets functions that read and write, never a request it could fill
 * itself, so no routine and no data can make a run read or write as
 * another actor, interactively or in another level than the policy
 * allows. The runner, which comes later, binds each run through this.
 *
 * What the write of a run needs that the engine never holds (ADR 0032):
 * the results of the reads of this run, whose contact values the section
 * may hold; the tools of every routine of the account of the run, against
 * whose rights the core holds the rights of the account; and the counter
 * of the writes of the run, made here once per run.
 *
 * @packageDocumentation
 */
import {
  createRunId,
  type EccliumConfig,
  type LogLevel,
  runAssignmentOf,
  runnerOwnAlias,
  type RunPageRef,
  type ToolPipeline,
} from '@ecclium/mcp-churchtools-core';
import {
  createLogger,
  createRunWrites,
  type StderrLineWriter,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  Clock,
  Logger,
  ProviderInfo,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  accountToolsOf,
  type PreparedRun,
  runCredentialOf,
  type RunRead,
  type RunWrite,
} from '@ecclium/mcp-churchtools-workflows';

/** What a run is bound with. */
export interface RunComposeOptions {
  /** The pipeline of the run, with the token of its account. */
  readonly pipeline: ToolPipeline;
  /**
   * The prepared routine of the run: its ID, the level of the data for its
   * model and the alias of its account, as the preparation settled them.
   */
  readonly run: PreparedRun;
  /**
   * Every routine the runner prepared, for the tools of the account of the
   * run. Only a routine that passed its preparation counts.
   */
  readonly runs: readonly PreparedRun[];
  /**
   * The checked configuration: whether it only reads, and the policy whose
   * entries name the alias of the account.
   */
  readonly config: EccliumConfig;
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
  /** Writes with the same actor, mode and run, after the reads. */
  readonly write: RunWrite;
  /** The logger of the run. */
  readonly log: Logger;
}

// The page as a plain record, so that the core reads no getter of the
// object the engine passed (ADR 0032).
const plainPage = (page: RunPageRef): RunPageRef =>
  'guid' in page
    ? { categoryId: page.categoryId, guid: page.guid }
    : { categoryId: page.categoryId, title: page.title };

/**
 * Binds one run of a routine.
 *
 * @param options - Pipeline, the prepared routine, every prepared routine,
 *   configuration, model, logging and clock.
 * @returns The run, frozen.
 * @throws {TypeError} When the ID of the routine has another form, or the
 *   alias of the prepared routine is not the one the policy of the
 *   configuration names, as for a routine prepared against another policy.
 * @example
 * ```ts
 * const bound = composeRun({ pipeline, run: prepared, runs, config, provider, logging, clock });
 * const rendered = await executeRun(prepared, trigger, { read: bound.read, log: bound.log, model, policy, clock }, signal);
 * if (rendered.kind === 'rendered') await writeRun(rendered, { write: bound.write, log: bound.log, clock }, signal);
 * ```
 */
export function composeRun(options: RunComposeOptions): ComposedRun {
  const { pipeline, provider, clock, config } = options;
  const { redaction } = options.run;
  const routineId = options.run.loaded.routine.id;
  // The alias of the account comes from the policy of the configuration;
  // a preparation against another policy is a fault of the caller.
  const settled = runCredentialOf(config.policy, routineId);
  if (!settled.ok || settled.credential !== options.run.credential) {
    throw new TypeError('The account of the run is not the one of the policy.');
  }
  const { credential } = settled;
  const assignment = runAssignmentOf(routineId);
  const runId = createRunId();
  const run = Object.freeze({
    runId,
    routineId,
    ...(provider === undefined ? {} : { provider }),
  });
  // The results of the reads of this run, each with the mark of the
  // pipeline, whose contact values the section of the run may hold. The
  // checks of the core put no value of their reads into the section but
  // titles, each checked without known contact values, so their reads
  // make no contact value known to the write guard either (ADR 0033).
  const keepsData = options.run.loaded.routine.checks === undefined;
  const data: unknown[] = [];
  const read: RunRead = async (tool, input, maxEntries, signal) => {
    const outcome = await pipeline.callForRun(tool, input, {
      assignment,
      redaction,
      features: [],
      signal,
      run,
      maxEntries,
    });
    if (outcome.ok && keepsData) data.push(outcome.data);
    return outcome;
  };
  // The tools of every routine of the account, not only of this one: an
  // account serves all of them, and a tool too many or too few would hide
  // a right too wide or queue every write (ADR 0032).
  // The running routine counts even when the caller left it out. A routine
  // without an entry reads with the own account of the runner (ADR 0023).
  const accountTools = accountToolsOf(
    [options.run, ...options.runs],
    credential ?? runnerOwnAlias,
  );
  // One counter per run, for the limit per run of the policy.
  const runWrites = createRunWrites();
  // Whether the configuration only reads, never from the caller.
  const readOnly = config.readOnly;
  const write: RunWrite = (call, signal) =>
    pipeline.writeForRun({
      assignment,
      features: [],
      signal,
      run,
      readOnly,
      tool: call.tool,
      period: call.period,
      section: call.section,
      page: plainPage(call.page),
      data: [...data],
      accountTools,
      runWrites,
    });
  const log = createLogger({
    writer: options.logging.writer,
    clock,
    minLevel: options.logging.minLevel,
    bound: { tenantId: assignment.tenantId, runId, mode: 'unattended' },
  });
  return Object.freeze({ runId, read, write, log });
}
