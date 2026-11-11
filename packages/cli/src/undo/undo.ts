/**
 * `ecclium undo <Kennung> [--overwrite]` and `ecclium undo --run <Lauf>
 * [--overwrite]` (ADR 0031): takes back a write of Ecclium, or every write
 * of a run of a routine, from its snapshot, for the operator.
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
 * A run of a routine writes itself or through the approval of an entry it
 * queued. Which run a write belongs to, the command reads from the audit
 * files of the days whose writes can still have a snapshot, before it
 * writes anything: the write of a run is taken back with the account the
 * policy names for its routine, as the run wrote it, and never with the
 * token of the server, while it holds the lock of the routine (ADR 0033,
 * ADR 0034). With `--run` it takes back the writes of the run the newest
 * first and stops at the first that does not end with 0.
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
 * configuration or a folder that cannot be used. For a run besides: 66
 * when no line in the range names the run or it wrote nothing in
 * ChurchTools; 74 when an audit file cannot be read whole and a write of a
 * run may stand in it; 75 while a run of the routine holds its lock; and
 * 78 when the account of the routine has no token Ecclium accepts.
 *
 * @packageDocumentation
 */
import { hostname } from 'node:os';

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
  type ToolPipeline,
  type ToolRequest,
  type UndoOutcome,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditRunRef,
  type AuditRunWrite,
  findRunOfWrite,
  findRunWrites,
  openAuditFolder,
  runIdFromText,
} from '@ecclium/mcp-churchtools-core/audit';
import {
  anchorEventOf,
  createLogger,
  createRoutineLocks,
  createStderrWriter,
  createWriteHalt,
  openAuditFile,
  prepareDayKeyFolder,
  prepareQuotaFolder,
  prepareSnapshotFolder,
  queueRetentionDays,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { auditFolderTexts } from '../commands/audit-texts.js';
import { folderExitCodes } from '../commands/audit-verify.js';
import { composeToolPipeline } from '../compose/pipeline.js';
import { privateFileCodeOf } from '../compose/private-file-code.js';
import { snapshotRetentionDays } from '../compose/retention.js';
import { composeRunPipeline } from '../compose/run-pipeline.js';
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
  notSentLine,
  outputCutText,
  runDoneLine,
  runWriteLine,
  stoppedLine,
  undecidedLine,
  undoAccountEnding,
  type UndoEnding,
  undoChangedOf,
  undoMissing,
  type UndoProblem,
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
  /**
   * The ID of the write as given, checked before anything else. Without
   * it, `runId` names a run.
   */
  readonly eventId?: string | undefined;
  /**
   * The ID of a run as given with `--run`, checked before anything else:
   * every write of the run is taken back, the newest first.
   */
  readonly runId?: string | undefined;
  /** Whether `--overwrite` was given. */
  readonly overwrite: boolean;
  readonly output: Output;
  /** Replaces the clock, for tests. */
  readonly clock?: Clock | undefined;
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

// A day in UTC has no change of the clock.
const dayMs = 86_400_000;

/**
 * The first UTC day of the audit files that can name a write with a
 * snapshot left: the snapshots of the last 30 days, and for an approval
 * the line of the run that queued its entry up to 14 days before.
 *
 * @param now - Milliseconds since the Unix epoch, from the clock.
 * @returns The day, such as `2026-09-27`.
 * @example
 * ```ts
 * firstUndoDay(Date.UTC(2026, 10, 11, 7)); // '2026-09-27'
 * ```
 */
export const firstUndoDay = (now: number): string =>
  new Date(now - (snapshotRetentionDays + queueRetentionDays + 1) * dayMs)
    .toISOString()
    .slice(0, 10);

// Ends the command before ChurchTools is asked, with a problem on stderr.
const refuse = (output: Output, problem: UndoProblem): ExitCode =>
  finish(output, undoProblems[problem]);

/** What the undo takes back: one write, or every write of a run. */
type UndoTarget =
  | {
      readonly kind: 'write';
      readonly eventId: string;
      /** The run of the write, if it belongs to one. */
      readonly run?: AuditRunRef;
    }
  | {
      readonly kind: 'run';
      readonly run: AuditRunRef;
      /** The writes of the run, the newest first. */
      readonly written: readonly AuditRunWrite[];
      /** The entries it queued with no decision in the audit. */
      readonly undecided: readonly string[];
    };

/**
 * Runs `ecclium undo`. Problems that end it before ChurchTools is asked go
 * to stderr; the diff and the result of an undo that wrote go to stdout.
 * With `runId` it takes back every write of the run, its own and those of
 * the approvals of what it queued, the newest first, and stops at the
 * first that does not end with 0, since an older one would write over a
 * newer state. The write of a run, alone or with its run, is taken back
 * with the account of its routine, never with the token of the server,
 * while the lock of the routine keeps a run of it from writing in between
 * (ADR 0031, ADR 0033).
 *
 * @param options - The environment, the ID of a write or of a run,
 *   `--overwrite`, the output and the replacements for tests.
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
  const runId =
    options.runId === undefined ? undefined : runIdFromText(options.runId);
  if (options.runId !== undefined) {
    if (runId === undefined) {
      output.stderr(undoProblems.run_invalid.text);
      output.stderr(usageLine);
      return undoProblems.run_invalid.code;
    }
  } else if (!eventIdPattern.test(options.eventId ?? '')) {
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
  if (config.readOnly) return refuse(output, 'read_only');
  const { stateDir, keysDir } = config;
  if (stateDir === undefined) return refuse(output, 'state_dir_missing');
  if (!config.snapshots) return refuse(output, 'snapshots_off');
  const clock = options.clock ?? systemClock;

  // Which run the write belongs to, from the audit files, before anything
  // is written: its write is taken back with the account of its routine
  // (ADR 0033). Only the days whose writes can have a snapshot are read.
  const since = firstUndoDay(clock.now());
  let target: UndoTarget;
  if (runId !== undefined) {
    const found = runTargetOf(output, stateDir, runId, since);
    if (typeof found === 'number') return found;
    target = found;
  } else {
    const opened = openAuditFolder({ stateDir });
    const eventId = options.eventId as string;
    let run: AuditRunRef | undefined;
    // Without the folder, no write of a run has a line: as before, the
    // undo needs the folder only to write its own line.
    if (opened.ok) {
      const found = findRunOfWrite({ folder: opened.folder, eventId, since });
      // A write of a run never goes back with the token of the server: when
      // the files cannot tell, nothing is taken back (ADR 0033).
      if (found.kind === 'unknown') {
        return refuse(
          output,
          found.reason === 'incomplete' ? 'audit_incomplete' : 'queued_missing',
        );
      }
      run = found.kind === 'run' ? found.run : undefined;
    } else if (opened.code !== 'audit_folder_missing') {
      output.stderr(auditFolderTexts[opened.code]);
      return folderExitCodes[opened.code];
    }
    target = { kind: 'write', eventId, ...(run === undefined ? {} : { run }) };
  }

  const auditOpened = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!auditOpened.ok) {
    output.stderr(undoText(auditFileMessage(auditOpened.code)));
    return exitCodes.invalidConfig;
  }
  const auditFile = auditOpened.writer;
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
    const composeOptions = {
      config,
      catalog: createStdioCatalog(config),
      writer,
      clock,
      auditFile,
      createTransport: options.createTransport,
    };
    // The mode is a literal of the command, never taken from the
    // configuration or a request (ADR 0024).
    const requestOf = async (): Promise<ToolRequest> =>
      Object.freeze({
        assignment: await createStdioTenantResolver().resolve(
          createStdioIdentity(config),
        ),
        mode: 'operator',
        redaction: config.redaction,
        readOnly: false,
        features: Object.freeze([]),
        signal: new AbortController().signal,
      });
    if (target.kind === 'write' && target.run === undefined) {
      const { pipeline, transport } = composeToolPipeline(composeOptions);
      try {
        const outcome = await pipeline.undo(
          { eventId: target.eventId, overwrite: options.overwrite },
          await requestOf(),
        );
        return reportUndo(output, outcome);
      } finally {
        await transport.close().catch(() => undefined);
      }
    }
    const run = target.run as AuditRunRef;
    // The lock of the routine, so that no run of it writes while its
    // writes are taken back (ADR 0034).
    const lock = createRoutineLocks({
      stateDir,
      clock,
      pid: process.pid,
      host: hostname(),
    }).acquire(run.routineId);
    if (lock.kind === 'busy') return refuse(output, 'routine_busy');
    if (lock.kind === 'failed') return refuse(output, 'routine_lock_failed');
    try {
      // The account of the routine, never the token of the server: a
      // routine the policy no longer names takes nothing back (ADR 0033).
      const built = composeRunPipeline({
        ...composeOptions,
        routineId: run.routineId,
        writeHalt: createWriteHalt(),
        requireAccount: true,
      });
      if (!built.ok) return finish(output, undoAccountEnding(built.code));
      try {
        const request = await requestOf();
        if (target.kind === 'write') {
          return reportUndo(
            output,
            await built.pipeline.undo(
              { eventId: target.eventId, overwrite: options.overwrite, run },
              request,
            ),
          );
        }
        // Read again under the lock: a run that still ran when the files
        // were read first may have written since (ADR 0034).
        const again = runTargetOf(output, stateDir, run.runId, since);
        if (typeof again === 'number') return again;
        return await undoRun(output, built.pipeline, request, {
          run,
          written: again.written,
          undecided: again.undecided,
          overwrite: options.overwrite,
        });
      } finally {
        await built.close().catch(() => undefined);
      }
    } finally {
      lock.release();
    }
  } finally {
    closing();
    auditFile.close();
  }
}

// The writes of a run from the audit files of the range, or the exit code
// after the text that says why none are taken back: a folder that cannot
// be read, a file or a line that cannot be read whole, which may hold a
// write of the run, a run no line names, or one that wrote nothing.
const runTargetOf = (
  output: Output,
  stateDir: string,
  runId: string,
  since: string,
): Extract<UndoTarget, { kind: 'run' }> | ExitCode => {
  const opened = openAuditFolder({ stateDir });
  if (!opened.ok) {
    if (opened.code === 'audit_folder_missing') {
      return refuse(output, 'run_unknown');
    }
    output.stderr(auditFolderTexts[opened.code]);
    return folderExitCodes[opened.code];
  }
  const found = findRunWrites({ folder: opened.folder, runId, since });
  if (found.moved || found.unread > 0 || found.skipped > 0) {
    return refuse(output, 'audit_incomplete');
  }
  const { routineId } = found;
  if (routineId === undefined) return refuse(output, 'run_unknown');
  if (found.written.length === 0) {
    for (const queueId of found.undecided) {
      output.stdout(undecidedLine(queueId));
    }
    return refuse(output, 'run_nothing_written');
  }
  return {
    kind: 'run',
    run: Object.freeze({ runId, routineId }),
    written: found.written,
    undecided: found.undecided,
  };
};

// Takes back every write of a run, the newest first, and stops at the
// first that does not end with 0. A write that ended before its send has
// no snapshot and nothing to take back.
const undoRun = async (
  output: Output,
  pipeline: ToolPipeline,
  request: ToolRequest,
  what: {
    readonly run: AuditRunRef;
    readonly written: readonly AuditRunWrite[];
    readonly undecided: readonly string[];
    readonly overwrite: boolean;
  },
): Promise<ExitCode> => {
  const { run, written, undecided, overwrite } = what;
  let code: ExitCode = exitCodes.ok;
  // The writes taken back or found as before, not those that sent nothing.
  let done = 0;
  for (const [index, write] of written.entries()) {
    output.stdout(runWriteLine(write));
    const outcome = await pipeline.undo(
      { eventId: write.eventId, overwrite, run },
      request,
    );
    if (outcome.kind === 'missing' && write.writeState !== 'verified') {
      output.stdout(notSentLine);
      continue;
    }
    code = reportUndo(output, outcome);
    if (code !== exitCodes.ok) {
      const left = written.length - index - 1;
      if (left > 0) output.stderr(stoppedLine(left));
      break;
    }
    done += 1;
  }
  for (const queueId of undecided) output.stdout(undecidedLine(queueId));
  if (code !== exitCodes.ok) return code;
  if (done === 0) return refuse(output, 'run_nothing_written');
  output.stdout(runDoneLine(done));
  return exitCodes.ok;
};
