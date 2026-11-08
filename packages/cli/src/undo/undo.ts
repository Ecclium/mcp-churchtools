/**
 * `ecclium undo <Kennung> [--overwrite]` (ADR 0031): takes back a write of
 * Ecclium from its snapshot, for the operator.
 *
 * Where it stands in the way of a write: a write of the core kept an
 * encrypted snapshot of what it changes right before its send, under the
 * ID of its audit line, which the result of the write tool names as
 * `undoId`. This command loads that snapshot through the same pipeline as
 * the server and lets the write guard write the state from before back:
 * the text of a page, for a new page a fixed sentence that it was taken
 * back, the fields of an appointment, and for a new appointment or booking
 * request a delete. It runs in the mode `operator` with the identity of
 * the start over stdio, so its write stands in the audit file as a line of
 * the type `undo`. A write back keeps a snapshot of its own and can be
 * taken back as well; a delete cannot.
 *
 * It shows what it changes, as a diff made safe for the terminal, the
 * texts of ChurchTools being foreign text: after it wrote, instead of
 * writing when someone changed the target since the write, and when the
 * outcome is unknown after the send. A changed page or appointment it
 * writes only with `--overwrite`; without it, it ends with 65. A new
 * appointment or booking that someone changed it never deletes. The ID is
 * checked as a UUID before any file is touched and named in no text.
 *
 * Its exit code follows sysexits, as `texts.ts` maps each case: 0 when
 * the write is taken back or nothing is left to do; 64 for a wrong call;
 * 65 when the target changed, changes in between, was empty before or
 * ChurchTools refuses the undo; 66 without a snapshot, with snapshots off,
 * for a new page, appointment or booking without its ID or a target that
 * is gone; 69 when ChurchTools was not reached or the outcome is unknown;
 * 70 for an internal error; 74 when the audit file cannot take the line,
 * the snapshot of the undo could not be kept, or the line of an undo that
 * may have written did not reach the audit file; 77 when writing is off,
 * switched off or blocked, a right is missing, the token is refused, the
 * page is no Markdown page, the appointment has parts Ecclium does not
 * change, lasts whole days or would move while the account of the server
 * did not create it, or the clock differs; and 78 for an invalid
 * configuration or a folder that cannot be used.
 *
 * @packageDocumentation
 */
import {
  type ConfigResult,
  type ConfigSources,
  createStdioIdentity,
  createStdioTenantResolver,
  crLfMarker,
  type LineDiff,
  loadConfig,
  noLineEndMarker,
  renderDiff,
  type ToolRequest,
  type UndoOutcome,
} from '@ecclium/mcp-churchtools-core';
import {
  anchorEventOf,
  createLogger,
  createStderrWriter,
  openAuditFile,
  prepareDayKeyFolder,
  prepareQuotaFolder,
  prepareSnapshotFolder,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';

import { composeToolPipeline } from '../compose/pipeline.js';
import { privateFileCodeOf } from '../compose/private-file-code.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  auditFileMessage,
  dayKeyFolderMessage,
  type Message,
  problemText,
  quotaFolderMessage,
  snapshotFolderMessage,
} from '../messages/index.js';
import { type Output, terminalLines, usageLine } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import { createStdioCatalog } from '../stdio/catalog.js';
import {
  changedLineOf,
  deletedLines,
  doneLines,
  failedEnding,
  incompleteEnding,
  outputCutText,
  type UndoEnding,
  undoChangedOf,
  undoMissing,
  undoProblems,
  undoUnchangedOf,
  undoUnrecordedOf,
  wouldChangeLineOf,
} from './texts.js';

/** Options of {@link undoWrite}. */
export interface UndoOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /** The options Node.js was started with, for the options of TLS. */
  readonly execArgv: readonly string[];
  /** The ID of the write as given, checked before anything else. */
  readonly eventId: string;
  /** Whether `--overwrite` was given. */
  readonly overwrite: boolean;
  readonly output: Output;
  /** Replaces the loader, for tests. */
  readonly load?: ((sources: ConfigSources) => ConfigResult) | undefined;
  /** Replaces `writeSync` of the stderr writer of the logs, for tests. */
  readonly writeSync?: WriteSyncFn | undefined;
  /**
   * Replaces the factory of the transport, such as with the test double of
   * ChurchTools, for tests.
   */
  readonly createTransport?:
    ((options: HttpTransportOptions) => HttpTransport) | undefined;
}

// The ID of an audit line as Ecclium draws it, in lower case.
const eventIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The highest count a log line takes.
const maxCount = 1_000_000;

// The two marks of the renderer in German: they stand on lines of their
// own after the line they mark, so page text cannot fake them.
const marks: Readonly<Record<string, string>> = Object.freeze({
  [noLineEndMarker]: '\\ ohne Zeilenumbruch am Ende',
  [crLfMarker]: '\\ Zeile endet mit CR LF',
});

// Writes the lines of a diff, each made safe for the terminal, after the
// line that says what it shows. Gives false when stdout took not all.
const writeDiff = (
  output: Output,
  heading: string,
  diff: LineDiff,
): boolean => {
  if (!output.stdout(heading)) return false;
  for (const line of renderDiff(diff)) {
    const mark = Object.hasOwn(marks, line) ? marks[line] : undefined;
    if (mark !== undefined) {
      if (!output.stdout(mark)) return false;
      continue;
    }
    for (const shown of terminalLines('', line)) {
      if (!output.stdout(shown)) return false;
    }
  }
  return true;
};

// A text of the start about a file or folder it could not use, said of
// the undo: it stops before it writes, as the start stops before it
// serves.
const undoText = (message: Message): string =>
  `${message.what.replace(', und der Start bricht ab.', ', und Ecclium nimmt nichts zurück.')} ${message.why} ${message.action}`;

// Ends the command with a text on stderr, or on stdout for one that says
// the work is done.
const finish = (output: Output, ended: UndoEnding): ExitCode => {
  if (ended.code === exitCodes.ok) output.stdout(ended.text);
  else output.stderr(ended.text);
  return ended.code;
};

/**
 * Writes what the command says for the outcome of the pipeline: the diff
 * and the result on stdout, a problem on stderr. An undo that may have
 * written without its line in the audit file ends with 74 after its own
 * text, whatever it was.
 *
 * @param output - The output of the command.
 * @param outcome - The outcome of the undo of the pipeline.
 * @returns The exit code.
 * @example
 * ```ts
 * return reportUndo(output, await pipeline.undo(call, request));
 * ```
 */
export function reportUndo(output: Output, outcome: UndoOutcome): ExitCode {
  const code = reportOf(output, outcome);
  if ('unrecorded' in outcome && outcome.unrecorded === true) {
    return finish(output, undoUnrecordedOf(outcome.subject ?? 'page'));
  }
  return code;
}

const reportOf = (output: Output, outcome: UndoOutcome): ExitCode => {
  switch (outcome.kind) {
    case 'done': {
      const { subject } = outcome;
      const shown = writeDiff(output, changedLineOf(subject), outcome.diff);
      for (const line of doneLines(subject, outcome.version, outcome.undoId)) {
        output.stdout(line);
      }
      if (!shown) output.stderr(outputCutText);
      return exitCodes.ok;
    }
    case 'deleted': {
      const { subject } = outcome;
      const shown = writeDiff(output, changedLineOf(subject), outcome.diff);
      for (const line of deletedLines(subject)) output.stdout(line);
      if (!shown) output.stderr(outputCutText);
      return exitCodes.ok;
    }
    case 'unchanged':
      return finish(output, undoUnchangedOf(outcome.subject));
    case 'changed':
      if (
        !writeDiff(output, wouldChangeLineOf(outcome.subject), outcome.diff)
      ) {
        output.stderr(outputCutText);
      }
      return finish(output, undoChangedOf(outcome.subject));
    case 'missing':
    case 'expired':
    case 'off':
      return finish(output, undoMissing[outcome.kind]);
    case 'incomplete':
      return finish(output, incompleteEnding(outcome.subject, outcome.placeId));
    case 'failed':
      // A diff of an undo that may have reached ChurchTools shows what it
      // was to write; one that was refused before shows nothing.
      if (outcome.sent && outcome.diff !== undefined) {
        const heading = wouldChangeLineOf(outcome.subject ?? 'page');
        if (!writeDiff(output, heading, outcome.diff)) {
          output.stderr(outputCutText);
        }
      }
      return finish(output, failedEnding(outcome));
  }
};

/**
 * Runs `ecclium undo`. Problems that end it before ChurchTools is asked go
 * to stderr; the diff and the result of an undo that wrote go to stdout.
 *
 * @param options - The environment, the ID, `--overwrite`, the output and
 *   the replacements for tests.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * const code = await undoWrite({ environment, execArgv, eventId, overwrite: false, output });
 * ```
 */
export async function undoWrite(options: UndoOptions): Promise<ExitCode> {
  const { output } = options;
  // The ID first, before any file or the configuration is read.
  if (!eventIdPattern.test(options.eventId)) {
    output.stderr(undoProblems.id_invalid.text);
    output.stderr(usageLine);
    return undoProblems.id_invalid.code;
  }
  const loaded = (options.load ?? loadConfig)({
    environment: options.environment,
    transport: 'stdio',
    execArgv: options.execArgv,
  });
  if (!loaded.ok) {
    for (const problem of loaded.report.problems) {
      output.stderr(problemText(problem));
    }
    return exitCodes.invalidConfig;
  }
  const { config } = loaded;
  // An undo writes: a server that only reads takes nothing back, and one
  // that keeps no snapshots would give the undo none of its own.
  if (config.readOnly) return finish(output, undoProblems.read_only);
  const { stateDir, keysDir } = config;
  if (stateDir === undefined) {
    return finish(output, undoProblems.state_dir_missing);
  }
  if (!config.snapshots) return finish(output, undoProblems.snapshots_off);
  const clock = systemClock;
  const opened = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!opened.ok) {
    output.stderr(undoText(auditFileMessage(opened.code)));
    return exitCodes.invalidConfig;
  }
  const auditFile = opened.writer;
  let closing = (): void => undefined;
  try {
    // The folders the start over stdio makes, so that the undo finds what
    // a write needs: the counters, the day keys and the snapshots, its own
    // included (ADR 0031, ADR 0063).
    const prepared = prepareQuotaFolder(stateDir);
    if (!prepared.ok) {
      output.stderr(undoText(quotaFolderMessage(prepared.code)));
      return exitCodes.invalidConfig;
    }
    try {
      // The loader asks for the folder of keys with ECCLIUM_READ_ONLY=false.
      prepareDayKeyFolder(keysDir as string, 'snapshot');
    } catch (error) {
      const code = privateFileCodeOf(error);
      if (code === undefined) throw error;
      output.stderr(undoText(dayKeyFolderMessage(code)));
      return exitCodes.invalidConfig;
    }
    try {
      prepareSnapshotFolder(stateDir);
    } catch (error) {
      const code = privateFileCodeOf(error);
      if (code === undefined) throw error;
      output.stderr(undoText(snapshotFolderMessage(code)));
      return exitCodes.invalidConfig;
    }
    const writer = createStderrWriter(
      options.writeSync === undefined ? {} : { writeSync: options.writeSync },
    );
    // The anchor of the chain of the audit file goes to the log when the
    // file closes, and before it the count of lines the file lost, as with
    // the server (ADR 0028).
    const processLogger = createLogger({ writer, clock, minLevel: 'info' });
    closing = () => {
      processLogger.info('audit_file_closed', {
        count: Math.min(auditFile.counts().failed, maxCount),
      });
    };
    const anchorLogger = createLogger({
      writer,
      clock,
      minLevel: 'info',
      anchors: true,
    });
    auditFile.attach({
      anchor: (anchor) => {
        const { file, seq, hash } = anchor;
        anchorLogger.info(anchorEventOf(anchor), { file, seq, hash });
      },
      swept: () => undefined,
    });
    const { pipeline, transport } = composeToolPipeline({
      config,
      catalog: createStdioCatalog(config),
      writer,
      clock,
      auditFile,
      createTransport: options.createTransport,
    });
    try {
      const assignment = await createStdioTenantResolver().resolve(
        createStdioIdentity(config),
      );
      // The mode is a literal of the command, never taken from the
      // configuration or a request (ADR 0024).
      const request: ToolRequest = Object.freeze({
        assignment,
        mode: 'operator',
        redaction: config.redaction,
        readOnly: false,
        features: Object.freeze([]),
        signal: new AbortController().signal,
      });
      const outcome = await pipeline.undo(
        { eventId: options.eventId, overwrite: options.overwrite },
        request,
      );
      return reportUndo(output, outcome);
    } finally {
      await transport.close().catch(() => undefined);
    }
  } finally {
    closing();
    auditFile.close();
  }
}
