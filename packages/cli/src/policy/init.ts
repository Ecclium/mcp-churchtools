/**
 * `ecclium policy init --interactive` (ADR 0032): proposes the interactive
 * part of the policy from the audit files, for the operator to check and
 * to save as the file of the policy. It changes no file.
 *
 * It reads the folder `audit` for the categories of the wiki that write
 * tools reached, asks ChurchTools for their names with the tool
 * `ct_wiki_categories_list` through the same pipeline as the server, and
 * writes the proposal as YAML to stdout. Its calls run in the mode
 * `operator` with the identity of the start over stdio, so they stand in
 * the audit file and count against the limits of ChurchTools like every
 * call; the tool reads no personal data and spends no read budget. With
 * no category in the audit it asks ChurchTools nothing.
 *
 * Its exit code follows sysexits: 0 when the proposal is written, 64
 * without `--interactive`, 66 when the folder `audit` is missing, 69 when
 * ChurchTools gives no names, 74 when files could not be read whole or the
 * proposal did not reach stdout, 78 for an invalid configuration, no
 * folder of state, the toolset `wiki` off or an audit file or folder of
 * the counters that cannot be used.
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
  type ProposedCategory,
  renderPolicyProposal,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import {
  collectWriteTargets,
  openAuditFolder,
} from '@ecclium/mcp-churchtools-core/audit';
import {
  createLogger,
  createStderrWriter,
  openAuditFile,
  prepareQuotaFolder,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';

import { auditFolderTexts } from '../commands/audit-texts.js';
import { folderExitCodes } from '../commands/audit-verify.js';
import { composeToolPipeline } from '../compose/pipeline.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import {
  auditFileText,
  problemText,
  quotaFolderText,
} from '../messages/index.js';
import { type Output, usageLine } from '../output/index.js';
import type { WriteSyncFn } from '../send.js';
import { createStdioCatalog } from '../stdio/catalog.js';
import {
  namesFailedText,
  outputCutText,
  partlyReadText,
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

/** The tool that names the categories of the wiki. */
const namesTool = 'ct_wiki_categories_list';

// The most pages of the list: 1000 categories at 25 a page, the most the
// tool takes.
const maxPages = 40;

// The data envelope around a name, which the pipeline puts around every
// text of the tenant (ADR 0024), and the note of the redaction after a
// text it removed hidden characters from.
const envelope = /^<<data-([0-9a-f]{16})>>([\s\S]*)<<\/data-\1>>$/;
const hiddenNote = / \[ecclium: \d+ hidden characters removed\]$/;

/** A name as the command line takes it from a result. */
interface Name {
  readonly text: string;
  readonly hidden: boolean;
}

const nameOf = (value: unknown): Name | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = envelope.exec(value);
  const text = match?.[2];
  if (text === undefined) return undefined;
  return hiddenNote.test(text)
    ? { text: text.replace(hiddenNote, ''), hidden: true }
    : { text, hidden: false };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One page of the list of categories, as the tool gives it. */
interface Page {
  readonly categories: readonly { readonly id: number; readonly name: Name }[];
  readonly more: boolean;
}

// Reads a page of the result field by field; a result of another form
// gives undefined, and the command writes no proposal then.
const pageOf = (data: unknown): Page | undefined => {
  if (!isRecord(data) || typeof data['more'] !== 'boolean') return undefined;
  const list = data['categories'];
  if (!Array.isArray(list)) return undefined;
  const categories: { id: number; name: Name }[] = [];
  for (const entry of list as readonly unknown[]) {
    if (!isRecord(entry)) return undefined;
    const id = entry['id'];
    const name = nameOf(entry['name']);
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !name) {
      return undefined;
    }
    categories.push({ id, name });
  }
  return { categories, more: data['more'] };
};

type Names =
  | { readonly ok: true; readonly names: ReadonlyMap<number, Name> }
  | { readonly ok: false; readonly code: ExitCode };

/**
 * Asks ChurchTools for the names of the categories, through the pipeline
 * with the audit file of this process.
 *
 * @param config - The checked configuration, with a folder of state.
 * @param stateDir - The folder of state.
 * @param options - The output and the replacements for tests.
 * @returns The names by ID, or the exit code after a text on stderr.
 */
const fetchNames = async (
  config: EccliumConfig,
  stateDir: string,
  options: PolicyInitOptions,
): Promise<Names> => {
  const { output } = options;
  const clock = systemClock;
  const opened = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!opened.ok) {
    output.stderr(auditFileText(opened.code));
    return { ok: false, code: exitCodes.invalidConfig };
  }
  const auditFile = opened.writer;
  try {
    const prepared = prepareQuotaFolder(stateDir);
    if (!prepared.ok) {
      output.stderr(quotaFolderText(prepared.code));
      return { ok: false, code: exitCodes.invalidConfig };
    }
    const writer = createStderrWriter(
      options.writeSync === undefined ? {} : { writeSync: options.writeSync },
    );
    // The anchor of the chain of the audit file goes to the log when the
    // file closes, as with the server (ADR 0028).
    const anchorLogger = createLogger({
      writer,
      clock,
      minLevel: 'info',
      anchors: true,
    });
    auditFile.attach({
      anchor: ({ file, seq, hash }) => {
        anchorLogger.info('audit_chain_anchor', { file, seq, hash });
      },
      swept: () => undefined,
    });
    // Only the toolset of the wiki and no write tool: the command reads
    // one list and needs nothing else.
    const narrowed: EccliumConfig = {
      ...config,
      toolsets: ['wiki'],
      readOnly: true,
    };
    const { pipeline, transport } = composeToolPipeline({
      config: narrowed,
      catalog: createStdioCatalog(narrowed),
      writer,
      clock,
      auditFile,
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
      const names = new Map<number, Name>();
      for (let page = 1; page <= maxPages; page += 1) {
        const outcome = await pipeline.call(namesTool, { page }, request);
        if (!outcome.ok) {
          output.stderr(namesFailedText(outcome.error.code));
          return { ok: false, code: exitCodes.unavailable };
        }
        const read = pageOf(outcome.data);
        if (read === undefined) {
          output.stderr(namesFailedText('internal' satisfies ErrorCode));
          return { ok: false, code: exitCodes.unavailable };
        }
        for (const category of read.categories) {
          names.set(category.id, category.name);
        }
        if (!read.more) break;
      }
      return { ok: true, names };
    } finally {
      await transport.close().catch(() => undefined);
    }
  } finally {
    auditFile.close();
  }
};

/**
 * Runs `ecclium policy init`. The proposal is rendered whole before the
 * first line goes out; a problem that stops it goes to stderr.
 *
 * @param options - The environment, `--interactive`, the output and the
 *   replacements for tests.
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
  if (!options.interactive) {
    output.stderr(policyInitTexts.interactive_missing);
    output.stderr(usageLine);
    return exitCodes.usage;
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
  let names: ReadonlyMap<number, Name> = new Map();
  if (targets.categories.length > 0) {
    if (!config.toolsets.includes('wiki')) {
      output.stderr(policyInitTexts.wiki_off);
      return exitCodes.invalidConfig;
    }
    const fetched = await fetchNames(config, stateDir, options);
    if (!fetched.ok) return fetched.code;
    names = fetched.names;
  }
  const categories = targets.categories.map((category): ProposedCategory => {
    const name = names.get(category.id);
    return {
      ...category,
      name: name?.text,
      ...(name?.hidden === true ? { hiddenCharacters: true } : {}),
    };
  });
  const text = renderPolicyProposal({
    categories,
    readBudgetPerDay: config.policy.interactive.readBudgetPerDay,
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
