/**
 * `ecclium config check` (ADR 0055): loads the configuration for the
 * operation over stdio and writes the report to stdout. It never asks
 * ChurchTools, and its exit code tells whether the configuration is valid.
 *
 * @packageDocumentation
 */
import {
  type ConfigResult,
  type ConfigSources,
  loadConfig,
  type TokenFileSystem,
} from '@ecclium/mcp-churchtools-core';

import { exitCodes } from '../exit-codes.js';
import { type Output, renderConfigReport } from '../output/index.js';

/** Options of {@link checkConfig}. */
export interface ConfigCheckOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * The options Node.js was started with, so that the report shows the
   * same notices for the options of TLS as the start over stdio.
   */
  readonly execArgv: readonly string[];
  /** Shows the host and a subject other than the default. */
  readonly showValues: boolean;
  readonly output: Output;
  /** Replaces the file functions for the token file, for tests. */
  readonly tokenFiles?: TokenFileSystem | undefined;
  /** Replaces the loader, for tests. */
  readonly load?: ((sources: ConfigSources) => ConfigResult) | undefined;
}

/**
 * Checks the configuration and writes the report. A failed write changes
 * nothing: the exit code tells the validity even when the reader of stdout
 * is gone.
 *
 * @param options - The environment, the masking and the output.
 * @returns 0 for a valid configuration, 78 for an invalid one.
 * @throws {TypeError} When the loader throws or its report is
 *   inconsistent; the command line turns that into an internal error.
 * @example
 * ```ts
 * checkConfig({
 *   environment,
 *   execArgv,
 *   showValues: false,
 *   output: createOutput(),
 * });
 * ```
 */
export function checkConfig(
  options: ConfigCheckOptions,
): typeof exitCodes.ok | typeof exitCodes.invalidConfig {
  const load = options.load ?? loadConfig;
  const result = load({
    environment: options.environment,
    transport: 'stdio',
    execArgv: options.execArgv,
    tokenFiles: options.tokenFiles,
  });
  // Rendered whole before the first line goes out, so that an
  // inconsistent report never leaves half a report on stdout.
  const lines = renderConfigReport(result.report, {
    valid: result.ok,
    showValues: options.showValues,
  });
  for (const line of lines) options.output.stdout(line);
  return result.ok ? exitCodes.ok : exitCodes.invalidConfig;
}
