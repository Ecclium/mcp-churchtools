/**
 * `ecclium config check --runner` (ADR 0033, ADR 0055): checks everything
 * the start of the runner checks, without asking ChurchTools or a model,
 * and writes the report to stdout. It loads the configuration of the kind
 * `runner`, the routines and their preparation, and names each routine
 * with its schedule, its target, its account and its model, or why it
 * does not start.
 *
 * Why its own ending: the check of the server ends by pointing at
 * `ct_whoami`, which the runner never calls. A preview of a routine is the
 * first call that shows whether the runner reads and asks its model.
 *
 * @packageDocumentation
 */
import {
  type ConfigResult,
  type ConfigSources,
  loadConfig,
  readProviderKey,
} from '@ecclium/mcp-churchtools-core';
import type {
  PreparedRun,
  RoutineFileSystem,
} from '@ecclium/mcp-churchtools-workflows';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import { type Output, renderConfigReport } from '../output/index.js';
import { type RunnerStartOptions, startRunner } from './start.js';
import {
  modelKeyText,
  refusedText,
  routinesProblemText,
  runnerStartTexts,
} from './texts.js';

/** What the check of the runner needs, with replacements for tests. */
export interface RunnerCheckOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  readonly showValues: boolean;
  readonly output: Output;
  /** Replaces the loader of the configuration. */
  readonly load?: (sources: ConfigSources) => ConfigResult;
  /** Replaces the file functions of the loader of the routines. */
  readonly routineFiles?: RoutineFileSystem;
  /** Replaces the reading of the file of a key of a model. */
  readonly readModelKey?: typeof readProviderKey;
  /** Replaces the catalog, such as with the read tools of a test plugin. */
  readonly createCatalog?: RunnerStartOptions['createCatalog'];
}

const quote = (text: string): string => `‹${text}›`;

// One routine that starts, without any value of ChurchTools.
const routineLine = (run: PreparedRun): string => {
  const { routine } = run.loaded;
  const target =
    routine.output.target === 'wiki'
      ? 'Abschnitt im Wiki'
      : `Entwurf über den Kanal ${quote(routine.output.channel)}`;
  const account =
    run.credential === undefined
      ? 'eigenes Konto des Runners'
      : `Konto ${quote(run.credential)}`;
  // A routine with checks of the core has no model and no level to it.
  const filled =
    run.model === undefined
      ? `ohne Modell, mit den Prüfungen ${(routine.checks ?? []).map(({ check }) => quote(check)).join(' und ')}`
      : `Modell ${quote(run.model)}, Maskierung zum Modell ${quote(run.redaction)}`;
  return `  - ${quote(routine.id)}: Zeitplan ${quote(routine.schedule)}, ${target}, ${account}, ${filled}`;
};

const validText =
  'Die Konfiguration des Runners ist gültig. ChurchTools und die Modelle wurden nicht angefragt. Probieren Sie eine Routine mit ‹ecclium run-once <Routine> --preview› aus: Die Vorschau liest und fragt das Modell der Routine, falls sie eines hat, schreibt aber nichts.';
const invalidText =
  'Mit dieser Konfiguration startet der Runner nicht, oder eine Routine startet nicht. ChurchTools wurde nicht angefragt. Beheben Sie die Probleme und prüfen Sie dann erneut mit ‹ecclium config check --runner›.';

/**
 * Checks the configuration of the runner and its routines.
 *
 * @param options - Environment, options of Node.js, whether to show
 *   values, output, and replacements for tests.
 * @returns 0 when the runner and every routine start, else 78.
 * @throws {TypeError} Only for an internal error.
 * @example
 * ```ts
 * const code = checkRunnerConfig({ environment, execArgv, showValues: false, output });
 * ```
 */
export function checkRunnerConfig(options: RunnerCheckOptions): ExitCode {
  const { output } = options;
  const load = options.load ?? loadConfig;
  const loaded = load({
    environment: options.environment,
    transport: 'runner',
    execArgv: options.execArgv,
  });
  for (const line of renderConfigReport(loaded.report, {
    valid: loaded.ok,
    showValues: options.showValues,
    policy: loaded.ok ? loaded.config.policy : undefined,
    providers: loaded.ok ? loaded.config.providers : undefined,
    withoutEnding: true,
  })) {
    output.stdout(line);
  }
  if (!loaded.ok) {
    output.stdout(invalidText);
    return exitCodes.invalidConfig;
  }
  const started = startRunner({
    environment: options.environment,
    execArgv: options.execArgv,
    mode: { kind: 'due' },
    // The configuration is loaded already; the start takes the same.
    load: () => loaded,
    ...(options.routineFiles === undefined
      ? {}
      : { routineFiles: options.routineFiles }),
    ...(options.createCatalog === undefined
      ? {}
      : { createCatalog: options.createCatalog }),
  });
  if (!started.ok) {
    const { problem } = started;
    switch (problem.kind) {
      case 'routines':
        output.stdout(routinesProblemText(problem.problem));
        break;
      case 'credential_mixed':
        output.stdout(runnerStartTexts.credential_mixed(problem.routineId));
        break;
      case 'read_only_wiki':
        output.stdout(runnerStartTexts.read_only_wiki(problem.routineId));
        break;
      // The configuration passed above, and no routine is named.
      case 'config':
      case 'routine_unknown':
        break;
    }
    output.stdout(invalidText);
    return exitCodes.invalidConfig;
  }
  const { routines, refused } = started;
  output.stdout(
    routines.length === 1
      ? 'Routinen, die starten: 1'
      : `Routinen, die starten: ${String(routines.length)}`,
  );
  for (const run of routines) output.stdout(routineLine(run));
  for (const item of refused) output.stdout(`  - ${refusedText(item)}`);
  // The key file of each model a routine needs, read as a run reads it and
  // dropped at once, so that the check sees what would keep a run from
  // opening.
  const readKey = options.readModelKey ?? readProviderKey;
  let keysRefused = false;
  const aliases = new Set(
    routines.flatMap((run) => (run.model === undefined ? [] : [run.model])),
  );
  for (const provider of loaded.config.providers ?? []) {
    if (!aliases.has(provider.alias)) continue;
    const key = readKey(provider.apiKeyFile);
    if (!key.ok) {
      keysRefused = true;
      output.stdout(`  - ${modelKeyText(provider.alias, key.code)}`);
    }
  }
  if (refused.length > 0 || keysRefused) {
    output.stdout(invalidText);
    return exitCodes.invalidConfig;
  }
  output.stdout(validText);
  return exitCodes.ok;
}
