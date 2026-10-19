/**
 * Start of the stdio mode in the command line: it composes the server for a
 * process whose stdout belongs to the MCP protocol. Like the stdio part of
 * the server, it must not reach the output module of the command line
 * (ADR 0053).
 *
 * The start runs in two stages (ADR 0054, ADR 0055). This first stage takes
 * over the environment, refuses every argument, loads the configuration,
 * builds the catalog of tools and writes the start notices, all before the
 * server, its SDK and undici load, which make fd 2 non-blocking. So the
 * notices go out on a descriptor that still blocks, and an invalid
 * configuration or a refusal of the registry ends the start without them.
 * Only then does it load the second stage, `serve.ts`, with `import()`.
 * Importing this module starts nothing.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import {
  loadConfig,
  type RefusalReason,
  refusalReasons,
  RegistryRefusal,
  type ToolCatalog,
  tokenVariableName,
} from '@ecclium/mcp-churchtools-core';

import { takeEnvironment } from '../environment.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  type MessageText,
  problemText,
  refusalText,
  startText,
  warningText,
} from '../messages/index.js';
import { writeNotices } from '../notices/index.js';
import type { WriteSyncFn } from '../send.js';
import { createStdioCatalog } from './catalog.js';
import type { ServeReplacements } from './serve.js';

/** Replacements for tests. */
export interface StdioStartOptions extends ServeReplacements {
  /**
   * Replaces `writeSync` from `node:fs`, for the start notices and the
   * stderr writer.
   */
  readonly writeSync?: WriteSyncFn;
}

// The reason of a refusal of the registry, read as an own data property of
// a refusal of core. Any other value gives undefined, and the start then
// reports an internal error.
const refusalOf = (error: unknown): RefusalReason | undefined => {
  if (
    typeof error !== 'object' ||
    error === null ||
    isProxy(error) ||
    !(error instanceof RegistryRefusal)
  ) {
    return undefined;
  }
  const reason: unknown = Object.getOwnPropertyDescriptor(
    error,
    'reason',
  )?.value;
  return refusalReasons.find((known) => known === reason);
};

/**
 * Starts the server over stdio. It removes the token from the environment
 * first, in every spelling of its name, so that child processes and other
 * code no longer see it, also when the start ends early. Every argument is
 * refused with a fixed text that repeats none of them, without parsing
 * them. The problems and warnings of the configuration, and a refusal of
 * the registry, go out as start notices in German before anything else
 * writes to stderr. Until the stderr writer exists, everything is caught:
 * an internal error gives one fixed notice and 70, never a stack or a
 * message.
 *
 * @param args - The arguments after `ecclium stdio`.
 * @param environment - The environment of the process, which loses the
 *   token.
 * @param startOptions - Replacements for tests.
 * @returns 64 for an argument, 78 for an invalid configuration, 70 for a
 *   refusal of the registry or an internal error, or undefined once the
 *   server runs: the process then gets its exit code when the connection
 *   ends.
 * @example
 * ```ts
 * const code = await startStdio(args, environment);
 * if (code !== undefined) process.exitCode = code;
 * ```
 */
export async function startStdio(
  args: readonly string[],
  environment: Record<string, string | undefined>,
  startOptions: StdioStartOptions = {},
): Promise<ExitCode | undefined> {
  const { writeSync, ...replacements } = startOptions;
  const notices = (texts: readonly MessageText[]): boolean =>
    writeNotices(texts, writeSync === undefined ? {} : { writeSync }).torn;
  try {
    const taken = takeEnvironment(environment, [tokenVariableName]);
    if (!Array.isArray(args) || args.length > 0) {
      notices([startText('usage')]);
      return exitCodes.usage;
    }
    const loaded = loadConfig({ environment: taken, transport: 'stdio' });
    const texts = [
      ...loaded.report.problems.map((problem) => problemText(problem)),
      ...loaded.report.warnings.map((code) => warningText(code)),
    ];
    if (!loaded.ok) {
      notices(texts);
      return exitCodes.invalidConfig;
    }
    let catalog: ToolCatalog;
    try {
      catalog = createStdioCatalog(loaded.config);
    } catch (error) {
      const reason = refusalOf(error);
      if (reason === undefined) throw error;
      notices([...texts, refusalText(reason)]);
      return exitCodes.internal;
    }
    const torn = notices(texts);
    // Only now: the server, its SDK and undici make fd 2 non-blocking
    // while they load.
    const { serve } = await import('./serve.js');
    // Inside the catch as well: serve writes nothing before its stderr
    // writer and logger exist and catches every failure after them itself.
    return serve({
      ...replacements,
      ...(writeSync === undefined ? {} : { writeSync }),
      config: loaded.config,
      catalog,
      afterTornLine: torn,
    });
  } catch {
    // The thrown value is never looked at: its message or its properties
    // could hold a value of the configuration, and a proxy would run code.
    notices([startText('internal')]);
    return exitCodes.internal;
  }
}
