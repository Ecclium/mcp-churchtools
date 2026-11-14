/**
 * `ecclium marker adopt --run <Lauf> [--confirm <Prüfwert>]` (ADR 0032):
 * signs the section of a run of a routine anew after the key of the check
 * codes was lost or replaced, for the operator.
 *
 * Where it stands in the way of a write: with a new key, no section of a
 * run fits its code any more, and the next run of the same period queues
 * its write as the change of a person. This command takes routine and
 * period from the line that ends the run in the audit, the page from the
 * entry of the routine in the policy with the name it is expected to
 * have, and the writes of every run of the routine from the audit files of
 * the days whose writes can still have a snapshot. The write guard judges
 * the page with those snapshots and signs only a section one of them
 * proves: the page up to the line of the marking is the text the write
 * left, and only the code of the line changes, computed by the core with
 * the key of today.
 *
 * Two calls, without a question on the terminal, so that it also runs in
 * a container or a script: without `--confirm` it shows the page, the
 * period, the section made safe for the terminal, the old and the new line
 * and a check value, and writes nothing. With `--confirm` and that value
 * it reads the page again and writes only when the same value comes out.
 * It writes with the account the policy names for the routine, never with
 * the token of the server, while it holds the lock of the routine, so that
 * no run of it writes in between. Every call writes one line of the type
 * `adoption` into the audit file, and an adoption keeps a snapshot of its
 * own, so that `ecclium undo --runner` takes it back. It loads the
 * configuration of the runner, which refuses the token of the server, as
 * the runner container contract asks of a command about a run (ADR 0036).
 *
 * Its exit code follows sysexits, as `texts.ts` maps each case: 0 for a
 * preview, an adoption and nothing to do; 64 for a wrong call; 65 when the
 * section cannot be proven or signed, the page changed or has another
 * name, or the check value does not fit; 66 without snapshots, a run, its
 * period, a page in the policy, a line of the period or a snapshot left;
 * 69 when ChurchTools was not reached or the outcome is unknown; 70 for an
 * internal error; 74 when the audit cannot be read whole or take the line,
 * or the snapshot of the adoption could not be kept; 75 while a run of the
 * routine holds its lock; 77 when writing is off, switched off or blocked,
 * a right is missing, the token is refused, the page is no Markdown page
 * or the clock differs; and 78 for an invalid configuration, a missing key
 * of the check codes or an account of the routine without a token.
 *
 * @packageDocumentation
 */
import { hostname } from 'node:os';

import {
  type AdoptOutcome,
  type ConfigResult,
  type ConfigSources,
  createStdioIdentity,
  createStdioTenantResolver,
  loadConfig,
  maxAdoptionWrites,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import {
  findRoutineWrites,
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
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { auditFolderTexts } from '../commands/audit-texts.js';
import { folderExitCodes } from '../commands/audit-verify.js';
import { commandCatalogOf } from '../compose/catalog.js';
import { privateFileCodeOf } from '../compose/private-file-code.js';
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
import { firstUndoDay } from '../undo/undo.js';
import {
  adoptAccountEnding,
  adoptDoneLines,
  type AdoptEnding,
  adoptEndings,
  adoptFailedEnding,
  type AdoptionShown,
  type AdoptProblem,
  adoptProblems,
} from './texts.js';

/** Options of {@link adoptMarker}. */
export interface AdoptOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /** The options Node.js was started with, for the options of TLS. */
  readonly execArgv: readonly string[];
  /** The ID of the run as given with `--run`, checked before anything. */
  readonly runId: string;
  /** The check value as given with `--confirm`, checked before anything. */
  readonly confirm?: string | undefined;
  readonly output: Output;
  /** Replaces the clock, for tests. */
  readonly clock?: Clock | undefined;
  /** Replaces the loader, for tests. */
  readonly load?: ((sources: ConfigSources) => ConfigResult) | undefined;
  /** Replaces `writeSync` of the stderr writer of the logs, for tests. */
  readonly writeSync?: WriteSyncFn | undefined;
  /** Replaces the factory of the transport, for tests. */
  readonly createTransport?:
    ((options: HttpTransportOptions) => HttpTransport) | undefined;
}

// The check value of a preview, as the command takes it: 16 hex digits.
const checkPattern = /^[0-9a-fA-F]{16}$/;

// The highest count a log line takes.
const maxCount = 1_000_000;

// Ends the command with a text on stderr, or on stdout for one that says
// the work is done.
const finish = (output: Output, ended: AdoptEnding): ExitCode => {
  if (ended.code === exitCodes.ok) output.stdout(ended.text);
  else output.stderr(ended.text);
  return ended.code;
};

const refuse = (output: Output, problem: AdoptProblem): ExitCode =>
  finish(output, adoptProblems[problem]);

// A text of the start about a file or folder it could not use, said of
// the adoption: it stops before it writes.
const stopText = (message: Message): string =>
  `${message.what.replace(', und der Start bricht ab.', ', und Ecclium signiert nichts.')} ${message.why} ${message.action}`;

// Writes text of the page after a line that says what it shows, each line
// made safe for the terminal. Gives false when stdout took not all.
const writeText = (output: Output, heading: string, text: string): boolean => {
  if (!output.stdout(heading)) return false;
  for (const line of text.split('\n')) {
    for (const shown of terminalLines('  ', line)) {
      if (!output.stdout(shown)) return false;
    }
  }
  return true;
};

// What the preview shows: the page, the period, the section, both lines
// and the check value, and how to write it.
const writePreview = (
  output: Output,
  shown: AdoptionShown,
  what: {
    readonly runId: string;
    readonly period: string;
    readonly page: { readonly categoryId: number; readonly name: string };
  },
): boolean =>
  [
    output.stdout(
      `Seite: ‹${what.page.name}› in der Kategorie ${String(what.page.categoryId)}, Periode ${what.period}`,
    ),
    writeText(output, 'Abschnitt, wie er auf der Seite steht:', shown.section),
    writeText(output, 'Zeile der Kennzeichnung jetzt:', shown.oldLine),
    writeText(output, 'Zeile der Kennzeichnung neu:', shown.newLine),
    output.stdout(`Prüfwert: ${shown.check}`),
  ].every(Boolean);

/**
 * Writes what the command says for the outcome of the pipeline and gives
 * its exit code. An adoption that may have written without its line in
 * the audit file ends with 74 after its own text.
 *
 * @param output - The output of the command.
 * @param outcome - The outcome of the adoption of the pipeline.
 * @param what - The run, its routine, period and page, and the entries of
 *   the period that wait, for the texts.
 * @param what.runId - The ID of the run, as the audit names it.
 * @param what.routineId - The ID of its routine.
 * @param what.period - Its period.
 * @param what.page - The page of the entry of the routine.
 * @param what.page.categoryId - Its category.
 * @param what.page.name - Its expected name.
 * @param what.undecided - The entries of the period with no decision.
 * @returns The exit code.
 * @example
 * ```ts
 * return reportAdoption(output, await pipeline.adopt(call, request), what);
 * ```
 */
export function reportAdoption(
  output: Output,
  outcome: AdoptOutcome,
  what: {
    readonly runId: string;
    readonly routineId: string;
    readonly period: string;
    readonly page: { readonly categoryId: number; readonly name: string };
    readonly undecided: readonly string[];
  },
): ExitCode {
  switch (outcome.kind) {
    case 'own':
    case 'none':
    case 'renamed':
    case 'mismatch':
    case 'off':
      return finish(output, adoptEndings[outcome.kind]);
    case 'unclear':
      return finish(output, adoptEndings[outcome.reason]);
    case 'unproven':
    case 'unsignable': {
      writeText(output, 'Bereich auf der Seite:', outcome.range);
      return finish(
        output,
        outcome.kind === 'unsignable'
          ? adoptEndings.unsignable
          : outcome.snapshots === 0
            ? adoptEndings.noSnapshot
            : adoptEndings.unproven,
      );
    }
    case 'preview': {
      writePreview(output, outcome.shown, what);
      output.stdout(
        `Zum Übernehmen rufen Sie ‹ecclium marker adopt --run ${what.runId} --confirm ${outcome.shown.check}› auf. Ecclium liest die Seite dann neu und schreibt nur, wenn derselbe Prüfwert herauskommt.`,
      );
      return exitCodes.ok;
    }
    case 'done': {
      for (const line of adoptDoneLines({
        version: outcome.version,
        undoId: outcome.undoId,
        routineId: what.routineId,
        undecided: what.undecided,
      })) {
        output.stdout(line);
      }
      return outcome.unrecorded === true
        ? finish(output, adoptEndings.unrecorded)
        : exitCodes.ok;
    }
    case 'failed': {
      const ended = finish(output, adoptFailedEnding(outcome));
      return outcome.unrecorded === true
        ? finish(output, adoptEndings.unrecorded)
        : ended;
    }
  }
}

/**
 * Runs `ecclium marker adopt`. Problems that end it before ChurchTools is
 * asked go to stderr; the preview and the result go to stdout.
 *
 * @param options - The environment, the ID of the run, the check value,
 *   the output and the replacements for tests.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * const code = await adoptMarker({ environment, execArgv, runId, output });
 * ```
 */
export async function adoptMarker(options: AdoptOptions): Promise<ExitCode> {
  const { output } = options;
  // The ID and the value first, before any file or the configuration.
  const runId = runIdFromText(options.runId);
  if (runId === undefined) {
    output.stderr(adoptProblems.run_invalid.text);
    output.stderr(usageLine);
    return adoptProblems.run_invalid.code;
  }
  if (options.confirm !== undefined && !checkPattern.test(options.confirm)) {
    output.stderr(adoptProblems.confirm_invalid.text);
    output.stderr(usageLine);
    return adoptProblems.confirm_invalid.code;
  }
  const confirm = options.confirm?.toLowerCase();
  // The configuration of the runner, as for every command about a run: it
  // refuses the token of the server and requires the folder of the kill
  // switches (ADR 0036).
  const loaded = (options.load ?? loadConfig)({
    environment: options.environment,
    transport: 'runner',
    execArgv: options.execArgv,
  });
  if (!loaded.ok) {
    for (const problem of loaded.report.problems) {
      output.stderr(problemText(problem));
    }
    return exitCodes.invalidConfig;
  }
  const { config } = loaded;
  if (config.readOnly) return refuse(output, 'read_only');
  const { stateDir, keysDir } = config;
  if (stateDir === undefined) return refuse(output, 'state_dir_missing');
  if (!config.snapshots) return refuse(output, 'snapshots_off');
  if (config.markerKey === undefined) {
    return refuse(output, 'marker_key_missing');
  }
  const clock = options.clock ?? systemClock;
  // Only the days whose writes can still have a snapshot.
  const since = firstUndoDay(clock.now());

  // Routine and period from the line that ends the run.
  const opened = openAuditFolder({ stateDir });
  if (!opened.ok) {
    if (opened.code === 'audit_folder_missing') {
      return refuse(output, 'run_unknown');
    }
    output.stderr(auditFolderTexts[opened.code]);
    return folderExitCodes[opened.code];
  }
  const run = findRunWrites({ folder: opened.folder, runId, since });
  if (run.moved || run.unread > 0 || run.skipped > 0) {
    return refuse(output, 'audit_incomplete');
  }
  const { routineId, period } = run;
  if (routineId === undefined) return refuse(output, 'run_unknown');
  if (period === undefined) return refuse(output, 'run_without_period');
  // The page of the entries of the routine, as a run of it is bound to.
  const pages = new Map(
    config.policy.unattended.flatMap((entry) =>
      entry.routine === routineId && entry.target.kind === 'wiki_page'
        ? [
            [
              `${String(entry.target.categoryId)}/${entry.target.guid.toLowerCase()}`,
              entry.target,
            ] as const,
          ]
        : [],
    ),
  );
  const [page] = pages.values();
  if (pages.size !== 1 || page === undefined) {
    return refuse(output, 'page_unknown');
  }

  const auditOpened = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!auditOpened.ok) {
    output.stderr(stopText(auditFileMessage(auditOpened.code)));
    return exitCodes.invalidConfig;
  }
  const auditFile = auditOpened.writer;
  let closing = (): void => undefined;
  try {
    // The folders the start over stdio makes, so that the adoption finds
    // what a write needs: the counters, the day keys and the snapshots,
    // its own included (ADR 0031, ADR 0063).
    const prepared = prepareQuotaFolder(stateDir);
    if (!prepared.ok) {
      output.stderr(stopText(quotaFolderMessage(prepared.code)));
      return exitCodes.invalidConfig;
    }
    try {
      // The loader asks for the folder of keys with ECCLIUM_READ_ONLY=false.
      prepareDayKeyFolder(keysDir as string, 'snapshot');
    } catch (error) {
      const code = privateFileCodeOf(error);
      if (code === undefined) throw error;
      output.stderr(stopText(dayKeyFolderMessage(code)));
      return exitCodes.invalidConfig;
    }
    try {
      prepareSnapshotFolder(stateDir);
    } catch (error) {
      const code = privateFileCodeOf(error);
      if (code === undefined) throw error;
      output.stderr(stopText(snapshotFolderMessage(code)));
      return exitCodes.invalidConfig;
    }
    const writer = createStderrWriter(
      options.writeSync === undefined ? {} : { writeSync: options.writeSync },
    );
    // The anchor of the chain of the audit file goes to the log when the
    // file closes, as with the server (ADR 0028).
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
    // The lock of the routine, so that no run of it writes meanwhile
    // (ADR 0034).
    const lock = createRoutineLocks({
      stateDir,
      clock,
      pid: process.pid,
      host: hostname(),
    }).acquire(routineId);
    if (lock.kind === 'busy') return refuse(output, 'routine_busy');
    if (lock.kind === 'failed') return refuse(output, 'routine_lock_failed');
    try {
      // The account of the routine, never the token of the server
      // (ADR 0033).
      const built = composeRunPipeline({
        config,
        catalog: commandCatalogOf(config),
        writer,
        clock,
        auditFile,
        createTransport: options.createTransport,
        routineId,
        writeHalt: createWriteHalt(),
        requireAccount: true,
      });
      if (!built.ok) return finish(output, adoptAccountEnding(built.code));
      try {
        // The writes of the routine, read under the lock: a run that still
        // ran when the files were read first may have written since.
        const again = openAuditFolder({ stateDir });
        if (!again.ok) {
          output.stderr(auditFolderTexts[again.code]);
          return folderExitCodes[again.code];
        }
        const found = findRoutineWrites({
          folder: again.folder,
          routineId,
          period,
          since,
        });
        if (found.moved || found.unread > 0 || found.skipped > 0) {
          return refuse(output, 'audit_incomplete');
        }
        // The mode is a literal of the command, never taken from the
        // configuration or a request (ADR 0024).
        const request: ToolRequest = Object.freeze({
          assignment: await createStdioTenantResolver().resolve(
            createStdioIdentity(config),
          ),
          mode: 'operator',
          redaction: config.redaction,
          readOnly: false,
          features: Object.freeze([]),
          signal: new AbortController().signal,
        });
        const outcome = await built.pipeline.adopt(
          {
            run: { runId, routineId },
            period,
            page: {
              categoryId: page.categoryId,
              guid: page.guid,
              name: page.name,
            },
            // The newest first, as many as the pipeline opens.
            writeIds: found.written
              .slice(0, maxAdoptionWrites)
              .map((write) => write.eventId),
            confirm,
          },
          request,
        );
        return reportAdoption(output, outcome, {
          runId,
          routineId,
          period,
          page,
          undecided: found.undecided,
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
