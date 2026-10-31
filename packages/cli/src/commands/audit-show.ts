/**
 * `ecclium audit show` (ADR 0028): sums up the audit files for the people
 * who lead a congregation, per UTC day and tool, or with `--object` lists
 * the calls that name one ID, such as for a request for information. It
 * only reads and does not check the chains. Its exit code follows
 * sysexits: 0 when the output is written, 64 for a value of the wrong
 * form, 66 when the folder `audit` is missing, 74 when files could not be
 * read, 78 for an invalid configuration.
 *
 * @packageDocumentation
 */
import type { StateDirFileSystem } from '@ecclium/mcp-churchtools-core';
import {
  isUtcDay,
  loadAuditConfig,
  objectRefFromText,
  openAuditFolder,
  summarizeAuditFiles,
} from '@ecclium/mcp-churchtools-core/audit';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import { type Output, usageLine } from '../output/index.js';
import {
  auditFolderTexts,
  auditShowProblemTexts,
  type AuditShowProblem,
  problemLines,
  renderObjectHits,
  renderSummary,
} from './audit-texts.js';
import { folderExitCodes } from './audit-verify.js';

/** Options of {@link showAudit}. */
export interface AuditShowOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /** The value of `--object`, as typed. */
  readonly object?: string | undefined;
  /** The value of `--since`, as typed. */
  readonly since?: string | undefined;
  /** The value of `--until`, as typed. */
  readonly until?: string | undefined;
  readonly output: Output;
  /** Replaces the file functions for the folder of state, for tests. */
  readonly stateDirFiles?: StateDirFileSystem | undefined;
}

/**
 * Runs `ecclium audit show`. The values are checked before the
 * configuration, and a wrong one is never repeated. The summary goes to
 * stdout, a problem that stops it to stderr.
 *
 * @param options - The environment, the values and the output.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * showAudit({ environment, object: 'person:42', output: createOutput() });
 * ```
 */
export function showAudit(options: AuditShowOptions): ExitCode {
  const { output, since, until } = options;
  const refuse = (problem: AuditShowProblem): ExitCode => {
    output.stderr(auditShowProblemTexts[problem]);
    output.stderr(usageLine);
    return exitCodes.usage;
  };
  const object =
    options.object === undefined
      ? undefined
      : objectRefFromText(options.object);
  if (options.object !== undefined && object === undefined) {
    return refuse('object');
  }
  if (
    (since !== undefined && !isUtcDay(since)) ||
    (until !== undefined && !isUtcDay(until))
  ) {
    return refuse('day');
  }
  if (since !== undefined && until !== undefined && since > until) {
    return refuse('range');
  }

  const loaded = loadAuditConfig({
    environment: options.environment,
    ...(options.stateDirFiles === undefined
      ? {}
      : { stateDirFiles: options.stateDirFiles }),
  });
  if (!loaded.ok) {
    for (const line of problemLines(loaded.problems, loaded.omittedProblems)) {
      output.stderr(line);
    }
    return exitCodes.invalidConfig;
  }
  const opened = openAuditFolder({ stateDir: loaded.config.stateDir });
  if (!opened.ok) {
    output.stderr(auditFolderTexts[opened.code]);
    return folderExitCodes[opened.code];
  }
  const summary = summarizeAuditFiles({
    folder: opened.folder,
    since,
    until,
    object,
  });
  const range = { since, until };
  // Rendered whole before the first line goes out.
  const lines =
    object === undefined
      ? renderSummary(summary, range)
      : renderObjectHits(summary, object, range);
  for (const line of lines) output.stdout(line);
  return summary.moved || summary.unread > 0 ? exitCodes.ioError : exitCodes.ok;
}
