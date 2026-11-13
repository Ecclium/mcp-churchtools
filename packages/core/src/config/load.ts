/**
 * Loads the configuration from the environment, the token file and the
 * key files for pseudonyms (ADR 0055, ADR 0069), and checks the folders of
 * state and of the day keys (ADR 0028, ADR 0031). The core never reads
 * `process.env` itself: the command line passes the environment in. The
 * loader reports every problem at once, by code and variable, and never a
 * value it was given.
 *
 * @packageDocumentation
 */
import {
  isBoxedPrimitive,
  isMap,
  isProxy,
  isSet as isSetObject,
} from 'node:util/types';

import type { RedactionLevel } from '@ecclium/mcp-churchtools-plugin-api';

import {
  parseChurchToolsOrigin,
  parseEgressProxy,
  parseModelEndpoint,
  Secret,
} from '../http/index.js';
import type { KeyMaterial } from '../keys/index.js';
import type { LogLevel } from '../logger/index.js';
import { defaultPolicy } from '../policy/check.js';
import { type PolicyFileSystem, readPolicyFile } from '../policy/file.js';
import type { Policy } from '../policy/schema.js';
import {
  type ProviderSettings,
  readProvidersFile,
} from '../providers/index.js';
import type { ToolsetName } from '../registry/toolsets.js';
import type { ConfigProblemCode, ConfigWarningCode } from './codes.js';
import { readMarkerKeyFile } from './marker-key-file.js';
import { readPingUrlFile } from './ping-url-file.js';
import { readPseudonymKeyFile } from './pseudonym-key-file.js';
import {
  readRunnerToken,
  runnerOwnAlias,
  runnerTokenCodeOf,
} from './runner-token.js';
import {
  checkKeysDir,
  checkRunnerTokensDir,
  checkStateDir,
  hasStopDir,
  isNormalizedAbsolutePath,
  type StateDirFileSystem,
} from './state-dir.js';
import { readTokenFile, type TokenFileSystem } from './token-file.js';
import {
  debugVariableName,
  defaultHttpWriteConfirmation,
  environmentProxyOption,
  environmentProxyVariableNames,
  fitsVariable,
  nodeOptionsVariableName,
  type PlainVariableName,
  readAllowLanList,
  readToolsetList,
  recommendedRetentionMonths,
  reservedStdioSubjects,
  searchToolsVariableName,
  tlsKeylogOption,
  tlsTraceOption,
  tlsVariableName,
  tokenVariableName,
  trustStoreOptions,
  trustStoreVariableNames,
  unsupportedVariableNames,
  type Variable,
  type VariableName,
  variableNames,
  variablePrefix,
  variables,
  type WriteConfirmation,
  yamlDebugVariableNames,
} from './variables.js';

/**
 * How Ecclium runs: the server over stdio or over HTTP, or the runner of
 * routines (ADR 0033). Over http and for the runner, the rules for stdio
 * refuse. The runner has its own account and its own required settings.
 */
export type Transport = 'stdio' | 'http' | 'runner';

/** The checked configuration, deeply frozen. */
export interface EccliumConfig {
  readonly transport: Transport;
  /** The canonical https origin, without a slash at the end. */
  readonly churchtoolsOrigin: string;
  readonly churchtoolsToken: Secret;
  readonly tokenSource: 'file' | 'environment';
  /** Requests per minute to ChurchTools, for the throttle (ADR 0057). */
  readonly churchtoolsRequestsPerMinute: number;
  readonly readOnly: boolean;
  /**
   * The level of redaction. `off` only over stdio; `strict` only with
   * {@link EccliumConfig.pseudonymKey} and without the toolset `api`
   * (ADR 0069).
   */
  readonly redaction: RedactionLevel;
  /**
   * The secret for the pseudonyms of the level `strict`, or undefined when
   * the variable is not set (ADR 0069).
   */
  readonly pseudonymKey: KeyMaterial | undefined;
  /**
   * The previous secret while the operator changes it, or undefined. It
   * never comes without {@link EccliumConfig.pseudonymKey} and never holds
   * the same bytes.
   */
  readonly pseudonymKeyPrevious: KeyMaterial | undefined;
  /**
   * The toolsets the operator turned on, frozen, in the order of the
   * names of the toolsets; empty for none (ADR 0062).
   */
  readonly toolsets: readonly ToolsetName[];
  /**
   * The checked folder of state, or undefined when the variable is not
   * set. With it, the start over stdio writes the audit file into its
   * folder `audit` (ADR 0028).
   */
  readonly stateDir: string | undefined;
  /**
   * The checked folder of the day keys, or undefined when the variable is
   * not set (ADR 0031). It is set whenever the server writes, and never
   * the folder of state or a folder in it.
   */
  readonly keysDir: string | undefined;
  /**
   * Whether a write keeps a snapshot of what it changes, true unless
   * `ECCLIUM_SNAPSHOTS` is `off` (ADR 0031). Without them every write is
   * sealed as not reversible, and a start that writes warns.
   */
  readonly snapshots: boolean;
  /**
   * How a write gets confirmed (ADR 0029). With `echo-allowed` the core
   * asks the client when it declares elicitation, else takes the echo
   * where the plan allows it, else puts the write into the queue of the
   * operator; with `elicitation-or-queue` it never takes the echo; with
   * `queue` every write goes into the queue. Without the variable,
   * `echo-allowed` over stdio and `elicitation-or-queue` over HTTP.
   */
  readonly writeConfirmation: WriteConfirmation;
  /**
   * The zone in which the texts of a confirmation, the queue and `ecclium
   * undo` show the times of appointments and bookings, a name of the time
   * zone database such as `Europe/Zurich` or `UTC`, or undefined when the
   * variable is not set: then they show UTC. The tools take UTC either way.
   */
  readonly timeZone: string | undefined;
  /**
   * How many months the audit files stay before the start or a new UTC day
   * deletes them, 1 to 120 (ADR 0028). Without a folder of state there are
   * no files, and the value does nothing.
   */
  readonly auditRetentionMonths: number;
  /**
   * The checked policy from `ECCLIUM_POLICY_FILE`, or the default policy
   * when the variable is not set (ADR 0032). Read at the start, also when
   * the server only reads, because the read budget comes from it.
   */
  readonly policy: Policy;
  /**
   * The secret behind the check codes of the marking, or undefined when the
   * variable is not set (ADR 0032). It is backed up, never destroyed, and
   * never the key of the pseudonyms.
   */
  readonly markerKey: KeyMaterial | undefined;
  /**
   * The folder of the routines, an absolute normalised path, or undefined
   * when the variable is not set (ADR 0033). The runner and `ecclium
   * policy init --routine` load the routines in it; the start checks the
   * form of the path alone.
   */
  readonly routinesDir: string | undefined;
  /**
   * The checked providers of language models from `ECCLIUM_PROVIDERS_FILE`,
   * in the order of the file, or undefined when the variable is not set
   * (ADR 0033). The files of the keys are not read here: the composition
   * root reads the file of a key when it builds the transport of its
   * provider, so the server over stdio never holds one.
   */
  readonly providers: readonly ProviderSettings[] | undefined;
  /**
   * The folder of the token files of the accounts of the runner, an
   * absolute normalised path, or undefined when the variable is not set
   * (ADR 0033). It holds one file `ct_token_<alias>` per alias of the
   * policy, which the composition root reads anew for each run and for
   * the approval of an entry of a run; the start checks the form of the
   * path alone.
   */
  readonly runnerTokensDir: string | undefined;
  /**
   * The folder of the drafts of the channel `file`, an absolute normalised
   * path, or undefined when the variable is not set (ADR 0033). The runner
   * writes one private file `<routine>-<period>.md` per routine and period
   * into it and prepares the folder itself; the start checks the form of
   * the path alone. How long a draft stays is the operator's matter
   * (ADR 0031).
   */
  readonly draftsDir: string | undefined;
  /**
   * The file of the notices of the channel `file`, an absolute normalised
   * path, or undefined when the variable is not set (ADR 0033). The runner
   * appends one line per run to it, never content, and creates it itself;
   * the start checks the form of the path alone.
   */
  readonly notifyFile: string | undefined;
  /**
   * The metrics file of the runner, an absolute normalised path, or
   * undefined when the variable is not set (ADR 0033). The runner replaces
   * it whole after each pass, in a private folder it prepares itself; the
   * start checks the form of the path alone.
   */
  readonly metricsFile: string | undefined;
  /**
   * The address of the ping of the runner, in the format of Healthchecks,
   * or undefined when the variable is not set or the transport is no
   * runner (ADR 0009). The start of the runner reads it from the file of
   * `ECCLIUM_RUNNER_PING_URL_FILE` with the checks of the token file and
   * keeps it as a secret, because whoever knows its path can report to
   * the check; a new address takes effect with a restart. A server checks
   * the form of the path alone and never reads the file.
   */
  readonly runnerPingUrl: Secret | undefined;
  /**
   * The origin of the address of the ping, `https://host` or
   * `https://host:port`, set exactly when {@link EccliumConfig.runnerPingUrl}
   * is. No secret: `ecclium init egress` names it in the list of the proxy
   * (ADR 0035), never the path of the address.
   */
  readonly runnerPingOrigin: string | undefined;
  /**
   * The proxy of every transport of the process, `http://host:port` as
   * checked, or undefined to connect directly (ADR 0035).
   */
  readonly egressProxy: string | undefined;
  /**
   * Whether `ECCLIUM_EGRESS` is `off`: the runner then starts without a
   * proxy, warns and notes it on every line of a run in the audit
   * (ADR 0035). Never true together with a proxy.
   */
  readonly egressOff: boolean;
  /**
   * The targets in the local network from `ECCLIUM_EGRESS_ALLOW_LAN`, as
   * https origins with the port left out for 443, frozen, in the order
   * given; empty when the variable is not set (ADR 0035). Each is the
   * origin of ChurchTools or of the endpoint of a provider. Only the list
   * of the proxy uses them: there a target may have any port and a
   * private address.
   */
  readonly egressAllowLan: readonly string[];
  readonly stdioSubject: string;
  readonly logLevel: LogLevel;
}

/** A setting of the configuration, as the report lists it. */
export type SettingKey =
  | 'churchtoolsOrigin'
  | 'churchtoolsToken'
  | 'churchtoolsRequestsPerMinute'
  | 'readOnly'
  | 'redaction'
  | 'pseudonymKey'
  | 'pseudonymKeyPrevious'
  | 'toolsets'
  | 'stateDir'
  | 'keysDir'
  | 'snapshots'
  | 'writeConfirmation'
  | 'timeZone'
  | 'auditRetentionMonths'
  | 'policy'
  | 'markerKey'
  | 'routinesDir'
  | 'providers'
  | 'runnerTokensDir'
  | 'draftsDir'
  | 'notifyFile'
  | 'metricsFile'
  | 'runnerPingUrl'
  | 'egressProxy'
  | 'egress'
  | 'egressAllowLan'
  | 'stdioSubject'
  | 'logLevel';

/** Where a value comes from. Phase 1 knows no other source. */
export type ValueOrigin = 'environment' | 'file' | 'default';

/**
 * What the report may show of a value: an entry of the table, or a value
 * that passed its check, such as the subject, the host of the address or
 * the folders of state and of keys. Never a refused value, and never anything of the
 * token, not even the path of its file.
 */
export type ShownValue =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'choice'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly string[] }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'origin'; readonly host: string; readonly port: string }
  | { readonly kind: 'proxy'; readonly host: string; readonly port: string }
  | {
      readonly kind: 'targets';
      readonly values: readonly {
        readonly host: string;
        /** Always written out, also 443. */
        readonly port: string;
      }[];
    }
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'none' };

/** One setting in the report. */
export interface SettingReport {
  readonly key: SettingKey;
  /** The variable that set the value, or would set it. */
  readonly variable: VariableName;
  /**
   * Where the value comes from. `unset` is a setting without a default
   * that may stay unset, such as the folder of state; `missing` is one the
   * configuration needs.
   */
  readonly origin: ValueOrigin | 'unset' | 'missing' | 'invalid';
  readonly shown: ShownValue;
}

/** One problem in the report. */
export interface ConfigProblem {
  readonly code: ConfigProblemCode;
  /**
   * The variable: a known name, the right name for one in the wrong case,
   * the variable of TLS, `NODE_DEBUG`, `LOG_TOKENS` or `LOG_STREAM`,
   * `NODE_OPTIONS` for an option of TLS in it, or an unknown name in
   * capitals, digits and underscores of at most 64 characters after the
   * prefix. Absent for any other name and for an option Node.js was started
   * with.
   */
  readonly variable?: string;
  /**
   * For a problem of the file of the policy: the path of the field, such as
   * `interactive.targets[2].maxPerDay`, made of names of the schema and
   * positions only, never of a value or an unknown name (ADR 0032).
   */
  readonly field?: string;
  /** For a problem of the YAML of the file of the policy: its line, from 1. */
  readonly line?: number;
}

/**
 * What the loader found, deeply frozen. It never holds the token, the path
 * of the token file or a value it refused. It does hold the checked host,
 * port, folders of state and of keys and subject, which the command line
 * masks unless asked to show them.
 */
export interface ConfigReport {
  readonly transport: Transport;
  /** One entry per setting, in a fixed order. */
  readonly settings: readonly SettingReport[];
  /** The first {@link maxReportedProblems} problems, in a fixed order. */
  readonly problems: readonly ConfigProblem[];
  /** How many problems did not fit into the list. */
  readonly omittedProblems: number;
  /** Also reported when the load fails. */
  readonly warnings: readonly ConfigWarningCode[];
}

/** The configuration with its report, or the report alone. */
export type ConfigResult =
  | {
      readonly ok: true;
      readonly config: EccliumConfig;
      readonly report: ConfigReport;
    }
  | { readonly ok: false; readonly report: ConfigReport };

/** What the loader reads. */
export interface ConfigSources {
  /** The environment, such as `process.env`, which the loader never changes. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly transport: Transport;
  /**
   * The options Node.js was started with, such as `process.execArgv`,
   * which the loader never changes. It reads them, like `NODE_OPTIONS`,
   * only for the options of TLS. None when absent.
   */
  readonly execArgv?: readonly string[];
  /**
   * The file functions for the token file, the key files for pseudonyms
   * and the file of the policy, only for tests.
   */
  readonly tokenFiles?: TokenFileSystem;
  /**
   * The file functions for the folders of state and of keys, only for
   * tests.
   */
  readonly stateDirFiles?: StateDirFileSystem;
}

/** The most problems a report lists. */
export const maxReportedProblems = 32;

const invalidSources = 'The configuration sources are invalid.';

// An unknown name is shown only in this form. Anchored and bounded, so it
// costs nothing on a huge name.
const reportableNamePattern = /^ECCLIUM_[A-Z0-9_]{1,64}$/;

// The proxy first: Array.isArray throws on a revoked proxy.
const isRecord = (value: unknown): value is object =>
  typeof value === 'object' &&
  value !== null &&
  !isProxy(value) &&
  !Array.isArray(value) &&
  !isMap(value) &&
  !isSetObject(value) &&
  !isBoxedPrimitive(value);

// An own data property. A getter would run code of the caller and could
// give another value on every read, so an accessor is refused unread.
const ownData = (object: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new TypeError(invalidSources);
  return descriptor.value as unknown;
};

// Capitals in ASCII only. toUpperCase would turn a dotless i or a long s
// into I or S and so make a lookalike name a known one.
const asciiUpper = (text: string): string => {
  let upper = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    upper += String.fromCharCode(
      code >= 0x61 && code <= 0x7a ? code - 0x20 : code,
    );
  }
  return upper;
};

// NODE_DEBUG holds patterns separated by commas, and Node.js switches on
// every section a pattern names, with * for any run of characters. Any
// pattern with more than blanks counts, whichever section it names.
const switchesOnDebugOutput = (value: string): boolean =>
  value.split(',').some((pattern) => pattern.trim() !== '');

// The variables without the prefix that the loader reads, in capitals.
const nodeVariableNames: readonly string[] = Object.freeze([
  tlsVariableName,
  debugVariableName,
  ...yamlDebugVariableNames,
  nodeOptionsVariableName,
  ...environmentProxyVariableNames,
  ...trustStoreVariableNames,
]);

// Windows looks up the names of the environment without regard to case,
// so there Node.js also reads node_tls_reject_unauthorized. Every spelling
// counts, on every platform. The length first, so that a huge name costs
// nothing.
const nodeVariableOf = (key: string): string | undefined =>
  nodeVariableNames.find(
    (name) => key.length === name.length && asciiUpper(key) === name,
  );

// The options in NODE_OPTIONS, split as Node.js splits them: a space ends
// an option outside double quotes, a double quote opens or closes a quoted
// part anywhere in an option, and inside one a backslash takes the next
// character as it is. A tab or a single quote is a plain character. Node.js
// refuses an unclosed quote; the options read until then still count.
const nodeOptionsOf = (value: string): string[] => {
  const options: string[] = [];
  let option: string | undefined;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    let character = value.charAt(index);
    if (quoted && character === '\\') {
      index += 1;
      if (index === value.length) break;
      character = value.charAt(index);
    } else if (!quoted && character === ' ') {
      if (option !== undefined) options.push(option);
      option = undefined;
      continue;
    } else if (character === '"') {
      quoted = !quoted;
      continue;
    }
    option = (option ?? '') + character;
  }
  if (option !== undefined) options.push(option);
  return options;
};

// The name of an option as Node.js compares it: the part before an equals
// sign, with every underscore as a hyphen, so that --use_system_ca counts
// as --use-system-ca. Capitals stay, because Node.js refuses them.
const optionName = (option: string): string => {
  const equals = option.indexOf('=');
  return (equals < 0 ? option : option.slice(0, equals)).replaceAll('_', '-');
};

// The options Node.js was started with, as a plain array of strings read
// index by index as own data properties: a getter is refused unread, and
// a hole counts as no string. The proxy first, as Array.isArray throws on
// a revoked one.
const optionList = (value: unknown): readonly string[] => {
  if (
    typeof value !== 'object' ||
    value === null ||
    isProxy(value) ||
    !Array.isArray(value)
  ) {
    throw new TypeError(invalidSources);
  }
  const options: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const option = ownData(value, String(index));
    if (typeof option !== 'string') throw new TypeError(invalidSources);
    options.push(option);
  }
  return options;
};

const record = <T extends object>(fields: T): T =>
  Object.freeze({ __proto__: null, ...fields });

const row = (name: VariableName): Variable => {
  const found = variables.find((variable) => variable.name === name);
  if (found === undefined) throw new TypeError('Unknown variable.');
  return found;
};

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value !== '';

interface Ranked {
  readonly rank: number;
  readonly name: string;
  readonly problem: ConfigProblem;
}

// The order of the problems: the variables in table order, then the
// variables of TLS and of debug output, also of the library for YAML, then
// the options that log TLS, then the names of later phases and of the
// replaced switch for the search tools, then unknown names by code unit,
// then those too odd to name.
const tlsRank = variableNames.length;
const debugRank = tlsRank + 1;
const yamlDebugRank = debugRank + 1;
const keylogRank = yamlDebugRank + 1;
const traceRank = keylogRank + 1;
const unsupportedRank = traceRank + 1;
const replacedRank = unsupportedRank + unsupportedVariableNames.length;
const unknownRank = replacedRank + 1;

/** What a name with the prefix is: a known variable or a problem. */
type SortedName =
  | { readonly kind: 'known'; readonly name: VariableName }
  | {
      readonly kind: 'problem';
      readonly code: ConfigProblemCode;
      readonly rank: number;
      readonly variable?: string;
    };

// Names are sorted out before any value is looked at, so a name that is
// wrong never has its value checked. Shared by both loaders, so that the
// commands for the audit refuse the same names as the start.
const sortName = (key: string): SortedName => {
  const upper = asciiUpper(key);
  const unsupported = (unsupportedVariableNames as readonly string[]).indexOf(
    upper,
  );
  const known = (variableNames as readonly string[]).indexOf(upper);
  const problem = (
    code: ConfigProblemCode,
    rank: number,
    variable?: string,
  ): SortedName =>
    variable === undefined
      ? { kind: 'problem', code, rank }
      : { kind: 'problem', code, rank, variable };
  if (upper === searchToolsVariableName) {
    return problem(
      'search_tools_replaced',
      replacedRank,
      searchToolsVariableName,
    );
  }
  if (unsupported >= 0) {
    return problem(
      'unsupported_variable',
      unsupportedRank + unsupported,
      upper,
    );
  }
  if (known >= 0 && key !== upper) {
    return problem('miscased_variable', known, upper);
  }
  if (known >= 0) return { kind: 'known', name: upper as VariableName };
  return reportableNamePattern.test(key)
    ? problem('unknown_variable', unknownRank, key)
    : problem('unknown_variable', unknownRank + 1);
};

// The toolsets with tools that give results only with their line in the
// audit file, because they hold special data or name persons: persons, and
// events for the assignments to services (ADR 0028, ADR 0060, ADR 0064).
// The loader sees no tool, so it keeps this list to name the problem
// before a start; the start itself checks every tool of its catalog as the
// second guard.
const toolsetsWithAuditFile: readonly ToolsetName[] = Object.freeze([
  'persons',
  'events',
  'api',
]);

type Read =
  | { readonly state: 'unset' }
  | { readonly state: 'invalid' }
  | { readonly state: 'set'; readonly value: string };

interface Chosen {
  readonly value: string;
  readonly origin: ValueOrigin;
}

const unset: Read = Object.freeze({ state: 'unset' });
const invalid: Read = Object.freeze({ state: 'invalid' });

const shownNone: ShownValue = record({ kind: 'none' });
const shownHidden: ShownValue = record({ kind: 'hidden' });

// Whether a normalised absolute path is a folder or lies in it, by its
// parts: /srv/state-keys does not lie in /srv/state.
const liesWithin = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`);

/**
 * Loads the configuration. Each variable is read from an own data property
 * of the environment, never inherited and never through a getter. A
 * variable is recognised by its prefix in any case; only an exact known
 * name gives a value. Every value is checked against the table, and the
 * token goes only into a `Secret`. The variables of Node.js that weaken
 * TLS count in any spelling of their names, its options also with
 * underscores: `--tls-keylog` and `--trace-tls` stop the start, a wider
 * trust store gives a warning.
 *
 * @param sources - The environment, the transport, the options Node.js
 *   was started with and, for tests, the file functions for the token
 *   file and the folders of state and of keys.
 * @returns The configuration with its report when nothing is wrong, else
 *   the report alone.
 * @throws {TypeError} When the sources or the environment are no plain
 *   record, the options no plain array of strings, a variable that the
 *   loader reads is no string or has a getter, or the transport is
 *   unknown. Never for a wrong value.
 * @example
 * ```ts
 * const result = loadConfig({
 *   environment,
 *   transport: 'stdio',
 *   execArgv: process.execArgv,
 * });
 * if (!result.ok) report(result.report.problems);
 * ```
 */
export function loadConfig(sources: ConfigSources): ConfigResult {
  if (!isRecord(sources)) throw new TypeError(invalidSources);
  const environment = ownData(sources, 'environment');
  const transport = ownData(sources, 'transport');
  const execArgv = ownData(sources, 'execArgv');
  const tokenFiles = ownData(sources, 'tokenFiles');
  const stateDirFiles = ownData(sources, 'stateDirFiles');
  if (!isRecord(environment)) throw new TypeError(invalidSources);
  if (tokenFiles !== undefined && !isRecord(tokenFiles)) {
    throw new TypeError(invalidSources);
  }
  if (stateDirFiles !== undefined && !isRecord(stateDirFiles)) {
    throw new TypeError(invalidSources);
  }
  const startOptions = execArgv === undefined ? [] : optionList(execArgv);
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'runner') {
    throw new TypeError('The transport is unknown.');
  }
  // The runner of routines (ADR 0033, ADR 0034).
  const runner = transport === 'runner';

  const ranked: Ranked[] = [];
  const add = (
    code: ConfigProblemCode,
    rank: number,
    variable?: string,
    where: { readonly field?: string; readonly line?: number } = {},
  ): void => {
    ranked.push({
      rank,
      name: variable ?? '',
      problem: record({
        code,
        ...(variable === undefined ? {} : { variable }),
        ...(where.field === undefined ? {} : { field: where.field }),
        ...(where.line === undefined ? {} : { line: where.line }),
      }),
    });
  };
  const report = (code: ConfigProblemCode, name: VariableName): void => {
    add(code, variableNames.indexOf(name), name);
  };

  // The snapshot. Only names with the prefix and the variables of Node.js
  // listed above are read at all; the values of others are never touched.
  const given = new Map<VariableName, string>();
  const inNodeOptions = new Set<string>();
  // The variables of debug output of the library for YAML that are set,
  // each in capitals, for the file of the policy below.
  const yamlDebug = new Set<string>();
  let trustStoreExtended = false;
  // Whether a proxy of the shell, of Node.js or of undici is set, which
  // Ecclium does not use (ADR 0035).
  let environmentProxy = false;
  for (const key of Object.keys(environment)) {
    const prefixed =
      asciiUpper(key.slice(0, variablePrefix.length)) === variablePrefix;
    const node = prefixed ? undefined : nodeVariableOf(key);
    if (!prefixed && node === undefined) continue;
    const value = ownData(environment, key);
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new TypeError(invalidSources);
    if (node === tlsVariableName) {
      if (value === '0') add('tls_check_disabled', tlsRank, tlsVariableName);
      continue;
    }
    if (node === debugVariableName) {
      if (switchesOnDebugOutput(value)) {
        add('debug_output_enabled', debugRank, debugVariableName);
      }
      continue;
    }
    // The library reads them as true for any value but an empty one.
    if ((yamlDebugVariableNames as readonly string[]).includes(node ?? '')) {
      if (isSet(value)) yamlDebug.add(node as string);
      continue;
    }
    if (node === nodeOptionsVariableName) {
      for (const option of nodeOptionsOf(value)) {
        inNodeOptions.add(optionName(option));
      }
      continue;
    }
    if (
      (environmentProxyVariableNames as readonly string[]).includes(node ?? '')
    ) {
      if (isSet(value)) environmentProxy = true;
      continue;
    }
    if (node !== undefined) {
      // A variable of the trust store. Node.js documents only the value 1
      // for NODE_USE_SYSTEM_CA; any value counts, so that a release that
      // takes more is still caught. An empty one does nothing.
      if (isSet(value)) trustStoreExtended = true;
      continue;
    }
    const sorted = sortName(key);
    if (sorted.kind === 'known') given.set(sorted.name, value);
    else add(sorted.code, sorted.rank, sorted.variable);
  }

  // The options of TLS, in NODE_OPTIONS and among those Node.js was started
  // with, compared by name only. Nothing of an option, such as the path
  // after --tls-keylog, reaches the report.
  const startedWith = new Set(startOptions.map(optionName));
  for (const [names, variable] of [
    [inNodeOptions, nodeOptionsVariableName],
    [startedWith, undefined],
  ] as const) {
    if (names.has(tlsKeylogOption)) {
      add('tls_keylog_enabled', keylogRank, variable);
    }
    if (names.has(tlsTraceOption)) {
      add('tls_trace_enabled', traceRank, variable);
    }
    if (trustStoreOptions.some((option) => names.has(option))) {
      trustStoreExtended = true;
    }
    if (names.has(environmentProxyOption)) environmentProxy = true;
  }

  const read = (variable: Variable): Read => {
    const value = given.get(variable.name);
    if (value === undefined) return unset;
    // The runner has a rule of its own per variable: it may set the
    // folders and the retention a start over stdio may set, but not what
    // belongs to the local start only (ADR 0033).
    if (
      runner ? !variable.runner : variable.stdioOnly && transport !== 'stdio'
    ) {
      // The token file of the server has a code of its own for the runner,
      // whose text points to the account of the runner (ADR 0023).
      report(
        !runner
          ? 'stdio_only'
          : variable.name === 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE'
            ? 'runner_server_token'
            : 'runner_stdio_only',
        variable.name,
      );
      return invalid;
    }
    if (value === '') {
      report('empty_value', variable.name);
      return invalid;
    }
    if (value.length > variable.maxLength) {
      report('value_too_long', variable.name);
      return invalid;
    }
    return Object.freeze({ state: 'set', value });
  };

  const warnings = new Set<ConfigWarningCode>();
  const settings: SettingReport[] = [];
  const setting = (
    key: SettingKey,
    variable: VariableName,
    origin: SettingReport['origin'],
    shown: ShownValue,
  ): void => {
    settings.push(record({ key, variable, origin, shown }));
  };

  // A boolean or a choice. The value kept is the entry of the table, not
  // the input, and zod is only asked whether the input fits.
  const choose = (name: PlainVariableName): Chosen | undefined => {
    const variable = row(name);
    const result = read(variable);
    if (result.state === 'unset') {
      return variable.defaultValue === undefined
        ? undefined
        : { value: variable.defaultValue, origin: 'default' };
    }
    if (result.state === 'invalid') return undefined;
    const entry = variable.choices.find((choice) => choice === result.value);
    if (entry === undefined || !fitsVariable(name, result.value)) {
      report('invalid_choice', name);
      return undefined;
    }
    return { value: entry, origin: 'environment' };
  };

  const show = (
    key: SettingKey,
    name: VariableName,
    chosen: Chosen | undefined,
    kind: 'boolean' | 'choice',
  ): void => {
    if (chosen === undefined) {
      setting(key, name, 'invalid', shownNone);
    } else if (kind === 'boolean') {
      setting(
        key,
        name,
        chosen.origin,
        record({ kind, value: chosen.value === 'true' }),
      );
    } else {
      setting(key, name, chosen.origin, record({ kind, value: chosen.value }));
    }
  };

  // The address of the instance.
  const urlName = 'ECCLIUM_CHURCHTOOLS_URL';
  const url = read(row(urlName));
  let origin: string | undefined;
  if (url.state === 'unset') {
    report('url_missing', urlName);
    setting('churchtoolsOrigin', urlName, 'missing', shownNone);
  } else if (url.state === 'invalid') {
    setting('churchtoolsOrigin', urlName, 'invalid', shownNone);
  } else {
    const parsed = parseChurchToolsOrigin(url.value);
    if (parsed.ok) {
      origin = parsed.origin;
      // The origin holds no user, path or IPv6 address, so the only colon
      // after the scheme starts the port.
      const [host = '', port = ''] = origin.slice('https://'.length).split(':');
      setting(
        'churchtoolsOrigin',
        urlName,
        'environment',
        record({ kind: 'origin', host, port }),
      );
    } else {
      report(parsed.code, urlName);
      setting('churchtoolsOrigin', urlName, 'invalid', shownNone);
    }
  }

  // The token, from the file or, over stdio only, from the environment.
  // An empty value is reported as such and counts for nothing else. The
  // runner never holds the token of the server (ADR 0023): its own account
  // comes from the folder of its token files further down, and a file of
  // the server set for it stops its start, so that its container does not
  // keep the token of the server by mistake.
  const fileName = 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE';
  const fileGiven = isSet(given.get(fileName));
  const environmentGiven = isSet(given.get(tokenVariableName));
  const file = read(row(fileName));
  const fromEnvironment = read(row(tokenVariableName));
  if (transport === 'stdio' && environmentGiven) {
    warnings.add('token_from_environment');
  }
  let token: Secret | undefined;
  let tokenVariable: VariableName =
    environmentGiven && !fileGiven ? tokenVariableName : fileName;
  if (runner) {
    // Both are refused by read above, and the file is not opened.
  } else if (fileGiven && environmentGiven) {
    // Neither source wins silently, and the file is not opened.
    report('token_conflict', tokenVariableName);
  } else if (file.state === 'set') {
    const fromFile = readTokenFile(
      file.value,
      (value) => new Secret(value),
      tokenFiles as TokenFileSystem | undefined,
    );
    if (fromFile.ok) token = fromFile.value;
    else report(fromFile.code, fileName);
  } else if (fromEnvironment.state === 'set') {
    try {
      token = new Secret(fromEnvironment.value);
    } catch {
      // A RangeError with a fixed message; the code is all that counts.
      report('token_invalid', tokenVariableName);
    }
  } else if (file.state === 'unset' && fromEnvironment.state === 'unset') {
    report('token_missing', fileName);
  }
  const tokenSource: 'file' | 'environment' =
    tokenVariable === tokenVariableName && !runner ? 'environment' : 'file';
  if (runner) {
    // Reported with the folder of the token files, further down.
  } else if (token !== undefined) {
    setting('churchtoolsToken', tokenVariable, tokenSource, shownHidden);
  } else {
    if (!fileGiven && !environmentGiven) tokenVariable = fileName;
    const missing =
      given.get(fileName) === undefined &&
      given.get(tokenVariableName) === undefined;
    setting(
      'churchtoolsToken',
      tokenVariable,
      missing ? 'missing' : 'invalid',
      shownNone,
    );
  }

  // The requests per minute: digits only, checked sign by sign. The value
  // kept is the number, and a refused value never reaches the report.
  const rateName = 'ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE';
  const rateVariable = row(rateName);
  const rateRead = read(rateVariable);
  let rate:
    { readonly value: number; readonly origin: ValueOrigin } | undefined;
  if (rateRead.state === 'unset') {
    rate = { value: Number(rateVariable.defaultValue), origin: 'default' };
  } else if (rateRead.state === 'set') {
    if (fitsVariable(rateName, rateRead.value)) {
      rate = { value: Number(rateRead.value), origin: 'environment' };
    } else {
      report('invalid_integer', rateName);
    }
  }
  setting(
    'churchtoolsRequestsPerMinute',
    rateName,
    rate === undefined ? 'invalid' : rate.origin,
    rate === undefined
      ? shownNone
      : record({ kind: 'integer', value: rate.value }),
  );

  const readOnly = choose('ECCLIUM_READ_ONLY');
  show('readOnly', 'ECCLIUM_READ_ONLY', readOnly, 'boolean');
  // Every start that may write says so (ADR 0029): false is the one switch
  // that lets the write tools in and lets undo and an approval of the
  // queue write. It does not wait for a toolset with write tools, so that
  // the operator hears of the switch before any tool uses it.
  if (readOnly?.value === 'false') warnings.add('writes_enabled');

  // off is allowed over stdio only, with a warning on every start. strict
  // needs the key file and refuses the toolset api, both checked below
  // (ADR 0069).
  let redaction = choose('ECCLIUM_REDACTION');
  const strict = redaction?.value === 'strict';
  if (redaction?.value === 'off' && transport !== 'stdio') {
    report(runner ? 'runner_stdio_only' : 'stdio_only', 'ECCLIUM_REDACTION');
    redaction = undefined;
  } else if (redaction?.value === 'off') {
    warnings.add('redaction_off');
  }
  show('redaction', 'ECCLIUM_REDACTION', redaction, 'choice');

  // The secret for pseudonyms and, while the operator changes it, the
  // previous one (ADR 0069). Both may stay unset, unless the level is
  // strict, which needs the first. The files get the checks of the token file, and no
  // report holds their paths. The previous one alone, or the same bytes
  // twice, is an error rather than a key change that changes nothing.
  const readKey = (
    name: 'ECCLIUM_PSEUDONYM_KEY_FILE' | 'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE',
  ): {
    readonly given: boolean;
    readonly read: Read;
    readonly key: KeyMaterial | undefined;
  } => {
    const keyRead = read(row(name));
    // A value that passed the checks of every variable, whatever its file
    // holds. An empty or too long value has its own problem.
    const given = keyRead.state === 'set';
    if (keyRead.state !== 'set')
      return { given, read: keyRead, key: undefined };
    const fromFile = readPseudonymKeyFile(
      keyRead.value,
      tokenFiles as TokenFileSystem | undefined,
    );
    if (fromFile.ok) return { given, read: keyRead, key: fromFile.value };
    report(fromFile.code, name);
    return { given, read: invalid, key: undefined };
  };
  const keyName = 'ECCLIUM_PSEUDONYM_KEY_FILE';
  const previousName = 'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE';
  const current = readKey(keyName);
  const previous = readKey(previousName);
  // strict turns IDs of persons into pseudonyms with this key, so it does
  // not start without one. A file that is set but refused has its own
  // problem (ADR 0069).
  if (strict && current.read.state === 'unset') {
    report('pseudonym_key_missing', keyName);
  }
  // Reported also when the previous file has a problem of its own, so that
  // the operator sees both at once.
  let previousValid = previous.read.state !== 'invalid';
  if (previous.given && !current.given) {
    report('pseudonym_key_previous_without_current', previousName);
    previousValid = false;
  } else if (
    previous.key !== undefined &&
    current.key !== undefined &&
    current.key.sameAs(previous.key)
  ) {
    report('pseudonym_key_same', previousName);
    previousValid = false;
  } else if (previous.key !== undefined && current.key !== undefined) {
    warnings.add('pseudonym_key_change');
  }
  const keyValid = current.read.state !== 'invalid';
  setting(
    'pseudonymKey',
    keyName,
    current.key !== undefined ? 'file' : keyValid ? 'unset' : 'invalid',
    current.key !== undefined ? shownHidden : shownNone,
  );
  setting(
    'pseudonymKeyPrevious',
    previousName,
    previous.key !== undefined && previousValid
      ? 'file'
      : previousValid
        ? 'unset'
        : 'invalid',
    previous.key !== undefined && previousValid ? shownHidden : shownNone,
  );

  // The toolsets. Unlike any other variable, an empty value is valid and
  // means none, as when the variable is not set (ADR 0062). The toolset
  // persons lets the AI assistant see names of persons and groups, which
  // every start says (ADR 0060).
  const toolsetsName = 'ECCLIUM_TOOLSETS';
  const toolsetsRead: Read =
    given.get(toolsetsName) === ''
      ? Object.freeze({ state: 'set', value: '' })
      : read(row(toolsetsName));
  let toolsets:
    | { readonly value: readonly ToolsetName[]; readonly origin: ValueOrigin }
    | undefined;
  if (toolsetsRead.state === 'unset') {
    toolsets = { value: Object.freeze([]), origin: 'default' };
  } else if (toolsetsRead.state === 'set') {
    const list = readToolsetList(toolsetsRead.value);
    if (list === undefined || !fitsVariable(toolsetsName, toolsetsRead.value)) {
      report('invalid_toolsets', toolsetsName);
    } else {
      toolsets = { value: list, origin: 'environment' };
    }
  }
  if (toolsets?.value.includes('persons') === true) {
    warnings.add('persons_toolset_enabled');
  }
  // The assignments to services name persons as well (ADR 0064).
  if (toolsets?.value.includes('events') === true) {
    warnings.add('events_toolset_enabled');
  }
  // The escape hatch passes on whole answers, not fixed fields (ADR 0067).
  // Their schema is unknown, so strict could not keep its promise for
  // them and refuses the toolset (ADR 0069).
  if (toolsets?.value.includes('api') === true) {
    warnings.add('api_toolset_enabled');
    if (strict) report('redaction_strict_with_api', toolsetsName);
  }
  setting(
    'toolsets',
    toolsetsName,
    toolsets === undefined ? 'invalid' : toolsets.origin,
    toolsets === undefined
      ? shownNone
      : record({ kind: 'list', values: toolsets.value }),
  );

  // The folder of state may stay unset: then there is no audit file. A set
  // one is only looked at, never created, and the start checks its folder
  // audit and the file again before it writes (ADR 0028).
  const stateDirName = 'ECCLIUM_STATE_DIR';
  const stateDirRead = read(row(stateDirName));
  let stateDir: string | undefined;
  let stateDirValid = true;
  if (stateDirRead.state === 'unset') {
    setting('stateDir', stateDirName, runner ? 'missing' : 'unset', shownNone);
  } else if (stateDirRead.state === 'invalid') {
    stateDirValid = false;
    setting('stateDir', stateDirName, 'invalid', shownNone);
  } else {
    const checked = checkStateDir(
      stateDirRead.value,
      stateDirFiles as StateDirFileSystem | undefined,
    );
    if (checked.ok) {
      stateDir = stateDirRead.value;
      setting(
        'stateDir',
        stateDirName,
        'environment',
        record({ kind: 'path', value: stateDir }),
      );
    } else {
      report(checked.code, stateDirName);
      stateDirValid = false;
      setting('stateDir', stateDirName, 'invalid', shownNone);
    }
  }

  // Over stdio, the tools of these toolsets need the folder of the audit
  // file (ADR 0028, ADR 0060). Reported here already, so that `ecclium
  // config check` names it before a start. A folder that is set but
  // refused has its own problem.
  if (
    transport === 'stdio' &&
    toolsets?.value.some((name) => toolsetsWithAuditFile.includes(name)) ===
      true &&
    stateDirRead.state === 'unset'
  ) {
    report('toolsets_without_state_dir', stateDirName);
  }

  // Writing over stdio needs the folder of state and its folder stop
  // (ADR 0029): the audit file, the snapshots, the queue, the counters of
  // the policy and the kill switches live there. Without them a write
  // would end with policy_denied each time, so the start refuses up front
  // and offers no write tool that could never write. A folder stop that
  // goes away later stops writing at the next look, as before. Over HTTP
  // the folder of keys is refused, so a server there does not write.
  // The runner writes with the same folders as a server over stdio.
  if ((transport === 'stdio' || runner) && readOnly?.value === 'false') {
    if (stateDirRead.state === 'unset') {
      // The runner needs the folder in any case and reports it so below.
      if (!runner) report('writes_without_state_dir', stateDirName);
    } else if (
      stateDir !== undefined &&
      !hasStopDir(stateDir, stateDirFiles as StateDirFileSystem | undefined)
    ) {
      report('writes_without_stop_dir', stateDirName);
    }
  }

  // The folder of the day keys (ADR 0031). Every write keeps a snapshot of
  // what it changes, encrypted with a day key from this folder, so the
  // server writes only with it. Reading needs none, but a folder that is
  // set is checked all the same: the start then destroys the day keys past
  // their retention. Like the folder of state it is only looked at here.
  // It must not be the folder of state or lie in it, because a backup of
  // that folder would then hold the keys that open its snapshots, also
  // those that were destroyed. Nor may the folder of state lie in it:
  // then the folder of a purpose could be the folder of state itself, and
  // keeping the folder of keys out of a backup would keep the audit out as
  // well. Compared as text: both paths passed as absolute and normalised,
  // and the folders above them are trusted.
  const keysDirName = 'ECCLIUM_KEYS_DIR';
  const keysDirRead = read(row(keysDirName));
  let keysDir: string | undefined;
  let keysDirValid = true;
  if (keysDirRead.state === 'unset') {
    // Over HTTP as well: there the variable is refused, so a server over
    // HTTP does not write in this version.
    if (readOnly?.value === 'false') {
      report('keys_dir_required', keysDirName);
      keysDirValid = false;
      setting('keysDir', keysDirName, 'missing', shownNone);
    } else {
      setting('keysDir', keysDirName, 'unset', shownNone);
    }
  } else if (keysDirRead.state === 'invalid') {
    keysDirValid = false;
    setting('keysDir', keysDirName, 'invalid', shownNone);
  } else {
    const value = keysDirRead.value;
    const stateDirValue =
      stateDirRead.state === 'set' ? stateDirRead.value : undefined;
    const checked =
      isNormalizedAbsolutePath(value) &&
      stateDirValue !== undefined &&
      isNormalizedAbsolutePath(stateDirValue) &&
      liesWithin(value, stateDirValue)
        ? ({ ok: false, code: 'keys_dir_in_state_dir' } as const)
        : isNormalizedAbsolutePath(value) &&
            stateDirValue !== undefined &&
            isNormalizedAbsolutePath(stateDirValue) &&
            liesWithin(stateDirValue, value)
          ? ({ ok: false, code: 'state_dir_in_keys_dir' } as const)
          : checkKeysDir(
              value,
              stateDirFiles as StateDirFileSystem | undefined,
            );
    if (checked.ok) {
      keysDir = value;
      setting(
        'keysDir',
        keysDirName,
        'environment',
        record({ kind: 'path', value: keysDir }),
      );
    } else {
      report(checked.code, keysDirName);
      keysDirValid = false;
      setting('keysDir', keysDirName, 'invalid', shownNone);
    }
  }

  // The snapshots of writes (ADR 0031), on by default. Turned off, no
  // write can be taken back, which every start that writes says. A server
  // that only reads keeps none either way, so it says nothing.
  const snapshots = choose('ECCLIUM_SNAPSHOTS');
  show('snapshots', 'ECCLIUM_SNAPSHOTS', snapshots, 'choice');
  if (snapshots?.value === 'off' && readOnly?.value === 'false') {
    warnings.add('snapshots_off');
  }

  // How a write gets confirmed (ADR 0029). The table holds the default
  // over stdio; over HTTP the echo holds only when the operator sets it,
  // so there the default is elicitation-or-queue, and echo-allowed set on
  // purpose warns on every start. The warning does not wait for a start
  // that writes: over HTTP no server writes in this version, and the
  // operator should learn of the choice before one does.
  const confirmationName = 'ECCLIUM_WRITE_CONFIRMATION';
  let confirmation = choose(confirmationName);
  if (confirmation?.origin === 'default' && transport === 'http') {
    confirmation = { value: defaultHttpWriteConfirmation, origin: 'default' };
  }
  show('writeConfirmation', confirmationName, confirmation, 'choice');
  if (
    confirmation?.origin === 'environment' &&
    confirmation.value === 'echo-allowed' &&
    transport === 'http'
  ) {
    warnings.add('echo_over_http');
  }

  // The zone of the texts of times (ADR 0029, ADR 0055). It may stay unset,
  // then the texts show UTC. The value kept is the one given, and zod is
  // only asked whether it fits.
  const timeZoneName = 'ECCLIUM_TIME_ZONE';
  const timeZoneRead = read(row(timeZoneName));
  let timeZone: string | undefined;
  let timeZoneValid = timeZoneRead.state !== 'invalid';
  if (timeZoneRead.state === 'set') {
    if (fitsVariable(timeZoneName, timeZoneRead.value)) {
      timeZone = timeZoneRead.value;
    } else {
      report('time_zone_invalid', timeZoneName);
      timeZoneValid = false;
    }
  }
  setting(
    'timeZone',
    timeZoneName,
    timeZone !== undefined
      ? 'environment'
      : !timeZoneValid
        ? 'invalid'
        : runner
          ? 'missing'
          : 'unset',
    timeZone !== undefined
      ? record({ kind: 'choice', value: timeZone })
      : shownNone,
  );

  // The retention of the audit files: digits only, checked sign by sign.
  // Below a year every start warns, and without the folder of state there
  // is nothing to delete, which every start says (ADR 0028).
  const retentionName = 'ECCLIUM_AUDIT_RETENTION_MONTHS';
  const retentionVariable = row(retentionName);
  const retentionRead = read(retentionVariable);
  let retention:
    { readonly value: number; readonly origin: ValueOrigin } | undefined;
  if (retentionRead.state === 'unset') {
    retention = {
      value: Number(retentionVariable.defaultValue),
      origin: 'default',
    };
  } else if (retentionRead.state === 'set') {
    if (fitsVariable(retentionName, retentionRead.value)) {
      retention = { value: Number(retentionRead.value), origin: 'environment' };
    } else {
      report('invalid_retention', retentionName);
    }
  }
  if (retention?.origin === 'environment' && stateDirRead.state === 'unset') {
    warnings.add('audit_retention_without_state_dir');
  } else if (
    retention !== undefined &&
    retention.value < recommendedRetentionMonths
  ) {
    warnings.add('audit_retention_short');
  }
  setting(
    'auditRetentionMonths',
    retentionName,
    retention === undefined ? 'invalid' : retention.origin,
    retention === undefined
      ? shownNone
      : record({ kind: 'integer', value: retention.value }),
  );

  // The policy (ADR 0032). It is read also when the server only reads,
  // because the read budget comes from it, and without the variable the
  // default policy applies. The file gets checks like the token file, and
  // a problem names the field or the line, never a value. While the
  // library for YAML would write the file to stdout, it is not read.
  const policyName = 'ECCLIUM_POLICY_FILE';
  const policyRead = read(row(policyName));
  // The policy, the folder of the routines and the file of the providers
  // all name files in YAML; each variable of debug output is reported once
  // for all of them.
  let yamlDebugReported = false;
  const reportYamlDebug = (): void => {
    if (yamlDebugReported) return;
    yamlDebugReported = true;
    for (const name of yamlDebugVariableNames) {
      if (yamlDebug.has(name)) {
        add('yaml_debug_output_enabled', yamlDebugRank, name);
      }
    }
  };
  let policy: Policy | undefined;
  if (policyRead.state === 'unset') {
    policy = defaultPolicy;
    setting('policy', policyName, runner ? 'missing' : 'default', shownNone);
  } else if (policyRead.state === 'invalid') {
    setting('policy', policyName, 'invalid', shownNone);
  } else if (yamlDebug.size > 0) {
    reportYamlDebug();
    setting('policy', policyName, 'invalid', shownNone);
  } else {
    const fromFile = readPolicyFile(
      policyRead.value,
      tokenFiles as PolicyFileSystem | undefined,
    );
    if (fromFile.ok) {
      policy = fromFile.policy;
      setting(
        'policy',
        policyName,
        'file',
        record({ kind: 'path', value: policyRead.value }),
      );
    } else {
      add(fromFile.code, variableNames.indexOf(policyName), policyName, {
        ...(fromFile.field === undefined ? {} : { field: fromFile.field }),
        ...(fromFile.line === undefined ? {} : { line: fromFile.line }),
      });
      setting('policy', policyName, 'invalid', shownNone);
    }
  }

  // The secret behind the check codes of the marking (ADR 0032). It may
  // stay unset; the file gets the checks of the token file, and no report
  // holds its path. The key of the pseudonyms in its place would tie two
  // secrets with other lives together, so the same bytes stop the start.
  const markerKeyName = 'ECCLIUM_MARKER_KEY_FILE';
  const markerKeyRead = read(row(markerKeyName));
  let markerKey: KeyMaterial | undefined;
  let markerKeyValid = markerKeyRead.state !== 'invalid';
  if (markerKeyRead.state === 'set') {
    const fromFile = readMarkerKeyFile(
      markerKeyRead.value,
      tokenFiles as TokenFileSystem | undefined,
    );
    if (!fromFile.ok) {
      report(fromFile.code, markerKeyName);
      markerKeyValid = false;
    } else if (
      [current.key, previous.key].some(
        (other) => other !== undefined && fromFile.value.sameAs(other),
      )
    ) {
      report('marker_key_same', markerKeyName);
      markerKeyValid = false;
    } else {
      markerKey = fromFile.value;
    }
  }
  // A server that writes to the wiki marks every page and section it adds,
  // with this key and whom to ask from the policy, so it does not start
  // without either (ADR 0032). A file that is set but refused has its own
  // problem.
  // A runner that may write writes its sections into the wiki, whatever
  // its toolsets: they choose the tools of a server, not the routines.
  const writesToWiki =
    readOnly?.value === 'false' &&
    (runner || toolsets?.value.includes('wiki') === true);
  if (writesToWiki && markerKeyRead.state === 'unset') {
    report('marker_key_missing', markerKeyName);
    markerKeyValid = false;
  }
  // A runner without the file of the policy hears of the file itself,
  // further down.
  if (
    writesToWiki &&
    policy !== undefined &&
    policy.interactive.inquiriesTo === undefined &&
    !(runner && policyRead.state === 'unset')
  ) {
    report('inquiries_missing', policyName);
  }
  setting(
    'markerKey',
    markerKeyName,
    markerKey !== undefined
      ? 'file'
      : markerKeyValid
        ? 'unset'
        : markerKeyRead.state === 'unset'
          ? 'missing'
          : 'invalid',
    markerKey !== undefined ? shownHidden : shownNone,
  );

  // The folder of the routines (ADR 0033). Only the runner reads it, so
  // the start checks the form of the path and nothing on disk. While the
  // library for YAML would write each routine to stdout, the start stops,
  // as for the policy.
  const routinesName = 'ECCLIUM_ROUTINES_DIR';
  const routinesRead = read(row(routinesName));
  let routinesDir: string | undefined;
  let routinesDirValid = routinesRead.state !== 'invalid';
  if (routinesRead.state === 'set') {
    if (!fitsVariable(routinesName, routinesRead.value)) {
      report('routines_dir_invalid', routinesName);
      routinesDirValid = false;
    } else if (yamlDebug.size > 0) {
      reportYamlDebug();
      routinesDirValid = false;
    } else {
      routinesDir = routinesRead.value;
    }
  }
  setting(
    'routinesDir',
    routinesName,
    routinesDir !== undefined
      ? 'environment'
      : !routinesDirValid
        ? 'invalid'
        : runner
          ? 'missing'
          : 'unset',
    routinesDir !== undefined
      ? record({ kind: 'path', value: routinesDir })
      : shownNone,
  );

  // The providers of language models (ADR 0033). The file is read and
  // checked at the start like the policy, so that a provider outside
  // Switzerland and the EEA without a basis of transfer stops every start
  // and `ecclium config check` shows each problem with its field. The
  // files of the keys are not read here.
  const providersName = 'ECCLIUM_PROVIDERS_FILE';
  const providersRead = read(row(providersName));
  let providers: readonly ProviderSettings[] | undefined;
  let providersValid = providersRead.state !== 'invalid';
  if (providersRead.state === 'set') {
    if (yamlDebug.size > 0) {
      reportYamlDebug();
      providersValid = false;
    } else {
      const fromFile = readProvidersFile(
        providersRead.value,
        tokenFiles as PolicyFileSystem | undefined,
      );
      if (fromFile.ok) {
        providers = fromFile.providers;
      } else {
        add(
          fromFile.code,
          variableNames.indexOf(providersName),
          providersName,
          {
            ...(fromFile.field === undefined ? {} : { field: fromFile.field }),
            ...(fromFile.line === undefined ? {} : { line: fromFile.line }),
          },
        );
        providersValid = false;
      }
    }
  }
  setting(
    'providers',
    providersName,
    providers !== undefined ? 'file' : providersValid ? 'unset' : 'invalid',
    providers !== undefined && providersRead.state === 'set'
      ? record({ kind: 'path', value: providersRead.value })
      : shownNone,
  );

  // The folder of the token files of the runner (ADR 0033). The runner
  // reads a file in it for each run, and the approval of an entry of a run
  // reads one as well. A set folder is only looked at, like the folder of
  // state: nobody but the user may write in it, because whoever can could
  // put the file of a wider account in place of a narrow one. The runner
  // needs it, for its own account if for nothing else.
  const runnerTokensName = 'ECCLIUM_RUNNER_TOKENS_DIR';
  const runnerTokensRead = read(row(runnerTokensName));
  let runnerTokensDir: string | undefined;
  let runnerTokensDirValid = runnerTokensRead.state !== 'invalid';
  if (runnerTokensRead.state === 'set') {
    if (!fitsVariable(runnerTokensName, runnerTokensRead.value)) {
      report('runner_tokens_dir_invalid', runnerTokensName);
      runnerTokensDirValid = false;
    } else {
      const value = runnerTokensRead.value;
      const stateDirValue =
        stateDirRead.state === 'set' ? stateDirRead.value : undefined;
      // In the folder of state, the login tokens would go into every backup
      // of it, as the day keys would (ADR 0031). Compared as text, like the
      // folder of keys.
      const checked =
        stateDirValue !== undefined &&
        isNormalizedAbsolutePath(stateDirValue) &&
        liesWithin(value, stateDirValue)
          ? ({ ok: false, code: 'runner_tokens_dir_in_state_dir' } as const)
          : checkRunnerTokensDir(
              value,
              stateDirFiles as StateDirFileSystem | undefined,
            );
      if (checked.ok) {
        runnerTokensDir = value;
      } else {
        report(checked.code, runnerTokensName);
        runnerTokensDirValid = false;
      }
    }
  } else if (runner && runnerTokensRead.state === 'unset') {
    report('runner_tokens_dir_required', runnerTokensName);
    runnerTokensDirValid = false;
  }
  setting(
    'runnerTokensDir',
    runnerTokensName,
    runnerTokensDir !== undefined
      ? 'environment'
      : runnerTokensDirValid
        ? 'unset'
        : runnerTokensRead.state === 'unset'
          ? 'missing'
          : 'invalid',
    runnerTokensDir !== undefined
      ? record({ kind: 'path', value: runnerTokensDir })
      : shownNone,
  );

  // The token of the runner is that of its own account, `ct_token_runner`
  // (ADR 0023). Before the first run, the start checks the file of every
  // other account the policy names, so that a run never meets a file it
  // refuses only then. The token of such a file is dropped at once: each
  // run reads it anew (ADR 0033). A problem names the field of the first
  // entry with the alias, never the path or the alias itself.
  if (runner) {
    if (runnerTokensDir !== undefined) {
      const own = readRunnerToken(
        runnerTokensDir,
        runnerOwnAlias,
        tokenFiles as TokenFileSystem | undefined,
      );
      if (own.ok) token = own.value;
      else report(runnerTokenCodeOf(own.code), runnerTokensName);
      const checked = new Set<string>([runnerOwnAlias]);
      for (const [index, entry] of (policy?.unattended ?? []).entries()) {
        if (checked.has(entry.credential)) continue;
        checked.add(entry.credential);
        const other = readRunnerToken(
          runnerTokensDir,
          entry.credential,
          tokenFiles as TokenFileSystem | undefined,
        );
        if (!other.ok) {
          add(
            runnerTokenCodeOf(other.code),
            variableNames.indexOf(runnerTokensName),
            runnerTokensName,
            { field: `unattended[${String(index)}].credential` },
          );
        }
      }
    }
    setting(
      'churchtoolsToken',
      runnerTokensName,
      token !== undefined
        ? 'file'
        : runnerTokensRead.state === 'unset'
          ? 'missing'
          : 'invalid',
      token !== undefined ? shownHidden : shownNone,
    );
  }

  // The folder of the drafts of the channel file and the file of the
  // notices after a run (ADR 0033). Only the runner writes them, and it
  // prepares the folder and the file itself, so the start checks the form
  // of the path and nothing on disk, as for the routines. Neither is
  // required, also not for the runner: only a routine with the channel
  // file needs one. Neither names YAML, so the variables of debug output
  // of the library for YAML play no part.
  // Neither may lie in or hold a folder of Ecclium whose files a draft or
  // a line of a notice would spoil or that holds a secret: the folders of
  // state that hold the audit, the counters, the snapshots, the queue, the
  // locks and the kill switches, the folder of state itself, the folder of
  // keys and the folder of the token files. A line appended to an audit
  // file would break its chain, one appended to a token file the account.
  // A folder of drafts beside these in the folder of state, such as
  // /data/output, stays allowed. Compared as text, like the folder of keys.
  const guardedFolders = (): {
    readonly state: string | undefined;
    readonly folders: readonly string[];
  } => {
    const given = (value: string | undefined): string | undefined =>
      value !== undefined && isNormalizedAbsolutePath(value)
        ? value
        : undefined;
    const state = given(
      stateDirRead.state === 'set' ? stateDirRead.value : undefined,
    );
    const others = [
      given(keysDirRead.state === 'set' ? keysDirRead.value : undefined),
      given(
        runnerTokensRead.state === 'set' ? runnerTokensRead.value : undefined,
      ),
    ].filter((value): value is string => value !== undefined);
    return {
      state,
      folders: [
        ...others,
        ...(state === undefined
          ? []
          : ['audit', 'quota', 'snapshots', 'queue', 'runner', 'stop'].map(
              (part) => `${state === '/' ? '' : state}/${part}`,
            )),
      ],
    };
  };
  const overlaps = (value: string): boolean => {
    const { state, folders } = guardedFolders();
    return (
      (state !== undefined && liesWithin(state, value)) ||
      folders.some(
        (folder) => liesWithin(value, folder) || liesWithin(folder, value),
      )
    );
  };
  const formOnlyPath = (
    key: 'draftsDir' | 'notifyFile' | 'metricsFile',
    name:
      | 'ECCLIUM_DRAFTS_DIR'
      | 'ECCLIUM_NOTIFY_FILE'
      | 'ECCLIUM_RUNNER_METRICS_FILE',
    code: 'drafts_dir_invalid' | 'notify_file_invalid' | 'metrics_file_invalid',
    overlapCode:
      'drafts_dir_overlap' | 'notify_file_overlap' | 'metrics_file_overlap',
    taken: readonly (string | undefined)[] = [],
    within: readonly (string | undefined)[] = [],
  ): { readonly value: string | undefined; readonly valid: boolean } => {
    const pathRead = read(row(name));
    if (pathRead.state === 'unset') {
      setting(key, name, 'unset', shownNone);
      return { value: undefined, valid: true };
    }
    if (
      pathRead.state === 'set' &&
      fitsVariable(name, pathRead.value) &&
      (overlaps(pathRead.value) ||
        taken.includes(pathRead.value) ||
        within.some(
          (folder) =>
            folder !== undefined && liesWithin(pathRead.value, folder),
        ))
    ) {
      report(overlapCode, name);
      setting(key, name, 'invalid', shownNone);
      return { value: undefined, valid: false };
    }
    if (pathRead.state === 'set' && fitsVariable(name, pathRead.value)) {
      setting(
        key,
        name,
        'environment',
        record({ kind: 'path', value: pathRead.value }),
      );
      return { value: pathRead.value, valid: true };
    }
    if (pathRead.state === 'set') report(code, name);
    setting(key, name, 'invalid', shownNone);
    return { value: undefined, valid: false };
  };
  const drafts = formOnlyPath(
    'draftsDir',
    'ECCLIUM_DRAFTS_DIR',
    'drafts_dir_invalid',
    'drafts_dir_overlap',
  );
  // A line appended to the file of the ping would break its address.
  const notify = formOnlyPath(
    'notifyFile',
    'ECCLIUM_NOTIFY_FILE',
    'notify_file_invalid',
    'notify_file_overlap',
    [given.get('ECCLIUM_RUNNER_PING_URL_FILE')],
  );
  // The metrics file is replaced whole after each pass, so it may also not
  // be the file of the notices, whose lines it would wipe out, the folder
  // of the drafts, a file of the policy, the providers, a key or the token
  // of the server, nor lie in the folder of the routines (ADR 0033).
  const metrics = formOnlyPath(
    'metricsFile',
    'ECCLIUM_RUNNER_METRICS_FILE',
    'metrics_file_invalid',
    'metrics_file_overlap',
    [
      notify.value,
      drafts.value,
      given.get('ECCLIUM_POLICY_FILE'),
      given.get('ECCLIUM_PROVIDERS_FILE'),
      given.get('ECCLIUM_PSEUDONYM_KEY_FILE'),
      given.get('ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE'),
      given.get('ECCLIUM_MARKER_KEY_FILE'),
      given.get('ECCLIUM_CHURCHTOOLS_TOKEN_FILE'),
      given.get('ECCLIUM_RUNNER_PING_URL_FILE'),
    ],
    [given.get('ECCLIUM_ROUTINES_DIR')],
  );

  // The address of the ping of the runner (ADR 0009). Its path works like
  // a secret, so it comes from a file with the checks of the token file,
  // and the report shows its host and port, never its path or that of the
  // file. Only the runner reads the file, at its start; a server never
  // pings and checks the form of the path alone, like the metrics file.
  const pingName = 'ECCLIUM_RUNNER_PING_URL_FILE';
  const pingRead = read(row(pingName));
  let runnerPingUrl: Secret | undefined;
  let runnerPingOrigin: string | undefined;
  let pingValid = pingRead.state !== 'invalid';
  if (pingRead.state === 'unset') {
    setting('runnerPingUrl', pingName, 'unset', shownNone);
  } else if (pingRead.state === 'invalid') {
    setting('runnerPingUrl', pingName, 'invalid', shownNone);
  } else if (!runner) {
    if (fitsVariable(pingName, pingRead.value)) {
      setting('runnerPingUrl', pingName, 'environment', shownHidden);
    } else {
      pingValid = false;
      report('ping_url_file_relative', pingName);
      setting('runnerPingUrl', pingName, 'invalid', shownNone);
    }
  } else {
    const fromFile = readPingUrlFile(
      pingRead.value,
      tokenFiles as TokenFileSystem | undefined,
    );
    if (fromFile.ok) {
      runnerPingUrl = fromFile.value.url;
      runnerPingOrigin = fromFile.value.origin;
      setting(
        'runnerPingUrl',
        pingName,
        'file',
        record({
          kind: 'origin',
          host: fromFile.value.host,
          port: fromFile.value.port,
        }),
      );
    } else {
      pingValid = false;
      report(fromFile.code, pingName);
      setting('runnerPingUrl', pingName, 'invalid', shownNone);
    }
  }

  // What the runner needs besides the server (ADR 0033, ADR 0034): the
  // zone its schedules reckon in, a file of the policy, the folder of its
  // routines and the folder of state, where the memory of its runs, its
  // locks and its audit file live. Each is reported where it is missing,
  // so that `ecclium config check` names all of them at once.
  if (runner) {
    if (timeZoneRead.state === 'unset') {
      report('runner_time_zone_required', timeZoneName);
    }
    if (policyRead.state === 'unset') {
      report('runner_policy_required', policyName);
    }
    if (routinesRead.state === 'unset') {
      report('runner_routines_dir_required', routinesName);
    }
    if (stateDirRead.state === 'unset') {
      report('runner_state_dir_required', stateDirName);
    }
  }

  // A wider trust store stays allowed for an instance with a certificate
  // of its own authority, with a warning on every start (ADR 0056).
  if (trustStoreExtended) warnings.add('trust_store_extended');

  // The proxy of every transport of the process and the switch for a
  // runner without one (ADR 0035). The runner starts only with one of
  // them, so that a runner without a boundary in the network is always a
  // choice that shows; the server and the commands need neither.
  const proxyName = 'ECCLIUM_EGRESS_PROXY';
  const proxyRead = read(row(proxyName));
  let egressProxy: string | undefined;
  let proxyValid = proxyRead.state !== 'invalid';
  if (proxyRead.state === 'unset') {
    setting('egressProxy', proxyName, 'unset', shownNone);
  } else if (proxyRead.state === 'invalid') {
    setting('egressProxy', proxyName, 'invalid', shownNone);
  } else {
    const parsed = parseEgressProxy(proxyRead.value);
    if (parsed.ok && fitsVariable(proxyName, proxyRead.value)) {
      egressProxy = parsed.proxy;
      setting(
        'egressProxy',
        proxyName,
        'environment',
        record({ kind: 'proxy', host: parsed.host, port: parsed.port }),
      );
    } else {
      proxyValid = false;
      report('egress_proxy_invalid', proxyName);
      setting('egressProxy', proxyName, 'invalid', shownNone);
    }
  }
  const egressName = 'ECCLIUM_EGRESS';
  const egressRead = read(row(egressName));
  let egressOff = false;
  let egressValid = egressRead.state !== 'invalid';
  if (egressRead.state === 'unset') {
    setting('egress', egressName, 'unset', shownNone);
  } else if (egressRead.state === 'invalid') {
    setting('egress', egressName, 'invalid', shownNone);
  } else if (
    egressRead.value === 'off' &&
    fitsVariable(egressName, egressRead.value)
  ) {
    egressOff = true;
    setting(
      'egress',
      egressName,
      'environment',
      record({ kind: 'choice', value: 'off' }),
    );
  } else {
    egressValid = false;
    report('invalid_choice', egressName);
    setting('egress', egressName, 'invalid', shownNone);
  }
  if (egressOff && egressProxy !== undefined) {
    report('egress_off_with_proxy', egressName);
  }
  if (runner && proxyRead.state === 'unset' && egressRead.state === 'unset') {
    report('runner_egress_required', proxyName);
  }
  if (runner && egressOff && egressProxy === undefined) {
    warnings.add('egress_off');
  }
  if (environmentProxy) warnings.add('environment_proxy_ignored');

  // The targets in the local network (ADR 0035). Each must be the origin
  // of ChurchTools or of the endpoint of a provider, so that the list of
  // the proxy never names a target the configuration does not reach. A
  // refused address or file of the providers has its own problem, so the
  // targets are compared only with origins that passed.
  const lanName = 'ECCLIUM_EGRESS_ALLOW_LAN';
  const lanRead = read(row(lanName));
  let egressAllowLan: readonly string[] = Object.freeze([]);
  let lanValid = lanRead.state !== 'invalid';
  if (lanRead.state === 'unset') {
    setting('egressAllowLan', lanName, 'unset', shownNone);
  } else if (lanRead.state === 'invalid') {
    setting('egressAllowLan', lanName, 'invalid', shownNone);
  } else {
    const targets = fitsVariable(lanName, lanRead.value)
      ? readAllowLanList(lanRead.value)
      : undefined;
    if (targets === undefined) {
      lanValid = false;
      report('egress_allow_lan_invalid', lanName);
    } else if (origin !== undefined && providersValid) {
      const known = new Set<string>([origin]);
      for (const provider of providers ?? []) {
        const endpoint = parseModelEndpoint(provider.endpoint);
        if (endpoint.ok) known.add(endpoint.origin);
      }
      if (targets.some((target) => !known.has(target))) {
        lanValid = false;
        report('egress_allow_lan_unknown', lanName);
      }
    }
    if (lanValid && targets !== undefined) {
      egressAllowLan = targets;
      setting(
        'egressAllowLan',
        lanName,
        'environment',
        record({
          kind: 'targets',
          values: Object.freeze(
            targets.map((target) => {
              const [host = '', port = '443'] = target
                .slice('https://'.length)
                .split(':');
              return record({ host, port });
            }),
          ),
        }),
      );
    } else {
      setting('egressAllowLan', lanName, 'invalid', shownNone);
    }
  }
  // Without a proxy the list does nothing for the runner. The server says
  // nothing: it has no boundary in the network either way and shares the
  // file of the environment with the runner.
  if (runner && egressOff && egressAllowLan.length > 0) {
    warnings.add('egress_allow_lan_unused');
  }

  // The subject must fit the pattern, and the placeholder of the audit is
  // refused although it fits.
  const subjectName = 'ECCLIUM_STDIO_SUBJECT';
  const subjectVariable = row(subjectName);
  const subjectRead = read(subjectVariable);
  let subject: Chosen | undefined;
  if (subjectRead.state === 'unset') {
    subject =
      subjectVariable.defaultValue === undefined
        ? undefined
        : { value: subjectVariable.defaultValue, origin: 'default' };
  } else if (subjectRead.state === 'set') {
    if (!fitsVariable(subjectName, subjectRead.value)) {
      report('subject_invalid', subjectName);
    } else if (
      (reservedStdioSubjects as readonly string[]).includes(subjectRead.value)
    ) {
      report('subject_reserved', subjectName);
    } else {
      subject = { value: subjectRead.value, origin: 'environment' };
    }
  }
  show('stdioSubject', subjectName, subject, 'choice');

  const logLevel = choose('ECCLIUM_LOG_LEVEL');
  show('logLevel', 'ECCLIUM_LOG_LEVEL', logLevel, 'choice');

  // A stable sort: by rank, then by name in code units.
  const sorted = ranked.sort(
    (left, right) =>
      left.rank - right.rank ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  const problems = Object.freeze(
    sorted.slice(0, maxReportedProblems).map((entry) => entry.problem),
  );
  const configReport: ConfigReport = record({
    transport,
    settings: Object.freeze(settings),
    problems,
    omittedProblems: sorted.length - problems.length,
    warnings: Object.freeze([...warnings]),
  });

  if (
    sorted.length > 0 ||
    origin === undefined ||
    token === undefined ||
    rate === undefined ||
    readOnly === undefined ||
    redaction === undefined ||
    !keyValid ||
    !previousValid ||
    toolsets === undefined ||
    !stateDirValid ||
    !keysDirValid ||
    snapshots === undefined ||
    confirmation === undefined ||
    !timeZoneValid ||
    retention === undefined ||
    policy === undefined ||
    !markerKeyValid ||
    !routinesDirValid ||
    !providersValid ||
    !runnerTokensDirValid ||
    !drafts.valid ||
    !notify.valid ||
    !metrics.valid ||
    !pingValid ||
    !proxyValid ||
    !egressValid ||
    !lanValid ||
    subject === undefined ||
    logLevel === undefined
  ) {
    return record({ ok: false as const, report: configReport });
  }
  return record({
    ok: true as const,
    config: record({
      transport,
      churchtoolsOrigin: origin,
      churchtoolsToken: token,
      tokenSource,
      churchtoolsRequestsPerMinute: rate.value,
      readOnly: readOnly.value === 'true',
      redaction: redaction.value as RedactionLevel,
      pseudonymKey: current.key,
      pseudonymKeyPrevious: previous.key,
      toolsets: toolsets.value,
      stateDir,
      keysDir,
      snapshots: snapshots.value === 'on',
      writeConfirmation: confirmation.value as WriteConfirmation,
      timeZone,
      auditRetentionMonths: retention.value,
      policy,
      markerKey,
      routinesDir,
      providers,
      runnerTokensDir,
      draftsDir: drafts.value,
      notifyFile: notify.value,
      metricsFile: metrics.value,
      runnerPingUrl,
      runnerPingOrigin,
      egressProxy,
      egressOff,
      egressAllowLan,
      stdioSubject: subject.value,
      logLevel: logLevel.value as LogLevel,
    }),
    report: configReport,
  });
}

/**
 * The configuration of `ecclium audit verify` and `ecclium audit show`
 * (ADR 0028): the folder of state and the retention, nothing more.
 */
export interface AuditConfig {
  /** The checked folder of state, an absolute normalised path. */
  readonly stateDir: string;
  /** The retention of the audit files in whole months, 1 to 120. */
  readonly auditRetentionMonths: number;
}

/** The configuration of the audit commands, or the problems that stop them. */
export type AuditConfigResult =
  | { readonly ok: true; readonly config: AuditConfig }
  | {
      readonly ok: false;
      /** The first {@link maxReportedProblems} problems. */
      readonly problems: readonly ConfigProblem[];
      /** The problems beyond them. */
      readonly omittedProblems: number;
    };

/** What the loader of the audit commands reads. */
export interface AuditConfigSources {
  /** The environment, which the loader never changes. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The file functions for the folder of state, only for tests. */
  readonly stateDirFiles?: StateDirFileSystem;
}

/**
 * Loads the configuration of the commands that read the audit files. It
 * sorts every name with the prefix as the start does, so that an unknown,
 * miscased or later name stops them as well, but it reads the value of
 * `ECCLIUM_STATE_DIR` and `ECCLIUM_AUDIT_RETENTION_MONTHS` alone. It needs
 * neither the address of ChurchTools nor the token and never opens the
 * token file; the variables of Node.js play no part. The folder of state
 * must be set and passes the same checks as at the start.
 *
 * @param sources - The environment and, for tests, the file functions for
 *   the folder of state.
 * @returns The folder and the retention, or the problems.
 * @throws {TypeError} When the sources or the environment are no plain
 *   record, or a variable with the prefix is no string or has a getter.
 *   Never for a wrong value.
 * @example
 * ```ts
 * const loaded = loadAuditConfig({ environment });
 * if (loaded.ok) openAuditFolder({ stateDir: loaded.config.stateDir });
 * ```
 */
export function loadAuditConfig(
  sources: AuditConfigSources,
): AuditConfigResult {
  if (!isRecord(sources)) throw new TypeError(invalidSources);
  const environment = ownData(sources, 'environment');
  const stateDirFiles = ownData(sources, 'stateDirFiles');
  if (!isRecord(environment)) throw new TypeError(invalidSources);
  if (stateDirFiles !== undefined && !isRecord(stateDirFiles)) {
    throw new TypeError(invalidSources);
  }

  const ranked: Ranked[] = [];
  const add = (
    code: ConfigProblemCode,
    rank: number,
    variable?: string,
  ): void => {
    ranked.push({
      rank,
      name: variable ?? '',
      problem: record(variable === undefined ? { code } : { code, variable }),
    });
  };
  const report = (code: ConfigProblemCode, name: VariableName): void => {
    add(code, variableNames.indexOf(name), name);
  };

  const given = new Map<VariableName, string>();
  for (const key of Object.keys(environment)) {
    if (asciiUpper(key.slice(0, variablePrefix.length)) !== variablePrefix) {
      continue;
    }
    const value = ownData(environment, key);
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new TypeError(invalidSources);
    const sorted = sortName(key);
    if (sorted.kind === 'known') given.set(sorted.name, value);
    else add(sorted.code, sorted.rank, sorted.variable);
  }

  const read = (variable: Variable): Read => {
    const value = given.get(variable.name);
    if (value === undefined) return unset;
    if (value === '') {
      report('empty_value', variable.name);
      return invalid;
    }
    if (value.length > variable.maxLength) {
      report('value_too_long', variable.name);
      return invalid;
    }
    return Object.freeze({ state: 'set', value });
  };

  // The folder must be set: without it there are no audit files to read.
  const stateDirName = 'ECCLIUM_STATE_DIR';
  const stateDirRead = read(row(stateDirName));
  let stateDir: string | undefined;
  if (stateDirRead.state === 'unset') {
    report('state_dir_required', stateDirName);
  } else if (stateDirRead.state === 'set') {
    const checked = checkStateDir(
      stateDirRead.value,
      stateDirFiles as StateDirFileSystem | undefined,
    );
    if (checked.ok) stateDir = stateDirRead.value;
    else report(checked.code, stateDirName);
  }

  const retentionName = 'ECCLIUM_AUDIT_RETENTION_MONTHS';
  const retentionVariable = row(retentionName);
  const retentionRead = read(retentionVariable);
  let retention: number | undefined;
  if (retentionRead.state === 'unset') {
    retention = Number(retentionVariable.defaultValue);
  } else if (retentionRead.state === 'set') {
    if (fitsVariable(retentionName, retentionRead.value)) {
      retention = Number(retentionRead.value);
    } else {
      report('invalid_retention', retentionName);
    }
  }

  if (ranked.length > 0 || stateDir === undefined || retention === undefined) {
    const sorted = ranked.sort(
      (left, right) =>
        left.rank - right.rank ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
    const problems = Object.freeze(
      sorted.slice(0, maxReportedProblems).map((entry) => entry.problem),
    );
    return record({
      ok: false as const,
      problems,
      omittedProblems: sorted.length - problems.length,
    });
  }
  return record({
    ok: true as const,
    config: record({ stateDir, auditRetentionMonths: retention }),
  });
}
