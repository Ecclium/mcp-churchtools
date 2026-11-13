/**
 * `ecclium doctor`, first version (ADR 0035, ADR 0032): checks what the
 * runner relies on and writes a report to stdout that fits into a public
 * issue as it is. It loads the configuration of the kind `runner` and
 * then checks, in this order: the outbound path through the proxy and
 * past it, the providers of the models with the keys of the models the
 * routines use, the policy as `ecclium config check` shows it, the
 * routines, and the rights of each account of the runner.
 *
 * It only reads. It asks ChurchTools with `ct_whoami` for each account,
 * which leaves a line in the audit, never a model, and the proxy only for
 * tunnels it closes after the TLS handshake.
 *
 * Exit codes: 0 without a finding on the outbound path, the providers,
 * the routines and the accounts; 65 with at least one, also with
 * `ECCLIUM_EGRESS=off` and for every check that did not come about or not
 * whole. The findings of the policy show but do not count, because they
 * are often meant, such as an empty interactive part for a runner alone.
 * 78 when the configuration of the runner is invalid; then nothing else is
 * checked or asked. 64 and 70 as for every command.
 *
 * @packageDocumentation
 */
import {
  type ConfigResult,
  type ConfigSources,
  type EccliumConfig,
  loadConfig,
  readProviderKey,
} from '@ecclium/mcp-churchtools-core';
import { systemClock } from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import { isIsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import type { RoutineFileSystem } from '@ecclium/mcp-churchtools-workflows';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import { warningText } from '../messages/index.js';
import {
  type Output,
  policyLines,
  providerLines,
  renderConfigReport,
} from '../output/index.js';
import { withReading } from '../policy/names.js';
import type { WriteSyncFn } from '../send.js';
import {
  egressWarnings,
  type RunnerStartOptions,
  startRunner,
} from '../runner/start.js';
import {
  modelKeyText,
  refusedText,
  routinesProblemText,
  runnerStartTexts,
} from '../runner/texts.js';
import { checkAccounts } from './accounts.js';
import { checkEgress, type EgressProbes, egressProbes } from './egress.js';
import {
  accountsNoAuditText,
  accountsSection,
  accountsSkippedText,
  configInvalidText,
  configValidText,
  egressSection,
  findingPrefix,
  headingText,
  noProvidersText,
  notCheckedText,
  providerUseText,
  resultText,
  routinesCountText,
  warningsHeadingText,
} from './texts.js';

/** What `ecclium doctor` needs, with replacements for tests. */
export interface DoctorOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  /** Whether to name the host and port of each target. */
  readonly showValues: boolean;
  readonly output: Output;
  /** Replaces the loader of the configuration. */
  readonly load?: ((sources: ConfigSources) => ConfigResult) | undefined;
  /** Replaces the file functions of the loader of the routines. */
  readonly routineFiles?: RoutineFileSystem | undefined;
  /** Replaces the catalog of the runner. */
  readonly createCatalog?: RunnerStartOptions['createCatalog'] | undefined;
  /** Replaces the reading of the file of a key of a model. */
  readonly readModelKey?: typeof readProviderKey | undefined;
  /** Replaces the checks of the outbound path. */
  readonly probes?: EgressProbes | undefined;
  /** Replaces the factory of the transport, such as with the double. */
  readonly createTransport?:
    ((options: HttpTransportOptions) => HttpTransport) | undefined;
  /** Replaces `writeSync` of the stderr writer of the logs. */
  readonly writeSync?: WriteSyncFn | undefined;
  /** Replaces the time, for the day of the exceptions of the policy. */
  readonly now?: (() => number) | undefined;
}

// How many lines of the policy are findings: they start like every
// finding, after the indent.
const policyFindingsOf = (lines: readonly string[]): number =>
  lines.filter((line) => line.trimStart().startsWith(findingPrefix)).length;

// The section of the providers: the summary of `config check`, which
// routines use each, and the key of every model a routine that starts
// uses, read and dropped at once.
const providersSection = (
  config: EccliumConfig,
  used: ReadonlyMap<string, readonly string[]>,
  options: DoctorOptions,
): { readonly lines: readonly string[]; readonly findings: number } => {
  const providers = config.providers;
  if (providers === undefined || providers.length === 0) {
    return { lines: [noProvidersText], findings: 0 };
  }
  const lines = [...providerLines(providers, options.showValues)];
  const readKey = options.readModelKey ?? readProviderKey;
  let findings = 0;
  for (const provider of providers) {
    const routines = used.get(provider.alias) ?? [];
    lines.push(`  ${providerUseText(provider.alias, routines)}`);
    if (routines.length === 0) continue;
    const key = readKey(provider.apiKeyFile);
    if (!key.ok) {
      findings += 1;
      lines.push(`  ${findingPrefix}${modelKeyText(provider.alias, key.code)}`);
    }
  }
  return { lines, findings };
};

/**
 * Runs `ecclium doctor`.
 *
 * @param options - Environment, options of Node.js, whether to show
 *   values, output, and replacements for tests.
 * @returns 0 without a finding that counts, 65 with one, 78 for an
 *   invalid configuration of the runner.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * const code = await runDoctor({ environment, execArgv, showValues: false, output });
 * ```
 */
export async function runDoctor(options: DoctorOptions): Promise<ExitCode> {
  const { output, showValues } = options;
  const write = (lines: readonly string[]): void => {
    for (const line of lines) output.stdout(line);
  };
  write([headingText]);
  const loaded = (options.load ?? loadConfig)({
    environment: options.environment,
    transport: 'runner',
    execArgv: options.execArgv,
  });
  if (!loaded.ok) {
    write(
      // Without values even with --show-values, which names hosts only:
      // the report of the configuration would show paths as well.
      renderConfigReport(loaded.report, {
        valid: false,
        showValues: false,
        withoutEnding: true,
      }),
    );
    write([configInvalidText]);
    return exitCodes.invalidConfig;
  }
  const { config } = loaded;
  write([configValidText]);
  const warnings = loaded.report.warnings.filter((code) =>
    egressWarnings.includes(code),
  );
  if (warnings.length > 0) {
    write([
      warningsHeadingText,
      ...warnings.map((code) => `  - ${warningText(code)}`),
    ]);
  }
  let findings = 0;

  const egress = egressSection(
    await checkEgress(config, options.probes ?? egressProbes),
    showValues,
  );
  write(egress.lines);
  findings += egress.findings;

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

  const used = new Map<string, string[]>();
  for (const run of started.ok ? started.routines : []) {
    if (run.model === undefined) continue;
    const list = used.get(run.model) ?? [];
    list.push(run.loaded.routine.id);
    used.set(run.model, list);
  }
  const providers = providersSection(config, used, options);
  write(providers.lines);
  findings += providers.findings;

  const policy = policyLines(config.policy);
  write(policy);
  const policyFindings = policyFindingsOf(policy);

  if (!started.ok) {
    const { problem } = started;
    findings += 1;
    switch (problem.kind) {
      case 'routines':
        write([`${findingPrefix}${routinesProblemText(problem.problem)}`]);
        break;
      case 'credential_mixed':
        write([
          `${findingPrefix}${runnerStartTexts.credential_mixed(problem.routineId)}`,
        ]);
        break;
      case 'read_only_wiki':
        write([
          `${findingPrefix}${runnerStartTexts.read_only_wiki(problem.routineId)}`,
        ]);
        break;
      // The configuration passed above, and no routine is named.
      case 'config':
      case 'routine_unknown':
        break;
    }
    write([
      accountsSkippedText,
      resultText(findings, policyFindings),
      notCheckedText,
    ]);
    return exitCodes.dataError;
  }

  const { routines, refused, catalog } = started;
  write([routinesCountText(routines.length, refused.length)]);
  for (const item of refused) {
    findings += 1;
    write([`  ${findingPrefix}${refusedText(item)}`]);
  }

  const now = options.now?.() ?? systemClock.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (!isIsoDate(day) || config.stateDir === undefined) {
    throw new TypeError('The runner has no day or no folder of state.');
  }
  const read = await withReading(
    config,
    config.stateDir,
    options,
    async (reading) => ({
      ok: true as const,
      value: await checkAccounts({
        config,
        catalog,
        routines,
        refused,
        reading,
        day,
        createTransport: options.createTransport,
      }),
    }),
  );
  if (!read.ok) {
    // The audit file or the folder of the counters could not be used; the
    // text is on stderr.
    findings += 1;
    write([
      `${findingPrefix}${accountsNoAuditText}`,
      resultText(findings, policyFindings),
      notCheckedText,
    ]);
    return exitCodes.dataError;
  }
  const accounts = accountsSection(read.value);
  write(accounts.lines);
  findings += accounts.findings;

  write([resultText(findings, policyFindings), notCheckedText]);
  return findings === 0 ? exitCodes.ok : exitCodes.dataError;
}
