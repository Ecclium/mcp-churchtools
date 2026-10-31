/**
 * Loads the configuration from the environment, the token file and the
 * key files for pseudonyms (ADR 0055, ADR 0069). The core never reads `process.env` itself: the command line
 * passes the environment in. The loader reports every problem at once, by
 * code and variable, and never a value it was given.
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

import { parseChurchToolsOrigin, Secret } from '../http/index.js';
import type { KeyMaterial } from '../keys/index.js';
import type { LogLevel } from '../logger/index.js';
import type { ToolsetName } from '../registry/toolsets.js';
import type { ConfigProblemCode, ConfigWarningCode } from './codes.js';
import { readPseudonymKeyFile } from './pseudonym-key-file.js';
import { checkStateDir, type StateDirFileSystem } from './state-dir.js';
import { readTokenFile, type TokenFileSystem } from './token-file.js';
import {
  debugVariableName,
  fitsVariable,
  nodeOptionsVariableName,
  type PlainVariableName,
  proxyVariableName,
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
} from './variables.js';

/** How the server is reached. Over http, the rules for stdio refuse. */
export type Transport = 'stdio' | 'http';

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
   * How many months the audit files stay before the start or a new UTC day
   * deletes them, 1 to 120 (ADR 0028). Without a folder of state there are
   * no files, and the value does nothing.
   */
  readonly auditRetentionMonths: number;
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
  | 'auditRetentionMonths'
  | 'stdioSubject'
  | 'logLevel';

/** Where a value comes from. Phase 1 knows no other source. */
export type ValueOrigin = 'environment' | 'file' | 'default';

/**
 * What the report may show of a value: an entry of the table, or a value
 * that passed its check, such as the subject, the host of the address or
 * the folder of state. Never a refused value, and never anything of the
 * token, not even the path of its file.
 */
export type ShownValue =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'choice'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly string[] }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'origin'; readonly host: string; readonly port: string }
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
   * the variable of TLS, `NODE_OPTIONS` for an option of TLS in it, or an
   * unknown name in capitals, digits and underscores of at most 64
   * characters after the prefix. Absent for any other name and for an
   * option Node.js was started with.
   */
  readonly variable?: string;
}

/**
 * What the loader found, deeply frozen. It never holds the token, the path
 * of the token file or a value it refused. It does hold the checked host,
 * port, folder of state and subject, which the command line masks unless
 * asked to show them.
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
   * The file functions for the token file and the key files for
   * pseudonyms, only for tests.
   */
  readonly tokenFiles?: TokenFileSystem;
  /** The file functions for the folder of state, only for tests. */
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
  nodeOptionsVariableName,
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
// variables of TLS and of debug output, then the options that log TLS,
// then the names of a proxy, of later phases and of the replaced switch
// for the search tools, then unknown names by code unit, then those too
// odd to name.
const tlsRank = variableNames.length;
const debugRank = tlsRank + 1;
const keylogRank = debugRank + 1;
const traceRank = keylogRank + 1;
const proxyRank = traceRank + 1;
const unsupportedRank = proxyRank + 1;
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
  if (upper === proxyVariableName) {
    return problem('proxy_unsupported', proxyRank, proxyVariableName);
  }
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
 *   file and the folder of state.
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
  if (transport !== 'stdio' && transport !== 'http') {
    throw new TypeError('The transport is unknown.');
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

  // The snapshot. Only names with the prefix and the variables of Node.js
  // listed above are read at all; the values of others are never touched.
  const given = new Map<VariableName, string>();
  const inNodeOptions = new Set<string>();
  let trustStoreExtended = false;
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
    if (node === nodeOptionsVariableName) {
      for (const option of nodeOptionsOf(value)) {
        inNodeOptions.add(optionName(option));
      }
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
  }

  const read = (variable: Variable): Read => {
    const value = given.get(variable.name);
    if (value === undefined) return unset;
    if (variable.stdioOnly && transport !== 'stdio') {
      report('stdio_only', variable.name);
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
  // An empty value is reported as such and counts for nothing else.
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
  if (fileGiven && environmentGiven) {
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
    tokenVariable === tokenVariableName ? 'environment' : 'file';
  if (token !== undefined) {
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

  // off is allowed over stdio only, with a warning on every start. strict
  // needs the key file and refuses the toolset api, both checked below
  // (ADR 0069).
  let redaction = choose('ECCLIUM_REDACTION');
  const strict = redaction?.value === 'strict';
  if (redaction?.value === 'off' && transport !== 'stdio') {
    report('stdio_only', 'ECCLIUM_REDACTION');
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
    setting('stateDir', stateDirName, 'unset', shownNone);
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

  // A wider trust store stays allowed for an instance with a certificate
  // of its own authority, with a warning on every start (ADR 0056).
  if (trustStoreExtended) warnings.add('trust_store_extended');

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
    retention === undefined ||
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
      auditRetentionMonths: retention.value,
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
