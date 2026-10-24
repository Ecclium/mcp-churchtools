/**
 * Start of the stdio mode in the command line: it composes the server for a
 * process whose stdout belongs to the MCP protocol. Like the stdio part of
 * the server, it must not reach the output module of the command line
 * (ADR 0053).
 *
 * The start runs in two stages (ADR 0054, ADR 0055). This first stage takes
 * over the environment, refuses every argument, loads the configuration,
 * builds the catalog of tools, opens the audit file and writes the start
 * notices, all before the server, its SDK and undici load, which make
 * fd 2 non-blocking. So the notices go out on a descriptor that still
 * blocks, and an invalid configuration, a refusal of the registry or an
 * audit file that cannot be opened ends the start without them.
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
  toolsetOf,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditFileWriter,
  openAuditFile,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';

import { takeEnvironment } from '../environment.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  auditFileText,
  emptyToolsetText,
  type MessageText,
  problemText,
  refusalText,
  startText,
  toolsetsText,
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
  /** Replaces the opener of the audit file. */
  readonly openAuditFile?: typeof openAuditFile;
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
 * them. The problems and warnings of the configuration, a refusal of the
 * registry, and the toolsets that are on, each one without a tool named,
 * go out as start notices in German before anything else writes to
 * stderr. With `ECCLIUM_STATE_DIR` it opens the audit file
 * before the notices; a tool with sensitivity special without the folder,
 * or a file that cannot be opened, ends the start with a notice and 78
 * (ADR 0028). Until the stderr writer exists, everything is caught: an
 * internal error gives one fixed notice and 70, never a stack or a
 * message, and closes an audit file that is already open.
 *
 * @param args - The arguments after `ecclium stdio`.
 * @param environment - The environment of the process, which loses the
 *   token.
 * @param execArgv - The options Node.js was started with, which the loader
 *   reads for the options of TLS.
 * @param startOptions - Replacements for tests.
 * @returns 64 for an argument, 78 for an invalid configuration or an
 *   audit file that is missing or cannot be opened, 70 for a refusal of
 *   the registry or an internal error, or undefined once the
 *   server runs: the process then gets its exit code when the connection
 *   ends.
 * @example
 * ```ts
 * const code = await startStdio(args, environment, execArgv);
 * if (code !== undefined) process.exitCode = code;
 * ```
 */
export async function startStdio(
  args: readonly string[],
  environment: Record<string, string | undefined>,
  execArgv: readonly string[],
  startOptions: StdioStartOptions = {},
): Promise<ExitCode | undefined> {
  const {
    writeSync,
    openAuditFile: open = openAuditFile,
    ...replacements
  } = startOptions;
  const notices = (texts: readonly MessageText[]): boolean =>
    writeNotices(texts, writeSync === undefined ? {} : { writeSync }).torn;
  let auditFile: AuditFileWriter | undefined;
  try {
    const taken = takeEnvironment(environment, [tokenVariableName]);
    if (!Array.isArray(args) || args.length > 0) {
      notices([startText('usage')]);
      return exitCodes.usage;
    }
    const loaded = loadConfig({
      environment: taken,
      transport: 'stdio',
      execArgv,
    });
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
    // Which toolsets are on, and each one that brings no tool of the
    // catalog, so that a toolset of a later version does not stay silent
    // (ADR 0062). Without a toolset the start says nothing more.
    const { toolsets } = loaded.config;
    if (toolsets.length > 0) texts.push(toolsetsText(toolsets));
    texts.push(
      ...toolsets
        .filter(
          (name) =>
            !catalog
              .list()
              .some((entry) => toolsetOf(entry.meta.domain) === name),
        )
        .map((name) => emptyToolsetText(name)),
    );
    // A tool with sensitivity special gives results only with its line in
    // the audit file, so it never runs without the folder (ADR 0028).
    const { stateDir } = loaded.config;
    if (
      stateDir === undefined &&
      catalog.list().some((entry) => entry.meta.sensitivity === 'special')
    ) {
      notices([...texts, startText('audit_file_required')]);
      return exitCodes.invalidConfig;
    }
    // Opened while fd 2 still blocks and before the notices, so that a
    // file that cannot be opened reports with them. Whoever sets the
    // folder wants the audit kept by the server, so the start stops then.
    if (stateDir !== undefined) {
      const opened = open({ stateDir, clock: systemClock, pid: process.pid });
      if (!opened.ok) {
        notices([...texts, auditFileText(opened.code)]);
        return exitCodes.invalidConfig;
      }
      auditFile = opened.writer;
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
      ...(auditFile === undefined ? {} : { auditFile }),
    });
  } catch {
    // The thrown value is never looked at: its message or its properties
    // could hold a value of the configuration, and a proxy would run code.
    // Closing twice is harmless, if serve closed the file already.
    auditFile?.close();
    notices([startText('internal')]);
    return exitCodes.internal;
  }
}
