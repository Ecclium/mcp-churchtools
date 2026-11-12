/**
 * `ecclium policy init --interactive` (ADR 0032): proposes the interactive
 * part of the policy from the audit files, for the operator to check and
 * to save as the file of the policy. It changes no file.
 *
 * It reads the folder `audit` for the categories of the wiki, the
 * calendars and the resources that write tools reached, asks ChurchTools
 * for their names with the tools `ct_wiki_categories_list`,
 * `ct_calendars_list` and `ct_resources_list` through the same pipeline
 * as the server, and writes the proposal as YAML to stdout. Its calls run
 * in the mode `operator` with the identity of the start over stdio, so
 * they stand in the audit file and count against the limits of ChurchTools
 * like every call; the tools read no personal data and spend no read
 * budget. It asks only for the kinds the audit names, and with none it
 * asks ChurchTools nothing.
 *
 * With `--routine` and `--credential` it proposes the entry of a routine
 * in the unattended part instead (`routine.ts`).
 *
 * Its exit code follows sysexits: 0 when the proposal is written, 64
 * for a call of another form, 66 when the folder `audit` is missing, 69 when
 * ChurchTools gives no names, 74 when files could not be read whole or the
 * proposal did not reach stdout, 78 for an invalid configuration, no
 * folder of state, the toolset `wiki` or `calendars` off when the audit
 * names a target of it, or an audit file or folder of the counters that
 * cannot be used.
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
  type ProposedTarget,
  renderPolicyProposal,
  type ToolRequest,
  type ToolsetName,
} from '@ecclium/mcp-churchtools-core';
import {
  collectWriteTargets,
  openAuditFolder,
  type WriteTargetObject,
} from '@ecclium/mcp-churchtools-core/audit';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';

import { auditFolderTexts } from '../commands/audit-texts.js';
import { folderExitCodes } from '../commands/audit-verify.js';
import { composeToolPipeline } from '../compose/pipeline.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import { problemText } from '../messages/index.js';
import { type Output, usageLine } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import { createStdioCatalog } from '../stdio/catalog.js';
import { policyInitCallProblem } from './call.js';
import {
  listPageOf,
  type Name,
  namedEntryOf,
  type ReadingResult,
  withReading,
} from './names.js';
import { proposeRoutineEntry } from './routine.js';
import {
  type NamedKind,
  namesFailedText,
  outputCutText,
  partlyReadText,
  policyInitCallTexts,
  policyInitTexts,
} from './texts.js';

/** Options of {@link initPolicy}. */
export interface PolicyInitOptions {
  /** The copy of the environment, as the command line took it over. */
  readonly environment: Readonly<Record<string, string>>;
  /** The options Node.js was started with, for the options of TLS. */
  readonly execArgv: readonly string[];
  /** Whether `--interactive` was given. */
  readonly interactive: boolean;
  /** The routine of `--routine`, for the entry of a routine. */
  readonly routine?: string | undefined;
  /** The alias of `--credential`, with `--routine`. */
  readonly credential?: string | undefined;
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

/** Where the names of one kind of targets come from. */
interface NameSource {
  /** The tool that lists them, 25 a page. */
  readonly tool: string;
  /** Its toolset, which the configuration must switch on. */
  readonly toolset: ToolsetName;
}

/** The tools that name the categories, the calendars and the resources. */
const nameSources: Readonly<Record<NamedKind, NameSource>> = Object.freeze({
  categories: { tool: 'ct_wiki_categories_list', toolset: 'wiki' },
  calendars: { tool: 'ct_calendars_list', toolset: 'calendars' },
  resources: { tool: 'ct_resources_list', toolset: 'calendars' },
});

// The most pages of a list: 1000 entries at 25 a page, the most each of
// the tools takes.
const maxPages = 40;

/** The IDs of the audit whose names to ask for, by kind. */
type Wanted = Readonly<Record<NamedKind, ReadonlySet<number>>>;

/** The names ChurchTools gave, by kind and ID. */
type NamesByKind = Readonly<Record<NamedKind, ReadonlyMap<number, Name>>>;

type Names = ReadingResult<NamesByKind>;

const namedKinds: readonly NamedKind[] = Object.freeze([
  'categories',
  'calendars',
  'resources',
]);

/**
 * Asks ChurchTools for the names of the categories, the calendars and the
 * resources the audit names, through the pipeline with the audit file of
 * this process.
 *
 * @param config - The checked configuration, with a folder of state.
 * @param stateDir - The folder of state.
 * @param wanted - The IDs of the audit by kind; a kind without one is not
 *   asked for, and no further page once each has its name.
 * @param options - The output and the replacements for tests.
 * @returns The names by kind and ID, or the exit code after a text on
 *   stderr.
 */
const fetchNames = (
  config: EccliumConfig,
  stateDir: string,
  wanted: Wanted,
  options: PolicyInitOptions,
): Promise<Names> =>
  withReading(config, stateDir, options, async (reading) => {
    const { output } = options;
    // Only the toolsets of the lists it reads and no write tool: the
    // command needs nothing else.
    const asked = namedKinds.filter((kind) => wanted[kind].size > 0);
    const narrowed: EccliumConfig = {
      ...config,
      toolsets: [...new Set(asked.map((kind) => nameSources[kind].toolset))],
      readOnly: true,
    };
    const { pipeline, transport } = composeToolPipeline({
      config: narrowed,
      catalog: createStdioCatalog(narrowed),
      writer: reading.writer,
      clock: reading.clock,
      auditFile: reading.auditFile,
      createTransport: options.createTransport,
    });
    try {
      const assignment = await createStdioTenantResolver().resolve(
        createStdioIdentity(narrowed),
      );
      // The mode is a literal of the command, never taken from the
      // configuration or a request (ADR 0024).
      const request: ToolRequest = Object.freeze({
        assignment,
        mode: 'operator',
        redaction: config.redaction,
        readOnly: true,
        features: Object.freeze([]),
        signal: new AbortController().signal,
      });
      const names: Record<NamedKind, Map<number, Name>> = {
        categories: new Map(),
        calendars: new Map(),
        resources: new Map(),
      };
      for (const kind of asked) {
        const found = names[kind];
        for (let page = 1; page <= maxPages; page += 1) {
          const outcome = await pipeline.call(
            nameSources[kind].tool,
            { page },
            request,
          );
          if (!outcome.ok) {
            output.stderr(namesFailedText(outcome.error.code, kind));
            return { ok: false, code: exitCodes.unavailable };
          }
          const read = listPageOf(outcome.data, kind, namedEntryOf);
          if (read === undefined) {
            output.stderr(
              namesFailedText('internal' satisfies ErrorCode, kind),
            );
            return { ok: false, code: exitCodes.unavailable };
          }
          for (const entry of read.entries) found.set(entry.id, entry.name);
          // No further page once every target of the audit has its name.
          if (!read.more || [...wanted[kind]].every((id) => found.has(id))) {
            break;
          }
        }
      }
      return { ok: true, value: names };
    } finally {
      await transport.close().catch(() => undefined);
    }
  });

/**
 * Runs `ecclium policy init`. The proposal is rendered whole before the
 * first line goes out; a problem that stops it goes to stderr.
 *
 * @param options - The environment, `--interactive` or `--routine` with
 *   `--credential`, the output and the replacements for tests.
 * @returns The exit code.
 * @throws {TypeError} Only for an internal error, which the command line
 *   turns into 70.
 * @example
 * ```ts
 * const code = await initPolicy({ environment, execArgv, interactive: true, output });
 * ```
 */
export async function initPolicy(
  options: PolicyInitOptions,
): Promise<ExitCode> {
  const { output } = options;
  // The form of the call first, before any file is read; no text repeats
  // an argument.
  const problem = policyInitCallProblem(options);
  if (problem !== undefined) {
    output.stderr(policyInitCallTexts[problem]);
    if (!problem.endsWith('_invalid')) output.stderr(usageLine);
    return exitCodes.usage;
  }
  if (options.routine !== undefined && options.credential !== undefined) {
    return proposeRoutineEntry({
      ...options,
      routine: options.routine,
      credential: options.credential,
    });
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
    output.stderr(policyInitTexts.state_dir_missing);
    return exitCodes.invalidConfig;
  }
  const folder = openAuditFolder({ stateDir });
  if (!folder.ok) {
    output.stderr(auditFolderTexts[folder.code]);
    return folderExitCodes[folder.code];
  }
  const targets = collectWriteTargets(folder.folder);
  if (targets.moved) {
    output.stderr(policyInitTexts.folder_moved);
    return exitCodes.ioError;
  }
  const wanted: Wanted = {
    categories: new Set(targets.categories.map(({ id }) => id)),
    calendars: new Set(targets.calendars.map(({ id }) => id)),
    resources: new Set(targets.resources.map(({ id }) => id)),
  };
  // Every toolset first, so that a missing one stops before ChurchTools is
  // asked anything.
  if (wanted.categories.size > 0 && !config.toolsets.includes('wiki')) {
    output.stderr(policyInitTexts.wiki_off);
    return exitCodes.invalidConfig;
  }
  if (
    wanted.calendars.size + wanted.resources.size > 0 &&
    !config.toolsets.includes('calendars')
  ) {
    output.stderr(policyInitTexts.calendars_off);
    return exitCodes.invalidConfig;
  }
  let names: NamesByKind = {
    categories: new Map(),
    calendars: new Map(),
    resources: new Map(),
  };
  if (namedKinds.some((kind) => wanted[kind].size > 0)) {
    const fetched = await fetchNames(config, stateDir, wanted, options);
    if (!fetched.ok) return fetched.code;
    names = fetched.value;
  }
  const proposed = (
    kind: NamedKind,
    found: readonly WriteTargetObject[],
  ): ProposedTarget[] =>
    found.map((target) => {
      const name = names[kind].get(target.id);
      return {
        ...target,
        name: name?.text,
        ...(name?.changed === true ? { nameChanged: true } : {}),
      };
    });
  const text = renderPolicyProposal({
    categories: proposed('categories', targets.categories),
    calendars: proposed('calendars', targets.calendars),
    resources: proposed('resources', targets.resources),
    readBudgetPerDay: config.policy.interactive.readBudgetPerDay,
    ...(config.policy.interactive.contacts === undefined
      ? {}
      : { contacts: config.policy.interactive.contacts }),
    ...(config.policy.interactive.inquiriesTo === undefined
      ? {}
      : { inquiriesTo: config.policy.interactive.inquiriesTo }),
    ...(targets.days === undefined ? {} : { days: targets.days }),
  });
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (!output.stdout(line)) {
      output.stderr(outputCutText);
      return exitCodes.ioError;
    }
  }
  if (targets.unread > 0) {
    output.stderr(partlyReadText);
    return exitCodes.ioError;
  }
  return exitCodes.ok;
}
