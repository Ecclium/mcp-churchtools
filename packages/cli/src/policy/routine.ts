/**
 * `ecclium policy init --routine <Routine> --credential <Alias>`
 * (ADR 0032): proposes the entry of a routine in the unattended part of
 * the policy, for the operator to check and to add to the file of the
 * policy. It changes no file.
 *
 * It loads the routine from `ECCLIUM_ROUTINES_DIR` with the loader of
 * `routine.v1`, without the preparation against the policy, which a
 * routine without its entry would not pass. A routine whose output is a
 * draft needs no entry: the command says so and ends before it touches the
 * token files or ChurchTools. For a page of the wiki it reads the names
 * with the account of the alias, the file `ct_token_<alias>` of
 * `ECCLIUM_RUNNER_TOKENS_DIR`, never with the token of the server: the
 * account that writes later shows now whether it may see the page. It asks
 * `ct_wiki_categories_list` for the category of the routine and
 * `ct_wiki_pages_list` for its page, every page of both lists, so that a
 * second page with the same name shows, in the mode `operator` with the
 * identity of the start over stdio and an audit file of its own.
 *
 * A name matches exactly in the normal form NFC, as a run compares it,
 * and a name the redaction changed never matches. The proposal binds the
 * page by its GUID with the name the routine gives it. `maxPerDay` counts
 * the triggers of the schedule on one UTC day in the zone of
 * `ECCLIUM_TIME_ZONE`, which the command requires like the runner.
 *
 * Its exit code follows sysexits: 0 when the proposal is written, also one
 * with comments only, 64 for a routine the folder does not hold, 66 when
 * the folder of the routines is missing, 69 when ChurchTools gives no
 * names, 74 when the proposal did not reach stdout whole, and 78 for an
 * invalid configuration, routines that do not load, no folder of state,
 * no zone, or no token file of the alias the checks take.
 *
 * @packageDocumentation
 */
import {
  type ConfigResult,
  type ConfigSources,
  createStdioIdentity,
  createStdioTenantResolver,
  type EccliumConfig,
  loadConfig,
  mostTriggersPerUtcDay,
  renderRoutineProposal,
  type RoutineProposalNote,
  type RoutineProposalPage,
  type ToolPipeline,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import { systemClock } from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';
import { loadRoutines, type Routine } from '@ecclium/mcp-churchtools-workflows';

import { composeAccountPipeline } from '../compose/run-pipeline.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import { problemText } from '../messages/index.js';
import type { Output } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import { createStdioCatalog } from '../stdio/catalog.js';
import {
  listPageOf,
  type Name,
  type NamedEntry,
  namedEntryOf,
  nameOf,
  type Reading,
  type ReadingResult,
  withReading,
} from './names.js';
import {
  accountText,
  draftNeedsNoEntryText,
  namesFailedText,
  outputCutText,
  routineProposalTexts,
  routinesLoadText,
} from './texts.js';

/** Options of {@link proposeRoutineEntry}. */
export interface RoutineProposalOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /** The options Node.js was started with, for the options of TLS. */
  readonly execArgv: readonly string[];
  /** The ID of the routine, in the form the policy takes. */
  readonly routine: string;
  /** The alias of the account, in the form the policy takes. */
  readonly credential: string;
  readonly output: Output;
  /** Replaces the loader, for tests. */
  readonly load?: ((sources: ConfigSources) => ConfigResult) | undefined;
  /** Replaces `writeSync` of the stderr writer of the logs, for tests. */
  readonly writeSync?: WriteSyncFn | undefined;
  /** Replaces the factory of the transport, for tests. */
  readonly createTransport?:
    ((options: HttpTransportOptions) => HttpTransport) | undefined;
  /** Replaces the time the count of the triggers starts from, for tests. */
  readonly now?: (() => number) | undefined;
}

// The most pages of a list: 1000 entries at 25 a page, the most each of
// the two tools takes.
const maxPages = 40;
const listLimit = 1000;

/** A page of a category, as `ct_wiki_pages_list` names it. */
interface ListedPage {
  readonly guid: string;
  readonly title: Name;
}

const pageEntryOf = (
  entry: Readonly<Record<string, unknown>>,
): ListedPage | undefined => {
  const guid = entry['guid'];
  const title = nameOf(entry['title']);
  return typeof guid === 'string' && title ? { guid, title } : undefined;
};

/** A whole list, or as much as the command reads, or why there is none. */
type ListRead<T> =
  | {
      readonly ok: true;
      readonly entries: readonly T[];
      /** Whether the list ended within the pages the command reads. */
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly code: ErrorCode };

// Reads every page of a list, also an empty one while more follow, up to
// the most pages the command reads.
const readList = async <T>(
  pipeline: ToolPipeline,
  request: ToolRequest,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  field: string,
  entryOf: (entry: Readonly<Record<string, unknown>>) => T | undefined,
): Promise<ListRead<T>> => {
  const entries: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const outcome = await pipeline.call(tool, { ...input, page }, request);
    if (!outcome.ok) return { ok: false, code: outcome.error.code };
    const read = listPageOf(outcome.data, field, entryOf);
    if (read === undefined) return { ok: false, code: 'internal' };
    entries.push(...read.entries);
    if (!read.more) return { ok: true, entries, complete: true };
  }
  return { ok: true, entries, complete: false };
};

/** The page of the routine, or the notes that say why there is none. */
interface Found {
  readonly page?: RoutineProposalPage;
  readonly notes: readonly RoutineProposalNote[];
}

const tooLong: Found = Object.freeze({
  notes: Object.freeze([
    Object.freeze({ kind: 'list_too_long', entries: listLimit } as const),
  ]),
});

const nfc = (text: string): string => text.normalize('NFC');

// Finds the page of the routine with the account of the alias: the
// categories with the name of the routine, then in each of them the pages
// with the name of the routine.
const findPage = async (
  config: EccliumConfig,
  reading: Reading,
  scope: { readonly category: string; readonly page: string },
  options: RoutineProposalOptions,
): Promise<ReadingResult<Found>> => {
  const { output } = options;
  // Only the toolset of the two lists and no write tool.
  const narrowed: EccliumConfig = Object.freeze({
    ...config,
    toolsets: Object.freeze(['wiki'] as const),
    readOnly: true,
  });
  const built = composeAccountPipeline({
    config: narrowed,
    catalog: createStdioCatalog(narrowed),
    writer: reading.writer,
    clock: reading.clock,
    auditFile: reading.auditFile,
    createTransport: options.createTransport,
    credential: options.credential,
  });
  if (!built.ok) {
    output.stderr(accountText(built.code));
    return { ok: false, code: exitCodes.invalidConfig };
  }
  try {
    // The mode is a literal of the command, never taken from the
    // configuration or a request (ADR 0024).
    const request: ToolRequest = Object.freeze({
      assignment: await createStdioTenantResolver().resolve(
        createStdioIdentity(narrowed),
      ),
      mode: 'operator',
      redaction: config.redaction,
      readOnly: true,
      features: Object.freeze([]),
      signal: new AbortController().signal,
    });
    const categories = await readList<NamedEntry>(
      built.pipeline,
      request,
      'ct_wiki_categories_list',
      {},
      'categories',
      namedEntryOf,
    );
    if (!categories.ok) {
      output.stderr(namesFailedText(categories.code, 'categories'));
      return { ok: false, code: exitCodes.unavailable };
    }
    if (!categories.complete) return { ok: true, value: tooLong };
    const category = nfc(scope.category);
    // Each category once, should a list name one twice.
    const matching = new Map(
      categories.entries
        .filter(({ name }) => !name.changed && nfc(name.text) === category)
        .map((entry) => [entry.id, entry]),
    );
    if (matching.size === 0) {
      const changed = categories.entries.some(({ name }) => name.changed);
      return {
        ok: true,
        value: {
          notes: [
            { kind: 'category_missing' },
            ...(changed ? [{ kind: 'names_changed' } as const] : []),
          ],
        },
      };
    }
    const title = nfc(scope.page);
    const found = new Map<string, Omit<RoutineProposalPage, 'name'>>();
    let changed = false;
    for (const { id: categoryId } of matching.values()) {
      const pages = await readList<ListedPage>(
        built.pipeline,
        request,
        'ct_wiki_pages_list',
        { categoryId },
        'pages',
        pageEntryOf,
      );
      if (!pages.ok) {
        output.stderr(namesFailedText(pages.code, 'pages'));
        return { ok: false, code: exitCodes.unavailable };
      }
      if (!pages.complete) return { ok: true, value: tooLong };
      for (const entry of pages.entries) {
        if (entry.title.changed) {
          changed = true;
        } else if (nfc(entry.title.text) === title) {
          const guid = entry.guid.toLowerCase();
          found.set(`${String(categoryId)}/${guid}`, { categoryId, guid });
        }
      }
    }
    const [page, ...more] = found.values();
    if (page === undefined) {
      return {
        ok: true,
        value: {
          notes: [
            { kind: 'page_missing' },
            ...(changed ? [{ kind: 'names_changed' } as const] : []),
          ],
        },
      };
    }
    if (more.length > 0) {
      return { ok: true, value: { notes: [{ kind: 'page_ambiguous' }] } };
    }
    // The name the routine gives the page, which matched in NFC: the entry
    // then allows the target of the routine as its preparation compares it.
    return {
      ok: true,
      value: { page: { ...page, name: scope.page }, notes: [] },
    };
  } finally {
    await built.close().catch(() => undefined);
  }
};

// What the operator decides about the routine and the policy in force.
const decisionsOf = (
  routine: Routine,
  config: EccliumConfig,
  credential: string,
): RoutineProposalNote[] => {
  const notes: RoutineProposalNote[] = [];
  const existing = config.policy.unattended.filter(
    (entry) => entry.routine === routine.id,
  );
  if (existing.length > 0) {
    notes.push({
      kind: 'existing',
      count: existing.length,
      otherCredential: existing.some(
        (entry) => entry.credential !== credential,
      ),
    });
  }
  if (routine.generate?.redaction === 'standard') {
    notes.push({ kind: 'redaction_standard' });
  }
  if (routine.checks !== undefined) notes.push({ kind: 'checks' });
  return notes;
};

// Writes the text line by line to stdout, without the empty last line.
const writeOut = (output: Output, text: string): ExitCode => {
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (!output.stdout(line)) {
      output.stderr(outputCutText);
      return exitCodes.ioError;
    }
  }
  return exitCodes.ok;
};

/**
 * Runs `ecclium policy init --routine`. The proposal is rendered whole
 * before the first line goes out; a problem that stops it goes to stderr.
 *
 * @param options - The environment, the routine, the alias, the output
 *   and the replacements for tests.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * const code = await proposeRoutineEntry({ environment, execArgv, routine: 'dienstplan-report', credential: 'berichte', output });
 * ```
 */
export async function proposeRoutineEntry(
  options: RoutineProposalOptions,
): Promise<ExitCode> {
  const { output, credential } = options;
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
  if (config.routinesDir === undefined) {
    output.stderr(routineProposalTexts.routines_dir_unset);
    return exitCodes.invalidConfig;
  }
  const routines = loadRoutines(config.routinesDir);
  if (!routines.ok) {
    output.stderr(routinesLoadText(routines));
    return routines.code === 'routines_dir' &&
      (routines.reason === 'missing' || routines.reason === 'not_directory')
      ? exitCodes.noInput
      : exitCodes.invalidConfig;
  }
  const routine = routines.routines.find(
    (loadedRoutine) => loadedRoutine.routine.id === options.routine,
  )?.routine;
  if (routine === undefined) {
    output.stderr(routineProposalTexts.routine_unknown);
    return exitCodes.usage;
  }
  const target = routine.output;
  // A draft goes to a file, not to ChurchTools, so the command reads no
  // token and asks ChurchTools nothing (ADR 0033).
  if (target.target !== 'wiki') return writeOut(output, draftNeedsNoEntryText);
  const { timeZone, stateDir } = config;
  if (timeZone === undefined) {
    output.stderr(routineProposalTexts.time_zone_missing);
    return exitCodes.invalidConfig;
  }
  if (stateDir === undefined) {
    output.stderr(routineProposalTexts.state_dir_missing);
    return exitCodes.invalidConfig;
  }
  const triggersPerDay = mostTriggersPerUtcDay(
    routine.schedule,
    timeZone,
    options.now?.() ?? systemClock.now(),
  );
  const found = await withReading(config, stateDir, options, (reading) =>
    findPage(config, reading, target.scope, options),
  );
  if (!found.ok) return found.code;
  const { page } = found.value;
  return writeOut(
    output,
    renderRoutineProposal({
      routine: routine.id,
      credential,
      tool: target.tool,
      ...(page === undefined ? {} : { page }),
      triggersPerDay,
      notes: [
        ...found.value.notes,
        ...decisionsOf(routine, config, credential),
      ],
    }),
  );
}
