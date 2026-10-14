/**
 * Loads the configuration from the environment and the token file
 * (ADR 0055). The core never reads `process.env` itself: the command line
 * passes the environment in. The loader reports every problem at once, by
 * code and variable, and never a value it was given.
 *
 * @packageDocumentation
 */
import { types } from 'node:util';

import { parseChurchToolsOrigin, Secret } from '../http/index.js';
import type { LogLevel } from '../logger/index.js';
import type { ConfigProblemCode, ConfigWarningCode } from './codes.js';
import { readTokenFile, type TokenFileSystem } from './token-file.js';
import {
  fitsVariable,
  type PlainVariableName,
  proxyVariableName,
  reservedStdioSubjects,
  tlsVariableName,
  tokenVariableName,
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
  readonly readOnly: boolean;
  /** `strict` is refused until the full redaction exists. */
  readonly redaction: 'off' | 'standard';
  readonly searchTools: boolean;
  readonly stdioSubject: string;
  readonly logLevel: LogLevel;
}

/** A setting of the configuration, as the report lists it. */
export type SettingKey =
  | 'churchtoolsOrigin'
  | 'churchtoolsToken'
  | 'readOnly'
  | 'redaction'
  | 'searchTools'
  | 'stdioSubject'
  | 'logLevel';

/** Where a value comes from. Phase 1 knows no other source. */
export type ValueOrigin = 'environment' | 'file' | 'default';

/**
 * What the report may show of a value: an entry of the table, or a value
 * that passed its check, such as the subject or the host of the address.
 * Never a refused value, and never anything of the token.
 */
export type ShownValue =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'choice'; readonly value: string }
  | { readonly kind: 'origin'; readonly host: string; readonly port: string }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'none' };

/** One setting in the report. */
export interface SettingReport {
  readonly key: SettingKey;
  /** The variable that set the value, or would set it. */
  readonly variable: VariableName;
  readonly origin: ValueOrigin | 'missing' | 'invalid';
  readonly shown: ShownValue;
}

/** One problem in the report. */
export interface ConfigProblem {
  readonly code: ConfigProblemCode;
  /**
   * The variable: a known name, the right name for one in the wrong case,
   * the variable of TLS, or an unknown name in capitals, digits and
   * underscores of at most 64 characters after the prefix. Absent for any
   * other name.
   */
  readonly variable?: string;
}

/**
 * What the loader found, deeply frozen. It never holds the token, the path
 * of the token file or a value it refused. It does hold the checked host,
 * port and subject, which the command line masks unless asked to show them.
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
  /** The file functions for the token file, only for tests. */
  readonly tokenFiles?: TokenFileSystem;
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
  !types.isProxy(value) &&
  !Array.isArray(value) &&
  !types.isMap(value) &&
  !types.isSet(value) &&
  !types.isBoxedPrimitive(value);

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
// variable of TLS, then the names of a proxy and of later phases, then
// unknown names by code unit, then those too odd to name.
const tlsRank = variableNames.length;
const proxyRank = tlsRank + 1;
const unsupportedRank = proxyRank + 1;
const unknownRank = unsupportedRank + unsupportedVariableNames.length;

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
 * token goes only into a `Secret`.
 *
 * @param sources - The environment, the transport and, for tests, the
 *   file functions for the token file.
 * @returns The configuration with its report when nothing is wrong, else
 *   the report alone.
 * @throws {TypeError} When the sources or the environment are no plain
 *   record, a variable with the prefix is no string or has a getter, or
 *   the transport is unknown. Never for a wrong value.
 * @example
 * ```ts
 * const result = loadConfig({ environment: process.env, transport: 'stdio' });
 * if (!result.ok) report(result.report.problems);
 * ```
 */
export function loadConfig(sources: ConfigSources): ConfigResult {
  if (!isRecord(sources)) throw new TypeError(invalidSources);
  const environment = ownData(sources, 'environment');
  const transport = ownData(sources, 'transport');
  const tokenFiles = ownData(sources, 'tokenFiles');
  if (!isRecord(environment)) throw new TypeError(invalidSources);
  if (tokenFiles !== undefined && !isRecord(tokenFiles)) {
    throw new TypeError(invalidSources);
  }
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

  // The snapshot. Only names with the prefix and the variable of TLS are
  // read at all; the values of others are never touched.
  const given = new Map<VariableName, string>();
  for (const key of Object.keys(environment)) {
    const prefixed =
      asciiUpper(key.slice(0, variablePrefix.length)) === variablePrefix;
    // Windows looks up the names of the environment without regard to
    // case, so there Node.js also reads node_tls_reject_unauthorized. Every
    // spelling counts, on every platform.
    const tls =
      !prefixed &&
      key.length === tlsVariableName.length &&
      asciiUpper(key) === tlsVariableName;
    if (!prefixed && !tls) continue;
    const value = ownData(environment, key);
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new TypeError(invalidSources);
    if (tls) {
      if (value === '0') add('tls_check_disabled', tlsRank, tlsVariableName);
      continue;
    }
    // Names are sorted out before any value is looked at, so a name that
    // is wrong never has its value checked.
    const upper = asciiUpper(key);
    const unsupported = (unsupportedVariableNames as readonly string[]).indexOf(
      upper,
    );
    const known = (variableNames as readonly string[]).indexOf(upper);
    if (upper === proxyVariableName) {
      add('proxy_unsupported', proxyRank, proxyVariableName);
    } else if (unsupported >= 0) {
      add('unsupported_variable', unsupportedRank + unsupported, upper);
    } else if (known >= 0 && key !== upper) {
      add('miscased_variable', known, upper);
    } else if (known >= 0) {
      given.set(upper as VariableName, value);
    } else if (reportableNamePattern.test(key)) {
      add('unknown_variable', unknownRank, key);
    } else {
      add('unknown_variable', unknownRank + 1);
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

  const readOnly = choose('ECCLIUM_READ_ONLY');
  show('readOnly', 'ECCLIUM_READ_ONLY', readOnly, 'boolean');

  // strict is refused until the full redaction exists, and off is allowed
  // over stdio only, with a warning on every start.
  let redaction = choose('ECCLIUM_REDACTION');
  if (redaction?.value === 'strict') {
    report('redaction_strict_unsupported', 'ECCLIUM_REDACTION');
    redaction = undefined;
  } else if (redaction?.value === 'off' && transport !== 'stdio') {
    report('stdio_only', 'ECCLIUM_REDACTION');
    redaction = undefined;
  } else if (redaction?.value === 'off') {
    warnings.add('redaction_off');
  }
  show('redaction', 'ECCLIUM_REDACTION', redaction, 'choice');

  const searchTools = choose('ECCLIUM_SEARCH_TOOLS');
  if (searchTools?.value === 'true') warnings.add('search_tools_enabled');
  show('searchTools', 'ECCLIUM_SEARCH_TOOLS', searchTools, 'boolean');

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
    readOnly === undefined ||
    redaction === undefined ||
    searchTools === undefined ||
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
      readOnly: readOnly.value === 'true',
      redaction: redaction.value as 'off' | 'standard',
      searchTools: searchTools.value === 'true',
      stdioSubject: subject.value,
      logLevel: logLevel.value as LogLevel,
    }),
    report: configReport,
  });
}
