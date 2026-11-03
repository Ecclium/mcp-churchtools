/**
 * `ecclium queue list`, `ecclium queue show <Kennung>` and
 * `ecclium queue reject <Kennung>` (ADR 0031): the queue of approvals for
 * the operator.
 *
 * Where it stands in the way of a write: a write that no person could
 * confirm in the client, or that the policy sent there, waits as a sealed
 * entry under the ID of the audit line of its call, which the result of
 * the write tool names as `queueId`. These commands read the queue through
 * the same pipeline as the server, in the mode `operator` with the
 * identity of the start over stdio: `list` shows every entry with its
 * summary and why it waits, `show` the whole diff of one, and `reject`
 * keeps the decision, destroys the entry and writes a line of the type
 * `approval` into the audit file. None of them asks ChurchTools.
 *
 * What an entry holds is text of ChurchTools and of the model, shown made
 * safe for the terminal. The ID given is checked as a UUID before any file
 * is touched and named in no text.
 *
 * Its exit code follows sysexits, as `texts.ts` maps each case: 0 when the
 * command did its work, `show` of a decided entry included; 64 for a wrong
 * call; 65 for a rejection of an entry that was decided already; 66
 * without an entry under the ID or past its retention; 70 for an internal
 * error; 74 when the audit file cannot take the line or the line of a
 * rejection did not reach it; 77 for a call the core refused; and 78 for
 * an invalid configuration, a folder that is missing or cannot be used, or
 * an audit file that cannot be opened.
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
  loadConfig,
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
  createLogger,
  createStderrWriter,
  openAuditFile,
  prepareQueueFolder,
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
  type Message,
  problemText,
  queueFolderMessage,
} from '../messages/index.js';
import { type Output, terminalLines, usageLine } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import { createStdioCatalog } from '../stdio/catalog.js';
import {
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
  showFooter,
  timeOf,
} from './texts.js';

/** What the command is asked to do. */
export type QueueAction = 'list' | 'show' | 'reject';

/** Options of {@link runQueue}. */
export interface QueueOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /** The options Node.js was started with, for the options of TLS. */
  readonly execArgv: readonly string[];
  /** What to do. */
  readonly action: QueueAction;
  /** The ID of the entry as given, for `show` and `reject`. */
  readonly queueId?: string;
  readonly output: Output;
  /** Replaces the loader, for tests. */
  readonly load?: ((sources: ConfigSources) => ConfigResult) | undefined;
  /** Replaces `writeSync` of the stderr writer of the logs, for tests. */
  readonly writeSync?: WriteSyncFn | undefined;
  /** Replaces the factory of the transport, for tests. */
  readonly createTransport?:
    ((options: HttpTransportOptions) => HttpTransport) | undefined;
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
  output.stdout(showFooter);
  if (!whole) output.stderr(outputCutText);
  return exitCodes.ok;
};

const reportReject = (output: Output, outcome: RejectOutcome): ExitCode => {
  switch (outcome.kind) {
    case 'missing':
    case 'expired':
    case 'off':
      return finish(output, queueMissing[outcome.kind]);
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
  const { stateDir } = config;
  if (stateDir === undefined) {
    return finish(output, queueProblems.state_dir_missing);
  }
  if (config.keysDir === undefined) {
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
  const clock = systemClock;
  // Only a decision writes a line into the audit file; reading writes none.
  let auditFile: AuditFileWriter | undefined;
  if (action === 'reject') {
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
      anchor: ({ file: name, seq, hash }) => {
        anchorLogger.info('audit_chain_anchor', { file: name, seq, hash });
      },
      swept: () => undefined,
    });
  }
  try {
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
        readOnly: config.readOnly,
        features: Object.freeze([]),
        signal: new AbortController().signal,
      });
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
  }
};
