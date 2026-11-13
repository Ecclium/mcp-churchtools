/**
 * The start of the runner of routines (ADR 0033, ADR 0034): the
 * configuration of the kind `runner`, the catalog of the tools a routine
 * may read, the routines from their folder and their preparation, and the
 * checks that keep the runner or a routine from starting.
 *
 * Where it stands: before every pass. `ecclium run-once` starts once per
 * call; the daemon, later, once per process. Nothing here talks to
 * ChurchTools or a model, and no folder is made: the start only reads and
 * judges, so `ecclium config check --runner` can show the same.
 *
 * What stops the whole runner (ADR 0033): a configuration the loader
 * refuses, routines it cannot load, a routine whose entries name two
 * accounts, and a routine into the wiki while `ECCLIUM_READ_ONLY` is not
 * `false`, so that a run that could not write never asks the model. What stops only one
 * routine: a routine that does not pass its preparation, and a draft or a
 * notice without what it needs. The other routines run, and the command
 * names each one that does not. A preview writes nothing: it runs before
 * the entry of its target and while the configuration only reads
 * (ADR 0033).
 *
 * @packageDocumentation
 */
import {
  type ConfigProblem,
  type ConfigResult,
  type ConfigSources,
  type ConfigWarningCode,
  describeRunTool,
  type EccliumConfig,
  loadConfig,
  runAssignmentOf,
  type ToolCatalog,
  toolsetNames,
  createToolCatalog,
} from '@ecclium/mcp-churchtools-core';
import { checkRunKillSwitches } from '@ecclium/mcp-churchtools-core/composition';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';
import {
  loadRoutines,
  type PreparedRun,
  prepareRun,
  type RoutineFileSystem,
  type RoutineLoadProblem,
  runCredentialOf,
  type RunPrepareCode,
} from '@ecclium/mcp-churchtools-workflows';

/** What a call of the runner does. */
export type RunnerMode =
  | { readonly kind: 'due' }
  | { readonly kind: 'manual'; readonly routineId: string }
  | { readonly kind: 'preview'; readonly routineId: string };

/** Why one routine does not start, besides its preparation. */
export type RunnerRoutineCode =
  | RunPrepareCode
  | 'runner_pseudonym_key_missing'
  | 'runner_drafts_dir_unset'
  | 'runner_stop_dir_missing'
  | 'runner_inquiries_missing'
  | 'runner_notify_file_unset';

/** A routine that does not start, with its code and field. */
export interface RefusedRoutine {
  readonly routineId: string;
  readonly code: RunnerRoutineCode;
  /** The path of the field, such as `inputs[1].tool`. */
  readonly field?: string;
}

/** Why the runner does not start at all. */
export type RunnerStartProblem =
  | {
      readonly kind: 'config';
      readonly problems: readonly ConfigProblem[];
    }
  | { readonly kind: 'routines'; readonly problem: RoutineLoadProblem }
  | { readonly kind: 'credential_mixed'; readonly routineId: string }
  | { readonly kind: 'read_only_wiki'; readonly routineId: string }
  | { readonly kind: 'routine_unknown' };

// The warnings of the loader that concern the runner: a runner without
// its proxy and a proxy of the shell that Ecclium does not use (ADR 0035).
const egressWarnings: readonly ConfigWarningCode[] = Object.freeze([
  'egress_off',
  'environment_proxy_ignored',
]);

/** The started runner, or why it does not start. */
export type RunnerStart =
  | {
      readonly ok: true;
      readonly config: EccliumConfig;
      /**
       * The warnings of the configuration about the proxy, which the
       * runner shows at every start (ADR 0035). The other warnings of the
       * loader speak of the server.
       */
      readonly warnings: readonly ConfigWarningCode[];
      /** Every tool a routine may read, and the write tool when it writes. */
      readonly catalog: ToolCatalog;
      /** Every routine that passed its preparation and its checks. */
      readonly routines: readonly PreparedRun[];
      /** Every routine that does not start, in the order of the IDs. */
      readonly refused: readonly RefusedRoutine[];
      /**
       * The routine of a run by hand or a preview, prepared for it, or
       * undefined when it does not start; then `refused` names it.
       */
      readonly target?: PreparedRun;
    }
  | { readonly ok: false; readonly problem: RunnerStartProblem };

/** What the start reads, with replacements for tests. */
export interface RunnerStartOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  readonly mode: RunnerMode;
  /** Replaces the loader of the configuration. */
  readonly load?: (sources: ConfigSources) => ConfigResult;
  /** Replaces the file functions of the loader of the routines. */
  readonly routineFiles?: RoutineFileSystem;
  /** Replaces the check of the kill switches, for the folder `stop`. */
  readonly checkKillSwitches?: typeof checkRunKillSwitches;
  /** Replaces the catalog, such as with the read tools of a test plugin. */
  readonly createCatalog?: (config: EccliumConfig) => ToolCatalog;
}

/**
 * The catalog of the runner: every read tool of the core except the
 * toolsets `docs` and `api`, whatever `ECCLIUM_TOOLSETS` says, since a
 * routine names its tools itself and the preparation keeps only those a
 * routine may rely on. `docs` needs the built index and `api` holds no tool
 * for routines. With writing on, the write tools of the core are in it,
 * among them `ct_wiki_page_append_section`.
 *
 * @param config - The configuration of the runner.
 * @returns The catalog.
 * @example
 * ```ts
 * const catalog = createRunnerCatalog(config);
 * ```
 */
export function createRunnerCatalog(
  config: Pick<EccliumConfig, 'readOnly'>,
): ToolCatalog {
  return createToolCatalog({
    core: createCorePlugin({ writing: !config.readOnly }),
    plugins: [],
    readOnly: config.readOnly,
    toolsets: new Set(
      toolsetNames.filter((name) => name !== 'docs' && name !== 'api'),
    ),
  });
}

// What a routine needs besides its preparation: the key of the pseudonyms
// for reads at the level strict, also in a preview; for a draft, its
// folder, the folder of the kill switches and whom to ask for its marking;
// for a notice to a file, ECCLIUM_NOTIFY_FILE. A preview writes and sends
// nothing, so it needs only the key.
const needsOf = (
  run: PreparedRun,
  config: EccliumConfig,
  checkKillSwitches: typeof checkRunKillSwitches,
  preview: boolean,
): RefusedRoutine | undefined => {
  const { routine } = run.loaded;
  const routineId = routine.id;
  // The level strict to the model is the default of every routine
  // (ADR 0033), and it puts pseudonyms in place of the IDs of persons.
  if (run.redaction === 'strict' && config.pseudonymKey === undefined) {
    return { routineId, code: 'runner_pseudonym_key_missing' };
  }
  if (preview) return undefined;
  if (routine.output.target === 'draft') {
    if (config.draftsDir === undefined) {
      return { routineId, code: 'runner_drafts_dir_unset' };
    }
    // A kill switch the core cannot see would stop every draft, so the
    // folder must be there, also while the configuration only reads
    // (ADR 0033).
    if (
      config.stateDir === undefined ||
      checkKillSwitches(
        `${config.stateDir}/stop`,
        runAssignmentOf(routineId).tenantId,
        routineId,
      ) === 'unknown'
    ) {
      return { routineId, code: 'runner_stop_dir_missing' };
    }
    if (config.policy.interactive.inquiriesTo === undefined) {
      return { routineId, code: 'runner_inquiries_missing' };
    }
  }
  if (
    routine.notify.some((entry) => entry.channel === 'file') &&
    config.notifyFile === undefined
  ) {
    return { routineId, code: 'runner_notify_file_unset', field: 'notify' };
  }
  return undefined;
};

/**
 * Starts the runner: loads the configuration of the kind `runner` and the
 * routines, prepares each one and checks what it needs.
 *
 * @param options - Environment, options of Node.js, what the call does,
 *   and replacements for tests.
 * @returns The started runner, or the problem that keeps it from
 *   starting. It reads files but writes none.
 * @throws {TypeError} Only for an internal error.
 * @example
 * ```ts
 * const started = startRunner({ environment, execArgv, mode: { kind: 'due' } });
 * if (!started.ok) return report(started.problem);
 * ```
 */
export function startRunner(options: RunnerStartOptions): RunnerStart {
  const fail = (problem: RunnerStartProblem): RunnerStart =>
    Object.freeze({ ok: false, problem });
  const loaded = (options.load ?? loadConfig)({
    environment: options.environment,
    transport: 'runner',
    execArgv: options.execArgv,
  });
  if (!loaded.ok) {
    return fail({ kind: 'config', problems: loaded.report.problems });
  }
  const { config } = loaded;
  // The loader of the kind runner requires the folder; the check is for
  // the types.
  if (config.routinesDir === undefined) {
    return fail({ kind: 'config', problems: loaded.report.problems });
  }
  const routines = loadRoutines(config.routinesDir, options.routineFiles);
  if (!routines.ok) {
    const { code, routine, reason, field, line } = routines;
    return fail({
      kind: 'routines',
      problem: {
        code,
        ...(routine === undefined ? {} : { routine }),
        ...(reason === undefined ? {} : { reason }),
        ...(field === undefined ? {} : { field }),
        ...(line === undefined ? {} : { line }),
      },
    });
  }
  const { mode } = options;
  const preview = mode.kind === 'preview';
  const named =
    mode.kind === 'due'
      ? undefined
      : routines.routines.find(
          (routine) => routine.routine.id === mode.routineId,
        );
  if (mode.kind !== 'due' && named === undefined) {
    return fail({ kind: 'routine_unknown' });
  }
  // Writing into the wiki needs ECCLIUM_READ_ONLY=false; a runner that
  // would read, ask the model and then not write does not start (decided
  // on 10.11.2026). A preview writes nothing.
  if (config.readOnly && !preview) {
    const wiki = routines.routines.find(
      (routine) => routine.routine.output.target === 'wiki',
    );
    if (wiki !== undefined) {
      return fail({ kind: 'read_only_wiki', routineId: wiki.routine.id });
    }
  }

  const catalog = (options.createCatalog ?? createRunnerCatalog)(config);
  const models = new Set((config.providers ?? []).map((item) => item.alias));
  const context = {
    tool: (name: string) => describeRunTool(catalog, name),
    policy: config.policy,
    models,
  };
  const checkKillSwitches = options.checkKillSwitches ?? checkRunKillSwitches;
  // Two accounts for one routine stop the whole runner (ADR 0033), before
  // any other check of a routine could name a lesser problem first.
  for (const routine of routines.routines) {
    if (!runCredentialOf(config.policy, routine.routine.id).ok) {
      return fail({ kind: 'credential_mixed', routineId: routine.routine.id });
    }
  }
  const prepared: PreparedRun[] = [];
  const refused: RefusedRoutine[] = [];
  for (const routine of routines.routines) {
    const result = prepareRun(routine, context);
    if (!result.ok) {
      // Two accounts for one routine stop the whole runner (ADR 0033).
      if (result.code === 'run_credential_mixed') {
        return fail({
          kind: 'credential_mixed',
          routineId: routine.routine.id,
        });
      }
      refused.push(
        Object.freeze({
          routineId: routine.routine.id,
          code: result.code,
          ...(result.field === undefined ? {} : { field: result.field }),
        }),
      );
      continue;
    }
    const missing = needsOf(
      result.run,
      config,
      checkKillSwitches,
      preview && named === routine,
    );
    if (missing !== undefined) {
      refused.push(Object.freeze(missing));
      continue;
    }
    prepared.push(result.run);
  }

  let target: PreparedRun | undefined;
  if (named !== undefined) {
    if (preview) {
      // Prepared on its own for the preview, which may lack the entry of
      // its target; it never joins the routines of an account.
      const result = prepareRun(named, { ...context, preview: true });
      // A preview reads like a run, at the level of its model.
      const missing: RefusedRoutine | undefined = result.ok
        ? needsOf(result.run, config, checkKillSwitches, true)
        : Object.freeze({
            routineId: named.routine.id,
            code: result.code,
            ...(result.field === undefined ? {} : { field: result.field }),
          });
      // What the preview says of the routine replaces what the full
      // preparation said: a missing entry of the target is what a preview
      // runs without, and another problem may stand behind it.
      const index = refused.findIndex(
        (item) => item.routineId === named.routine.id,
      );
      if (index >= 0) refused.splice(index, 1);
      if (result.ok && missing === undefined) {
        target = result.run;
      } else if (missing !== undefined) {
        refused.push(Object.freeze(missing));
        refused.sort((left, right) =>
          left.routineId < right.routineId ? -1 : 1,
        );
      }
    } else {
      target = prepared.find((run) => run.loaded === named);
    }
  }
  return Object.freeze({
    ok: true,
    config,
    warnings: Object.freeze(
      loaded.report.warnings.filter((code) =>
        (egressWarnings as readonly string[]).includes(code),
      ),
    ),
    catalog,
    routines: Object.freeze(prepared),
    refused: Object.freeze(refused),
    ...(target === undefined ? {} : { target }),
  });
}
