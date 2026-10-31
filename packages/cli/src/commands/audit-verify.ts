/**
 * `ecclium audit verify` (ADR 0028): checks every audit file in the folder
 * `audit` against its chain and, with `--log`, against the anchors in a
 * log. It only reads. Its exit code follows sysexits: 0 when chains and
 * anchors agree, 65 for a finding, 66 when the folder `audit` or a log is
 * missing or cannot be read, 74 when a file could not be read whole and
 * nothing else was found, 78 for an invalid configuration.
 *
 * @packageDocumentation
 */
import type { StateDirFileSystem } from '@ecclium/mcp-churchtools-core';
import {
  type AuditAnchorSet,
  type AuditFolderCode,
  createAnchorCollector,
  loadAuditConfig,
  maxLogLineLength,
  openAuditFolder,
  systemClock,
  verifyAuditFiles,
} from '@ecclium/mcp-churchtools-core/audit';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import type { Output } from '../output/index.js';
import {
  auditFolderTexts,
  hasDataFinding,
  logUnreadableText,
  problemLines,
  renderVerifyReport,
} from './audit-texts.js';
import { type LogFileSystem, readLogLines } from './log-lines.js';

/** Options of {@link verifyAudit}. */
export interface AuditVerifyOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /** The logs with anchors, paths or `-` for stdin, in the given order. */
  readonly logs: readonly string[];
  readonly output: Output;
  /** Replaces the clock, for tests. */
  readonly clock?: Clock | undefined;
  /** Replaces the file functions for the folder of state, for tests. */
  readonly stateDirFiles?: StateDirFileSystem | undefined;
  /** Replaces the file functions for the logs, for tests. */
  readonly logFiles?: LogFileSystem | undefined;
}

/**
 * The exit code for a folder `audit` that cannot be read: missing is no
 * input, a folder that fails a check or a platform without the checks is
 * a configuration the start refuses as well.
 */
export const folderExitCodes: Readonly<Record<AuditFolderCode, ExitCode>> =
  Object.freeze({
    audit_read_platform: exitCodes.invalidConfig,
    audit_folder_missing: exitCodes.noInput,
    audit_folder_unsafe: exitCodes.invalidConfig,
    audit_folder_unavailable: exitCodes.ioError,
  });

/**
 * Runs `ecclium audit verify`. The report goes to stdout, a problem that
 * stops the check to stderr. A failed write changes nothing: the exit code
 * tells the result even when the reader of stdout is gone.
 *
 * @param options - The environment, the logs and the output.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * verifyAudit({ environment, logs: ['-'], output: createOutput() });
 * ```
 */
export function verifyAudit(options: AuditVerifyOptions): ExitCode {
  const { output } = options;
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

  let anchors: AuditAnchorSet | undefined;
  if (options.logs.length > 0) {
    const collector = createAnchorCollector();
    for (const source of options.logs) {
      const read = readLogLines(
        source,
        maxLogLineLength,
        (line) => {
          collector.add(line);
        },
        options.logFiles,
      );
      if (!read) {
        output.stderr(logUnreadableText);
        return exitCodes.noInput;
      }
    }
    anchors = collector.result();
  }

  const opened = openAuditFolder({ stateDir: loaded.config.stateDir });
  if (!opened.ok) {
    output.stderr(auditFolderTexts[opened.code]);
    return folderExitCodes[opened.code];
  }
  const report = verifyAuditFiles({
    folder: opened.folder,
    anchors,
    retentionMonths: loaded.config.auditRetentionMonths,
    clock: options.clock ?? systemClock,
  });
  // Rendered whole before the first line goes out.
  const lines = renderVerifyReport(report, anchors);
  for (const line of lines) output.stdout(line);
  if (hasDataFinding(report)) return exitCodes.dataError;
  return report.findings.length > 0 ? exitCodes.ioError : exitCodes.ok;
}
