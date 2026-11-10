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
 * of `ECCLIUM_RUNNER_TOKENS_DIR`, and never with another token. Without
 * the variable, without the file or with a file the checks refuse, the run
 * does not start. A routine without an entry, which writes no page, reads
 * with the token of `ECCLIUM_CHURCHTOOLS_TOKEN_FILE`.
 *
 * @packageDocumentation
 */
import {
  readRunnerToken,
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
}

/** Why the pipeline of a run was not built. */
export type RunPipelineCode =
  | TokenFileCode
  | 'runner_tokens_dir_missing'
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
       * `runner_tokens_dir_missing` for an alias while
       * `ECCLIUM_RUNNER_TOKENS_DIR` is not set, `run_credential_mixed` for
       * a routine whose entries name two aliases, `run_credential_missing`
       * for a routine without an entry when an account is required, else
       * the code of the token file, such as `token_file_missing`.
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
 *   `composeToolPipeline` does.
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
  const { credential } = settled;
  if (credential === undefined && options.requireAccount === true) {
    return Object.freeze({ ok: false, code: 'run_credential_missing' });
  }
  let token = config.churchtoolsToken;
  if (credential !== undefined) {
    // An alias reads and writes with its own account or not at all: the
    // token of the server would give a run more than its routines need.
    if (config.runnerTokensDir === undefined) {
      return Object.freeze({ ok: false, code: 'runner_tokens_dir_missing' });
    }
    const read = (options.readToken ?? readRunnerToken)(
      config.runnerTokensDir,
      credential,
    );
    if (!read.ok) return Object.freeze({ ok: false, code: read.code });
    token = read.value;
  }
  const { pipeline, transport } = composeToolPipeline({
    config: Object.freeze({ ...config, churchtoolsToken: token }),
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
