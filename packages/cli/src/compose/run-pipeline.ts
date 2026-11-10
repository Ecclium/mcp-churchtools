/**
 * The pipeline of one run of a routine (ADR 0033): the transport and the
 * pipeline of `composeToolPipeline`, with the token of the account the
 * entries of the routine name in the policy.
 *
 * Why a pipeline per run: the transport holds the token, and the token of
 * an alias is read anew for each run, so that a new token takes effect
 * with the next run and no restart of a daemon is needed. Everything that
 * outlives a run sits on disk or comes from the runner: the counters of
 * the day, the queue, the snapshots, the audit file and the halt of
 * writes of the process, which every pipeline of the runner shares. The
 * throttle of the requests to ChurchTools is one per pipeline, so runs
 * that a daemon starts at the same time each have their own.
 *
 * Which account: the alias comes from the entries of the routine in the
 * policy of the configuration, never from the caller. A routine whose
 * entries name an alias reads and writes with the file `ct_token_<alias>`
 * of `ECCLIUM_RUNNER_TOKENS_DIR`, and never with another token. A routine
 * without an entry, which writes no page, reads with the own account of
 * the runner, the file `ct_token_runner` in the same folder (ADR 0023,
 * ADR 0033), read anew for each run like any other. Only the runner builds
 * such a run; any other caller must require an account, so that nothing
 * but the runner reads in the name of a routine without an entry. Without
 * the variable, with a folder or a file the checks refuse, the run does
 * not start, and the token of the configuration is never taken: the
 * folder is checked again for each run, since its rights can change while
 * a daemon runs.
 *
 * @packageDocumentation
 */
import {
  checkRunnerTokensDir,
  readRunnerToken,
  runnerOwnAlias,
  type RunnerTokensDirCode,
  type TokenFileCode,
  type ToolPipeline,
} from '@ecclium/mcp-churchtools-core';
import type { WriteHalt } from '@ecclium/mcp-churchtools-core/composition';
import { runCredentialOf } from '@ecclium/mcp-churchtools-workflows';

import { type ComposeOptions, composeToolPipeline } from './pipeline.js';

/** What the pipeline of a run is built from. */
export interface RunPipelineOptions extends ComposeOptions {
  /**
   * The ID of the routine of the run. The alias of its account comes from
   * the entries of the routine in the policy of the configuration, never
   * from the caller.
   */
  readonly routineId: string;
  /** The halt of writes of the process, the same for every run. */
  readonly writeHalt: WriteHalt;
  /**
   * Whether the routine must have an account in the policy, as for the
   * approval of an entry a run queued: then a routine without an entry
   * builds nothing instead of reading with the token of the server.
   */
  readonly requireAccount?: boolean;
  /** Only for tests: reads the token file of an alias. */
  readonly readToken?: typeof readRunnerToken;
  /** Only for tests: checks the folder of the token files. */
  readonly checkTokensDir?: typeof checkRunnerTokensDir;
}

/** Why the pipeline of a run was not built. */
export type RunPipelineCode =
  | TokenFileCode
  | RunnerTokensDirCode
  | 'runner_tokens_dir_unset'
  | 'run_credential_mixed'
  | 'run_credential_missing';

/** The pipeline of a run, or why it was not built. */
export type RunPipelineResult =
  | {
      readonly ok: true;
      /** The pipeline of the run, with the token of its account. */
      readonly pipeline: ToolPipeline;
      /** Closes the transport of the run; the caller calls it at its end. */
      close(): Promise<void>;
    }
  | {
      readonly ok: false;
      /**
       * `runner_tokens_dir_unset` while `ECCLIUM_RUNNER_TOKENS_DIR` is not
       * set, `run_credential_mixed` for a routine whose entries name two
       * aliases, `run_credential_missing` for a routine without an entry
       * when an account is required, the code of the check of the folder,
       * such as `runner_tokens_dir_mode`, or the code of the token file,
       * such as `token_file_missing`.
       */
      readonly code: RunPipelineCode;
    };

/**
 * Builds the pipeline of one run with the token of its account.
 *
 * @param options - What `composeToolPipeline` takes, the ID of the
 *   routine and the halt of writes of the process.
 * @returns The pipeline with a function that closes its transport, or why
 *   no token was read. Nothing is open when it was not built.
 * @throws {TypeError} When a factory of core refuses its options, as
 *   `composeToolPipeline` does, or when a caller other than the runner
 *   asks for a routine without an entry and requires no account.
 * @example
 * ```ts
 * const built = composeRunPipeline({ config, catalog, writer, clock, auditFile, routineId, writeHalt });
 * if (!built.ok) return report(built.code);
 * try { await run(built.pipeline); } finally { await built.close(); }
 * ```
 */
export function composeRunPipeline(
  options: RunPipelineOptions,
): RunPipelineResult {
  const { config } = options;
  // The alias from the policy itself, so that no caller can hand a run the
  // token of the server or of another account.
  const settled = runCredentialOf(config.policy, options.routineId);
  if (!settled.ok) {
    return Object.freeze({ ok: false, code: 'run_credential_mixed' });
  }
  let { credential } = settled;
  if (credential === undefined) {
    if (options.requireAccount === true) {
      return Object.freeze({ ok: false, code: 'run_credential_missing' });
    }
    // A routine without an entry reads with the own account of the runner,
    // and only the runner may build such a run (ADR 0023).
    if (config.transport !== 'runner') {
      throw new TypeError(
        'Only the runner reads for a routine without an account.',
      );
    }
    credential = runnerOwnAlias;
  }
  // Every run reads with the account of its alias or not at all: the token
  // of the configuration would give a run more than its routines need.
  if (config.runnerTokensDir === undefined) {
    return Object.freeze({ ok: false, code: 'runner_tokens_dir_unset' });
  }
  const folder = (options.checkTokensDir ?? checkRunnerTokensDir)(
    config.runnerTokensDir,
  );
  if (!folder.ok) return Object.freeze({ ok: false, code: folder.code });
  const read = (options.readToken ?? readRunnerToken)(
    config.runnerTokensDir,
    credential,
  );
  if (!read.ok) return Object.freeze({ ok: false, code: read.code });
  const { pipeline, transport } = composeToolPipeline({
    config: Object.freeze({ ...config, churchtoolsToken: read.value }),
    catalog: options.catalog,
    writer: options.writer,
    clock: options.clock,
    auditFile: options.auditFile,
    createTransport: options.createTransport,
    writeHalt: options.writeHalt,
  });
  return Object.freeze({
    ok: true,
    pipeline,
    close: (): Promise<void> => transport.close(),
  });
}
