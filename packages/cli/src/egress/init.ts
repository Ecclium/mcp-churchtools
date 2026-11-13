/**
 * `ecclium init egress` (ADR 0035): writes the list of targets for the
 * template of Squid to stdout, as lines `acl` only. The operator sends the
 * output into the file the template includes. Like `ecclium policy init`
 * it changes no file, and like `ecclium config check --runner` it asks
 * nothing over the network, not even the proxy, whose list does not exist
 * yet.
 *
 * Why the configuration of the runner: only it reads the file of the
 * ping, whose host the list must name. On any problem nothing reaches
 * stdout, so that a redirect never gets half a list.
 *
 * Its exit code follows sysexits: 0 when the list is written, 74 when it
 * did not reach stdout whole, 78 for an invalid configuration or a target
 * the template could never pass.
 *
 * @packageDocumentation
 */
import {
  type ConfigResult,
  type ConfigSources,
  loadConfig,
} from '@ecclium/mcp-churchtools-core';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import { problemText, warningText } from '../messages/index.js';
import type { Output } from '../output/index.js';
import { egressWarnings } from '../runner/start.js';
import { egressTargetsOf, renderEgressAcl } from './acl.js';
import { egressInitTexts } from './texts.js';

/** Options of {@link initEgress}. */
export interface EgressInitOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The options Node.js was started with, for the options of TLS. */
  readonly execArgv: readonly string[];
  readonly output: Output;
  /** Replaces the loader, for tests. */
  readonly load?: ((sources: ConfigSources) => ConfigResult) | undefined;
}

/**
 * Writes the list of targets of the proxy.
 *
 * @param options - Environment, options of Node.js, output and a loader
 *   for tests.
 * @returns 0, 74 or 78, see above.
 * @throws {TypeError} Only for an internal error; the command line turns
 *   it into one.
 * @example
 * ```ts
 * const code = initEgress({ environment, execArgv, output: createOutput() });
 * ```
 */
export function initEgress(options: EgressInitOptions): ExitCode {
  const { output } = options;
  const loaded = (options.load ?? loadConfig)({
    environment: options.environment,
    transport: 'runner',
    execArgv: options.execArgv,
  });
  if (!loaded.ok) {
    for (const problem of loaded.report.problems) {
      output.stderr(problemText(problem));
    }
    output.stderr(egressInitTexts.config_invalid);
    return exitCodes.invalidConfig;
  }
  // The same warnings about the proxy as at the start of the runner.
  for (const code of loaded.report.warnings) {
    if (egressWarnings.includes(code)) output.stderr(warningText(code));
  }
  const found = egressTargetsOf(loaded.config);
  if (!found.ok) {
    output.stderr(egressInitTexts.port(found.roles));
    return exitCodes.invalidConfig;
  }
  // Rendered and checked whole before the first line goes out.
  const lines = renderEgressAcl(found.targets);
  for (const line of lines) {
    if (!output.stdout(line)) {
      output.stderr(egressInitTexts.output_cut);
      return exitCodes.ioError;
    }
  }
  return exitCodes.ok;
}
