/**
 * `ecclium queue list`, `ecclium queue show <Kennung>`,
 * `ecclium queue approve <Kennung>` and `ecclium queue reject <Kennung>`
 * (ADR 0029, ADR 0031): the queue of approvals for the operator.
 *
 * Where it stands in the way of a write: a write that no person could
 * confirm in the client, or that the policy sent there, waits as a sealed
 * entry under the ID of the audit line of its call, which the result of
 * the write tool names as `queueId`. These commands reach the queue
 * through the same pipeline as the server, in the mode `operator` with the
 * identity of the start over stdio: `list` shows every entry with its
 * summary and why it waits, `show` the whole diff of one, `reject` keeps
 * the decision, destroys the entry and writes a line of the type
 * `approval` into the audit file, and `approve` does the same and writes
 * at once: the core plans the write of the entry again from the state of
 * the target now, and writes it only when that plan is the one that was
 * queued. Only `approve` asks ChurchTools. Both decisions count in the
 * store of quotas first, so that no entry is decided twice. An entry a run
 * of a routine queued is written with the account the policy names for
 * the routine, as the run would have written it, and never with the token
 * of the server (ADR 0033).
 *
 * Which configuration: with `--runner` the commands load the configuration
 * of the runner, as the runner container contract asks of a command about
 * the runner (ADR 0036), and otherwise the one over stdio. The
 * configuration of the runner refuses the token of the server and holds
 * the own account of the runner in its place, on which no command falls
 * back. So
 * `approve` writes an entry of a run only with `--runner`, and with it
 * only an entry of a run; `list`, `show` and `reject` ask ChurchTools
 * nothing and work with both.
 *
 * What an entry and a page hold is text of ChurchTools and of the model,
 * shown made safe for the terminal. The ID given is checked as a UUID
 * before any file is touched and named in no text.
 *
 * Its exit code follows sysexits, as `texts.ts` maps each case: 0 when the
 * command did its work, `show` of a decided entry included; 64 for a wrong
 * call; 65 for a decision about an entry that was decided already, a
 * target that changed, or a text that is refused; 66 without an entry
 * under the ID or past its retention, or for an approval whose target is
 * gone in ChurchTools; 69 when ChurchTools was not reached
 * or the outcome of a write is unknown; 70 for an internal error; 74 when
 * the audit file cannot take the line, the state before a write could not
 * be kept, or the line of a decision did not reach it; 77 for a call the
 * core refused, a server that only reads included; and 78 for an invalid
 * configuration, a folder that is missing or cannot be used, an audit
 * file that cannot be opened, or the token of the account of a run that
 * cannot be read.
 *
 * @packageDocumentation
 */
import {
  type ConfigResult,
  type ConfigSources,
  createStdioIdentity,
  crLfMarker,
  noLineEndMarker,
  createStdioTenantResolver,
  type LineDiff,
  loadConfig,
  type ApproveOutcome,
  renderDiff,
  type QueueEntryContent,
  type QueueListing,
  type QueueListOutcome,
  type QueueShowOutcome,
  type RejectOutcome,
  type ToolPipeline,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditFileWriter,
  anchorEventOf,
  createLogger,
  createStderrWriter,
  openAuditFile,
  prepareDayKeyFolder,
  prepareQueueFolder,
  prepareQuotaFolder,
  prepareSnapshotFolder,
  systemClock,
  createWriteHalt,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { commandCatalogOf } from '../compose/catalog.js';
import { composeToolPipeline } from '../compose/pipeline.js';
import { composeRunPipeline } from '../compose/run-pipeline.js';
import { privateFileCodeOf } from '../compose/private-file-code.js';
import { keepsSnapshots } from '../compose/snapshots.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  auditFileMessage,
  dayKeyFolderMessage,
  type Message,
  problemText,
  queueFolderMessage,
  quotaFolderMessage,
  snapshotFolderMessage,
} from '../messages/index.js';
import { type Output, terminalLines, usageLine } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import {
  approvedDiffHeading,
  approvedLines,
  approvedUnrecorded,
  approveFailedEnding,
  decidedEnding,
  decisionWords,
  diffHeading,
  failedEnding,
  listEmpty,
  listFooter,
  listHeading,
  outputCutText,
  type QueueEnding,
  queueMissing,
  queueProblems,
  reasonTexts,
  rejectedEnding,
  rejectedUnrecorded,
  runAccountEnding,
  showFooterOf,
  timeOf,
  usedEnding,
  usedWords,
  wouldWriteHeading,
} from './texts.js';

/** What the command is asked to do. */
export type QueueAction = 'list' | 'show' | 'approve' | 'reject';

/** Options of {@link runQueue}. */
export interface QueueOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /** The options Node.js was started with, for the options of TLS. */
  readonly execArgv: readonly string[];
  /** What to do. */
  readonly action: QueueAction;
  /** The ID of the entry as given, for `show`, `approve` and `reject`. */
  readonly queueId?: string;
  /**
   * Whether `--runner` was given: the command then loads the configuration
   * of the runner, and `approve` writes only an entry of a run.
   */
  readonly runner?: boolean | undefined;
  readonly output: Output;
  /** Replaces the loader, for tests. */
  readonly load?: ((sources: ConfigSources) => ConfigResult) | undefined;
  /** Replaces `writeSync` of the stderr writer of the logs, for tests. */
  readonly writeSync?: WriteSyncFn | undefined;
  /** Replaces the factory of the transport, for tests. */
  readonly createTransport?:
    ((options: HttpTransportOptions) => HttpTransport) | undefined;
  /** Replaces the clock of the system, for tests. */
  readonly clock?: Clock | undefined;
}

// The ID of an audit line as Ecclium draws it, in lower case.
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The highest count a log line takes.
const maxCount = 1_000_000;

// A text of the start about a file it could not use, said of the queue.
const queueText = (message: Message): string =>
  `${message.what.replace(', und der Start bricht ab.', ', und der Befehl bricht ab.')} ${message.why} ${message.action}`;

// Ends the command with a text on stderr, or on stdout for one that says
// the work is done.
const finish = (output: Output, ended: QueueEnding): ExitCode => {
  if (ended.code === exitCodes.ok) output.stdout(ended.text);
  else output.stderr(ended.text);
  return ended.code;
};

// The two marks of the diff of the core in German: they stand on lines of
// their own after the line they mark, as for `ecclium undo`.
const marks: Readonly<Record<string, string>> = Object.freeze({
  [noLineEndMarker]: '\\ ohne Zeilenumbruch am Ende',
  [crLfMarker]: '\\ Zeile endet mit CR LF',
});

// Writes text of an entry line by line, made safe for the terminal. The
// core made it visible already when it queued the write, so its doubled
// backslashes stay as they are. Gives false when stdout took not all.
const writeForeign = (
  output: Output,
  prefix: string,
  text: string,
): boolean => {
  for (const line of text.split('\n')) {
    const mark = Object.hasOwn(marks, line) ? marks[line] : undefined;
    if (mark !== undefined) {
      if (!output.stdout(mark)) return false;
      continue;
    }
    for (const shown of terminalLines(prefix, line, true)) {
      if (!output.stdout(shown)) return false;
    }
  }
  return true;
};

// Writes the lines of a diff the core made of the target now, each made
// safe for the terminal: unlike the diff of an entry, its text was not
// made visible before. Gives false when stdout took not all.
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

const timeOfMs = (ms: number): string => timeOf(new Date(ms).toISOString());

const dayOf = (day: string): string =>
  `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

// What a write changes, in words; the key holds IDs, made safe when the
// line is written.
const targetOf = (target: QueueEntryContent['target']): string => {
  const [first = '', second = ''] = target.key.split('/');
  switch (target.kind) {
    case 'wiki_category':
      return `eine neue Seite in der Kategorie ${first} des Wikis`;
    case 'wiki_page':
      return `die Seite ${second} in der Kategorie ${first} des Wikis`;
    default:
      return `${target.kind} ${target.key}`;
  }
};

const reportList = (output: Output, outcome: QueueListOutcome): ExitCode => {
  if (outcome.kind === 'off') return finish(output, queueMissing.off);
  if (outcome.kind === 'failed') return finish(output, failedEnding(outcome));
  const { entries } = outcome;
  output.stdout(listHeading);
  if (entries.length === 0) {
    output.stdout(listEmpty);
    return exitCodes.ok;
  }
  let whole = true;
  for (const entry of entries) {
    whole = writeEntry(output, entry) && whole;
  }
  if (entries.some((entry) => entry.state === 'open')) {
    output.stdout(listFooter);
  }
  if (!whole) output.stderr(outputCutText);
  return exitCodes.ok;
};

const writeEntry = (output: Output, entry: QueueListing): boolean => {
  switch (entry.state) {
    case 'open': {
      const { content } = entry;
      output.stdout(
        `${entry.id}  ${timeOfMs(content.queuedAt)}  wartet auf Ihre Freigabe`,
      );
      const shown = writeForeign(output, '    ', content.summary);
      output.stdout(`    Grund: ${reasonTexts[content.reason]}`);
      return shown;
    }
    case 'expired':
      output.stdout(`${entry.id}  ${dayOf(entry.day)}  verfallen`);
      return true;
    case 'used':
      output.stdout(`${entry.id}  ${dayOf(entry.day)}  ${usedWords}`);
      return true;
    case 'damaged':
      output.stdout(
        `${entry.id}  ${dayOf(entry.day)}  lässt sich nicht öffnen und verfällt nach 14 Tagen`,
      );
      return true;
    case 'approved':
    case 'rejected':
      output.stdout(
        `${entry.id}  ${dayOf(entry.day)}  ${decisionWords[entry.state]} am ${timeOf(entry.decidedAt)}`,
      );
      return true;
  }
};

const reportShow = (output: Output, outcome: QueueShowOutcome): ExitCode => {
  switch (outcome.kind) {
    case 'missing':
    case 'expired':
    case 'off':
      return finish(output, queueMissing[outcome.kind]);
    case 'used':
      return finish(output, usedEnding(true));
    case 'decided':
      return finish(
        output,
        decidedEnding(outcome.decision, outcome.decidedAt, true),
      );
    case 'failed':
      return finish(output, failedEnding(outcome));
    case 'found':
      break;
  }
  const { content } = outcome;
  let whole = writeForeign(
    output,
    '',
    `Eingereiht am ${timeOfMs(content.queuedAt)} UTC von ‹${content.tool}›, für ${targetOf(content.target)}.`,
  );
  output.stdout(`Grund: ${reasonTexts[content.reason]}`);
  whole = writeForeign(output, '', content.summary) && whole;
  if (content.title !== undefined) {
    whole =
      writeForeign(output, 'Titel der neuen Seite: ', content.title) && whole;
  }
  output.stdout(diffHeading);
  for (const line of content.diff) {
    whole = writeForeign(output, '', line) && whole;
  }
  // An entry of a run is decided with the configuration of the runner.
  output.stdout(showFooterOf(content.run !== undefined));
  if (!whole) output.stderr(outputCutText);
  return exitCodes.ok;
};

// What `approve` says of an entry it cannot decide, from what `show` found:
// the same text the approval of the pipeline gives for it.
const unapprovableEnding = (
  shown: Exclude<QueueShowOutcome, { readonly kind: 'found' | 'failed' }>,
): QueueEnding => {
  switch (shown.kind) {
    case 'missing':
    case 'expired':
    case 'off':
      return queueMissing[shown.kind];
    case 'used':
      return usedEnding(false);
    case 'decided':
      return decidedEnding(shown.decision, undefined, false);
  }
};

const reportReject = (output: Output, outcome: RejectOutcome): ExitCode => {
  switch (outcome.kind) {
    case 'missing':
    case 'expired':
    case 'off':
      return finish(output, queueMissing[outcome.kind]);
    case 'used':
      return finish(output, usedEnding(false));
    case 'decided':
      return finish(output, decidedEnding(outcome.decision, undefined, false));
    case 'failed':
      return finish(output, failedEnding(outcome));
    case 'rejected':
      if (!writeForeign(output, 'Abgewiesen: ', outcome.summary)) {
        output.stderr(outputCutText);
      }
      return finish(
        output,
        outcome.unrecorded === true ? rejectedUnrecorded : rejectedEnding,
      );
  }
};

/**
 * Writes what `approve` says for the outcome of the pipeline: the summary,
 * the diff and the result on stdout, a problem on stderr. An approval that
 * kept its decision or may have written without its line in the audit
 * file ends with 74 after its own text, whatever it was.
 *
 * @param output - The output of the command.
 * @param outcome - The outcome of the approval of the pipeline.
 * @param runner - Whether the approval ran with the configuration of the
 *   runner, so that the line on its undo names `--runner`.
 * @returns The exit code.
 * @example
 * ```ts
 * return reportApprove(output, await pipeline.approve(call, request));
 * ```
 */
export function reportApprove(
  output: Output,
  outcome: ApproveOutcome,
  runner = false,
): ExitCode {
  const code = approveReportOf(output, outcome, runner);
  if ('unrecorded' in outcome && outcome.unrecorded === true) {
    return finish(output, approvedUnrecorded);
  }
  return code;
}

const approveReportOf = (
  output: Output,
  outcome: ApproveOutcome,
  runner: boolean,
): ExitCode => {
  switch (outcome.kind) {
    case 'missing':
    case 'expired':
    case 'off':
      return finish(output, queueMissing[outcome.kind]);
    case 'used':
      return finish(output, usedEnding(false));
    case 'decided':
      return finish(output, decidedEnding(outcome.decision, undefined, false));
    case 'failed':
      // The diff of a write that may have reached ChurchTools shows what
      // it was to write; one refused before shows nothing.
      if (outcome.sent && outcome.diff !== undefined) {
        if (!writeDiff(output, wouldWriteHeading, outcome.diff)) {
          output.stderr(outputCutText);
        }
      }
      return finish(output, approveFailedEnding(outcome));
    case 'approved': {
      let whole = writeForeign(output, 'Freigegeben: ', outcome.summary);
      whole = writeDiff(output, approvedDiffHeading, outcome.diff) && whole;
      for (const line of approvedLines(
        outcome.version,
        outcome.undoId,
        runner,
      )) {
        output.stdout(line);
      }
      if (!whole) output.stderr(outputCutText);
      return exitCodes.ok;
    }
  }
};

/**
 * Runs `ecclium queue`. Problems that end it before the queue is read go
 * to stderr; what it shows goes to stdout.
 *
 * @param options - The environment, the action, the ID, the output and the
 *   replacements for tests.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * const code = await runQueue({ environment, execArgv, action: 'list', output });
 * ```
 */
export async function runQueue(options: QueueOptions): Promise<ExitCode> {
  const { output, action } = options;
  // The ID first, before any file or the configuration is read.
  if (action !== 'list' && !idPattern.test(options.queueId ?? '')) {
    output.stderr(queueProblems.id_invalid.text);
    output.stderr(usageLine);
    return queueProblems.id_invalid.code;
  }
  // The kind is a literal of the call, never a guess from the variables
  // that are set (ADR 0036).
  const loaded = (options.load ?? loadConfig)({
    environment: options.environment,
    transport: options.runner === true ? 'runner' : 'stdio',
    execArgv: options.execArgv,
  });
  if (!loaded.ok) {
    for (const problem of loaded.report.problems) {
      output.stderr(problemText(problem));
    }
    return exitCodes.invalidConfig;
  }
  const { config } = loaded;
  // An approval writes: a server that only reads approves nothing.
  if (action === 'approve' && config.readOnly) {
    return finish(output, queueProblems.read_only);
  }
  const { stateDir, keysDir } = config;
  if (stateDir === undefined) {
    return finish(output, queueProblems.state_dir_missing);
  }
  if (keysDir === undefined) {
    return finish(output, queueProblems.keys_dir_missing);
  }
  // The folder of the queue, as the start prepares it, so that one that
  // cannot be used ends with its own text and 78, not as an internal error.
  try {
    prepareQueueFolder(stateDir);
  } catch (error) {
    const code = privateFileCodeOf(error);
    if (code === undefined) throw error;
    output.stderr(queueText(queueFolderMessage(code)));
    return exitCodes.invalidConfig;
  }
  const deciding = action === 'approve' || action === 'reject';
  if (deciding) {
    // A decision counts in the store of quotas first (ADR 0029), so its
    // folder as the start prepares it.
    const prepared = prepareQuotaFolder(stateDir);
    if (!prepared.ok) {
      output.stderr(queueText(quotaFolderMessage(prepared.code)));
      return exitCodes.invalidConfig;
    }
  }
  if (action === 'approve' && keepsSnapshots(config)) {
    // An approval writes and keeps a snapshot, as an undo does: the folders
    // of its day keys and its records (ADR 0031).
    try {
      prepareDayKeyFolder(keysDir, 'snapshot');
    } catch (error) {
      const code = privateFileCodeOf(error);
      if (code === undefined) throw error;
      output.stderr(queueText(dayKeyFolderMessage(code)));
      return exitCodes.invalidConfig;
    }
    try {
      prepareSnapshotFolder(stateDir);
    } catch (error) {
      const code = privateFileCodeOf(error);
      if (code === undefined) throw error;
      output.stderr(queueText(snapshotFolderMessage(code)));
      return exitCodes.invalidConfig;
    }
  }
  const clock = options.clock ?? systemClock;
  // Only a decision writes a line into the audit file; reading writes none.
  let auditFile: AuditFileWriter | undefined;
  if (deciding) {
    const opened = openAuditFile({
      stateDir,
      clock,
      pid: process.pid,
      retentionMonths: config.auditRetentionMonths,
    });
    if (!opened.ok) {
      output.stderr(queueText(auditFileMessage(opened.code)));
      return exitCodes.invalidConfig;
    }
    auditFile = opened.writer;
  }
  const writer = createStderrWriter(
    options.writeSync === undefined ? {} : { writeSync: options.writeSync },
  );
  let closing = (): void => undefined;
  if (auditFile !== undefined) {
    const file = auditFile;
    // The anchor of the chain goes to the log when the file closes, and
    // before it the count of lines the file lost, as with the server
    // (ADR 0028).
    const processLogger = createLogger({ writer, clock, minLevel: 'info' });
    closing = () => {
      processLogger.info('audit_file_closed', {
        count: Math.min(file.counts().failed, maxCount),
      });
    };
    const anchorLogger = createLogger({
      writer,
      clock,
      minLevel: 'info',
      anchors: true,
    });
    file.attach({
      anchor: (anchor) => {
        const { file: name, seq, hash } = anchor;
        anchorLogger.info(anchorEventOf(anchor), { file: name, seq, hash });
      },
      swept: () => undefined,
    });
  }
  try {
    const catalog = commandCatalogOf(config);
    // One halt of writes for both pipelines of the command.
    const writeHalt = createWriteHalt();
    const { pipeline, transport } = composeToolPipeline({
      config,
      catalog,
      writer,
      clock,
      auditFile,
      createTransport: options.createTransport,
      writeHalt,
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
        readOnly: config.readOnly,
        features: Object.freeze([]),
        signal: new AbortController().signal,
      });
      if (action === 'approve') {
        // An entry of a run is written with the account of its routine, as
        // the run would have written it, never with the token of the
        // server (ADR 0033). The entry names its routine; reading it asks
        // ChurchTools nothing.
        const shown = await pipeline.showQueue(
          { queueId: options.queueId },
          request,
        );
        // An entry that cannot be read now is not approved, so that one of
        // a run never reaches the pipeline with the token of the server.
        if (shown.kind === 'failed') {
          return finish(output, failedEnding(shown));
        }
        const routine =
          shown.kind === 'found' ? shown.content.run?.routine : undefined;
        const runner = config.transport === 'runner';
        // An entry of a run goes out only with the configuration of the
        // runner (ADR 0036); over stdio it is shown and rejected only.
        if (routine !== undefined && !runner) {
          return finish(output, queueProblems.run_needs_runner);
        }
        // With the configuration of the runner the pipeline of the command
        // holds the own account of the runner, on which the command never
        // falls back: an entry of no run ends here, and so does one that cannot
        // be approved, with the text the approval would give, before
        // anything is sent and, like every refusal of the command before
        // its pipeline, without a line in the audit.
        if (routine === undefined && runner) {
          return shown.kind === 'found'
            ? finish(output, queueProblems.entry_of_no_run)
            : finish(output, unapprovableEnding(shown));
        }
        if (routine !== undefined) {
          const built = composeRunPipeline({
            config,
            catalog,
            writer,
            clock,
            auditFile,
            createTransport: options.createTransport,
            routineId: routine,
            writeHalt,
            // Without ownAccount, an entry of a run whose routine lost its
            // entries in the policy since builds nothing, never a pipeline
            // with the own account of the runner (ADR 0036).
          });
          if (!built.ok) return finish(output, runAccountEnding(built.code));
          try {
            return await act(built.pipeline, request, options);
          } finally {
            await built.close().catch(() => undefined);
          }
        }
      }
      return await act(pipeline, request, options);
    } finally {
      await transport.close().catch(() => undefined);
    }
  } finally {
    closing();
    auditFile?.close();
  }
}

const act = async (
  pipeline: ToolPipeline,
  request: ToolRequest,
  options: QueueOptions,
): Promise<ExitCode> => {
  const { output } = options;
  const call = { queueId: options.queueId };
  switch (options.action) {
    case 'list':
      return reportList(output, await pipeline.listQueue(request));
    case 'show':
      return reportShow(output, await pipeline.showQueue(call, request));
    case 'reject':
      return reportReject(output, await pipeline.reject(call, request));
    case 'approve':
      return reportApprove(
        output,
        await pipeline.approve(call, request),
        options.runner === true,
      );
  }
};
