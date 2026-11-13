/**
 * The table of the configuration variables of phase 1 (ADR 0055). The
 * loader, `ecclium config check`, the messages and the test of
 * `.env.example` all read it, so a variable is added in one place.
 *
 * @packageDocumentation
 */
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  maxProxyLength,
  parseChurchToolsOrigin,
  parseEgressProxy,
} from '../http/index.js';
import { logLevels } from '../logger/index.js';
import {
  isToolsetName,
  type ToolsetName,
  toolsetNames,
  toolsetsOfAll,
} from '../registry/toolsets.js';
import {
  isNormalizedAbsolutePath,
  maxKeysDirLength,
  maxKillSwitchDirLength,
  maxStateDirLength,
} from './state-dir.js';

/** The prefix of every variable. The loader recognises it in any case. */
export const variablePrefix = 'ECCLIUM_';

/** The names of the variables, frozen, in the order of the table. */
export const variableNames = Object.freeze([
  'ECCLIUM_CHURCHTOOLS_URL',
  'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
  'ECCLIUM_CHURCHTOOLS_TOKEN',
  'ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE',
  'ECCLIUM_READ_ONLY',
  'ECCLIUM_REDACTION',
  'ECCLIUM_PSEUDONYM_KEY_FILE',
  'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE',
  'ECCLIUM_TOOLSETS',
  'ECCLIUM_STATE_DIR',
  'ECCLIUM_KEYS_DIR',
  'ECCLIUM_KILL_SWITCH_DIR',
  'ECCLIUM_SNAPSHOTS',
  'ECCLIUM_WRITE_CONFIRMATION',
  'ECCLIUM_TIME_ZONE',
  'ECCLIUM_AUDIT_RETENTION_MONTHS',
  'ECCLIUM_POLICY_FILE',
  'ECCLIUM_MARKER_KEY_FILE',
  'ECCLIUM_ROUTINES_DIR',
  'ECCLIUM_PROVIDERS_FILE',
  'ECCLIUM_RUNNER_TOKENS_DIR',
  'ECCLIUM_DRAFTS_DIR',
  'ECCLIUM_NOTIFY_FILE',
  'ECCLIUM_RUNNER_METRICS_FILE',
  'ECCLIUM_RUNNER_PING_URL_FILE',
  'ECCLIUM_EGRESS_PROXY',
  'ECCLIUM_EGRESS',
  'ECCLIUM_EGRESS_ALLOW_LAN',
  'ECCLIUM_STDIO_SUBJECT',
  'ECCLIUM_LOG_LEVEL',
] as const);

/** The name of a variable. */
export type VariableName = (typeof variableNames)[number];

/**
 * The variable whose value is a secret. No schema, no pattern and no report
 * sees its value; only the constructor of `Secret` checks it.
 */
export const tokenVariableName = 'ECCLIUM_CHURCHTOOLS_TOKEN';

/** The name of a variable whose value is no secret. */
export type PlainVariableName = Exclude<VariableName, typeof tokenVariableName>;

// The name of a private file of the runner, as the private files take it.
const privateFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The variables whose value is no secret, frozen, in table order. */
export const plainVariableNames: readonly PlainVariableName[] = Object.freeze(
  variableNames.filter(
    (name): name is PlainVariableName => name !== tokenVariableName,
  ),
);

/**
 * Names of later phases, frozen. Until their phase, each one stops the
 * start with a message that this version does not support it yet.
 */
export const unsupportedVariableNames = Object.freeze([
  'ECCLIUM_ALLOWED_HOSTS',
] as const);

/**
 * The switch of phase 1 for the two search tools, which `ECCLIUM_TOOLSETS`
 * replaces (ADR 0062). Set with any value, it stops the start with a
 * pointer to the toolset `persons`, so that no configuration loses its
 * search tools without a word.
 */
export const searchToolsVariableName = 'ECCLIUM_SEARCH_TOOLS';

/**
 * Variables without the prefix with which a shell, Node.js or undici
 * would send through a proxy, frozen (ADR 0035). Ecclium uses none of
 * them: its transports go only through `ECCLIUM_EGRESS_PROXY`. Set with a
 * value in any spelling of the name, they give a warning, so that nobody
 * takes the proxy of the shell for the one of Ecclium.
 */
export const environmentProxyVariableNames = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NODE_USE_ENV_PROXY',
] as const);

/** The option of Node.js that does the same as `NODE_USE_ENV_PROXY`. */
export const environmentProxyOption = '--use-env-proxy';

/**
 * A variable without the prefix that the loader reads. With the value 0,
 * Node.js would check no certificate of ChurchTools.
 */
export const tlsVariableName = 'NODE_TLS_REJECT_UNAUTHORIZED';

/**
 * Another variable without the prefix that the loader reads. It switches
 * on the debug output of Node.js modules, which goes to stderr past the
 * logger: undici writes the address, path and query of each request, the
 * section `stream` the first bytes of every chunk of an answer and of the
 * input over stdio, `net` the host (ADR 0056). Which sections exist changes
 * with every release, so the loader refuses any section.
 */
export const debugVariableName = 'NODE_DEBUG';

/**
 * Variables without the prefix that the loader reads while a file of the
 * policy or of the providers or a folder of routines is set, frozen. Set with any value, they
 * make the library for YAML write every token of a file to stdout, which
 * would break the protocol over stdio and put the content of the file on
 * a stream (ADR 0032, ADR 0033).
 */
export const yamlDebugVariableNames = Object.freeze([
  'LOG_TOKENS',
  'LOG_STREAM',
] as const);

/**
 * The variable with options for Node.js, as on its command line. The
 * loader reads it, like the options Node.js was started with, only for the
 * options of TLS below.
 */
export const nodeOptionsVariableName = 'NODE_OPTIONS';

/**
 * Variables without the prefix that make Node.js trust more certificate
 * authorities than the ones it brings, frozen. `SSL_CERT_FILE` and
 * `SSL_CERT_DIR` count with `--use-openssl-ca` and in a build of Node.js
 * that uses the store of OpenSSL by default. They stay allowed, so that an
 * instance with a certificate of its own authority still works, and the
 * start warns (ADR 0056).
 */
export const trustStoreVariableNames = Object.freeze([
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const);

/** The options of Node.js that extend the trust store as well, frozen. */
export const trustStoreOptions = Object.freeze([
  '--use-system-ca',
  '--use-openssl-ca',
] as const);

/**
 * The option that writes the keys of every TLS session to a file. Whoever
 * also records the traffic could read the token, so it stops the start.
 */
export const tlsKeylogOption = '--tls-keylog';

/**
 * The option that writes a trace of every TLS session to stderr, past the
 * logger, so it stops the start like `NODE_DEBUG`.
 */
export const tlsTraceOption = '--trace-tls';

/**
 * A neutral name for whoever calls over stdio, such as `local-stdio`: no
 * capital, dot, space or `@`, so never an e-mail address. A name written as
 * a slug still fits; the subject must not be the name of a person. Never
 * give it a flag.
 */
export const stdioSubjectPattern = /^[a-z][a-z0-9-]{0,31}$/;

/** The subject over stdio when the variable is not set. */
export const defaultStdioSubject = 'local-stdio';

/**
 * Subjects that fit the pattern but are refused, frozen: `invalid` is the
 * placeholder of the audit for a missing actor (ADR 0054).
 */
export const reservedStdioSubjects = Object.freeze(['invalid'] as const);

/**
 * The ways a write gets confirmed, frozen, as `ECCLIUM_WRITE_CONFIRMATION`
 * names them (ADR 0029): `echo-allowed` asks the client when it declares
 * elicitation, else takes the echo where the plan allows it, else the
 * queue; `elicitation-or-queue` never takes the echo; `queue` sends every
 * write to the queue of the operator.
 */
export const writeConfirmations = Object.freeze([
  'echo-allowed',
  'elicitation-or-queue',
  'queue',
] as const);

/** How a write gets confirmed (ADR 0029). */
export type WriteConfirmation = (typeof writeConfirmations)[number];

/**
 * The way of confirmation over HTTP when the variable is not set. The
 * table holds the default over stdio, `echo-allowed`: over HTTP the echo
 * holds only when the operator sets it (ADR 0029).
 */
export const defaultHttpWriteConfirmation: WriteConfirmation =
  'elicitation-or-queue';

/** How the loader reads the value of a variable. */
export type VariableKind =
  | 'origin'
  | 'proxy'
  | 'path'
  | 'token'
  | 'integer'
  | 'boolean'
  | 'choice'
  | 'list'
  | 'targets'
  | 'subject'
  | 'zone';

/** The range of the requests per minute to ChurchTools (ADR 0057). */
export const requestsPerMinuteRange = Object.freeze({ min: 1, max: 500 });

/**
 * Tells whether a value is a whole number of requests per minute: digits
 * only, no leading zero, within {@link requestsPerMinuteRange}. Checked sign
 * by sign, without a regular expression or `Number()`, which would take
 * `3e2` or blanks.
 *
 * @param value - The value as given.
 * @returns Whether it fits.
 * @example
 * ```ts
 * isRequestsPerMinute('300'); // true
 * isRequestsPerMinute('0300'); // false
 * ```
 */
export function isRequestsPerMinute(value: string): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 3) {
    return false;
  }
  let number = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
    if (index === 0 && code === 0x30) return false;
    number = number * 10 + (code - 0x30);
  }
  return (
    number >= requestsPerMinuteRange.min && number <= requestsPerMinuteRange.max
  );
}

/**
 * The range of the retention of the audit files in whole months
 * (ADR 0028).
 */
export const retentionMonthsRange = Object.freeze({ min: 1, max: 120 });

/**
 * The retention below which every start warns: one year, as Art. 4 DSV
 * asks of a log, which also covers the six months of the KDG-DVO
 * (ADR 0028).
 */
export const recommendedRetentionMonths = 12;

/**
 * Tells whether a value is a whole number of months for the retention:
 * digits only, no leading zero, within {@link retentionMonthsRange}.
 * Checked sign by sign, like the requests per minute.
 *
 * @param value - The value as given.
 * @returns Whether it fits.
 * @example
 * ```ts
 * isRetentionMonths('12'); // true
 * isRetentionMonths('012'); // false
 * isRetentionMonths('121'); // false
 * ```
 */
export function isRetentionMonths(value: string): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 3) {
    return false;
  }
  let number = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
    if (index === 0 && code === 0x30) return false;
    number = number * 10 + (code - 0x30);
  }
  return (
    number >= retentionMonthsRange.min && number <= retentionMonthsRange.max
  );
}

/** The longest name of a time zone the table takes. */
export const maxTimeZoneLength = 64;

// The form of a name of the time zone database: an area and a place, each
// part with a capital first, such as `Europe/Zurich`. It keeps offsets like
// `+01:00`, abbreviations like `CET` and names in small letters away before
// Intl reads the value, which takes any case.
const timeZonePattern =
  /^[A-Z][A-Za-z0-9_+-]{0,31}(?:\/[A-Z][A-Za-z0-9_+-]{0,31}){1,2}$/;

/**
 * Tells whether a value names a time zone for the texts of confirmations
 * (ADR 0055): `UTC`, or a name of the time zone database such as
 * `Europe/Zurich` that Intl resolves to a zone it lists. An offset and a
 * zone of the area `Etc` with a fixed offset are refused, because they
 * follow no summer time and their sign misleads, and an abbreviation such
 * as `CET` names no place.
 *
 * @param value - The value as given.
 * @returns Whether it fits.
 * @example
 * ```ts
 * isTimeZone('Europe/Zurich'); // true
 * isTimeZone('UTC'); // true
 * isTimeZone('+01:00'); // false
 * isTimeZone('europe/zurich'); // false
 * ```
 */
export function isTimeZone(value: string): boolean {
  if (typeof value !== 'string' || value.length > maxTimeZoneLength) {
    return false;
  }
  if (value === 'UTC') return true;
  if (!timeZonePattern.test(value)) return false;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  // Intl lists each zone under the name it resolves to, which may be an
  // older one than the name given. The list is read here, at the start
  // only, so that no module keeps it.
  return (
    resolved === 'UTC' || Intl.supportedValuesOf('timeZone').includes(resolved)
  );
}

/**
 * The value of `ECCLIUM_TOOLSETS` that turns on every toolset but `api`
 * (ADR 0062, ADR 0067).
 */
export const allToolsets = 'all';

/**
 * Reads the value of `ECCLIUM_TOOLSETS`: names of toolsets separated by
 * commas, each at most once, or `all` alone, or `all` with `api` and
 * nothing else (ADR 0062, ADR 0067). `all` leaves out `api`, which an
 * operator names on purpose, and `all,api` spares listing every other
 * name. Empty means no toolset. Nothing is trimmed and no case is changed,
 * like every other value of the table, so a blank or a capital is refused.
 *
 * @param value - The value as given.
 * @returns The toolsets, frozen, in the order of {@link toolsetNames}, or
 *   `undefined` when the value does not fit.
 * @example
 * ```ts
 * readToolsetList('wiki,persons'); // ['persons', 'wiki']
 * readToolsetList('all'); // every toolset but 'api'
 * readToolsetList('all,api'); // every toolset
 * readToolsetList('all,wiki'); // undefined
 * ```
 */
export function readToolsetList(
  value: string,
): readonly ToolsetName[] | undefined {
  if (typeof value !== 'string' || value.length > toolsetListLength) {
    return undefined;
  }
  if (value === '') return Object.freeze([]);
  if (value === allToolsets) return toolsetsOfAll;
  const names = value.split(',');
  const chosen = new Set<string>(names);
  if (chosen.size !== names.length) return undefined;
  if (chosen.has(allToolsets)) {
    return chosen.size === 2 && chosen.has('api') ? toolsetNames : undefined;
  }
  if (!names.every(isToolsetName)) return undefined;
  return Object.freeze(toolsetNames.filter((name) => chosen.has(name)));
}

// The longest value that can fit: every toolset once.
const toolsetListLength = toolsetNames.join(',').length;

/**
 * The most targets `ECCLIUM_EGRESS_ALLOW_LAN` names (ADR 0035): far more
 * than a configuration has origins, one of ChurchTools and one per
 * provider.
 */
export const maxAllowLanTargets = 16;

/**
 * The longest value of `ECCLIUM_EGRESS_ALLOW_LAN`: the most targets, each
 * a name of 253 characters with the highest port, and the commas.
 */
export const allowLanLength =
  maxAllowLanTargets * (253 + ':65535'.length + 1) - 1;

// A port as the parser writes it: no sign, no leading zero.
const portPattern = /^[1-9][0-9]{0,4}$/;

/**
 * Reads the targets in the local network that the proxy may reach on any
 * port and in a private range (ADR 0035): a list with commas, each entry
 * exactly `name:port`. The name gets every rule of the address of an
 * instance, so it is a name in lower case with a dot, never an IP address
 * or `localhost`, and the port is written out, also 443. Nothing is
 * trimmed and no case is changed, like every other value of the table.
 *
 * @param value - The value as given.
 * @returns The targets as https origins, the port left out for 443,
 *   frozen, in the order given; or `undefined` when the value does not
 *   fit or names a target twice.
 * @example
 * ```ts
 * readAllowLanList('model.example.org:8443');
 * // ['https://model.example.org:8443']
 * readAllowLanList('example.church.tools:443');
 * // ['https://example.church.tools']
 * readAllowLanList('192.0.2.5:8443'); // undefined
 * ```
 */
export function readAllowLanList(value: string): readonly string[] | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > allowLanLength
  ) {
    return undefined;
  }
  const entries = value.split(',');
  if (entries.length > maxAllowLanTargets) return undefined;
  const origins: string[] = [];
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    if (colon < 1 || colon !== entry.lastIndexOf(':')) return undefined;
    const port = entry.slice(colon + 1);
    if (!portPattern.test(port)) return undefined;
    const host = entry.slice(0, colon);
    const origin =
      port === '443' ? `https://${host}` : `https://${host}:${port}`;
    // The parser refuses a port above 65535, and any host it would change
    // makes the origin differ from what was written.
    const checked = parseChurchToolsOrigin(origin);
    if (!checked.ok || checked.origin !== origin) return undefined;
    if (origins.includes(origin)) return undefined;
    origins.push(origin);
  }
  return Object.freeze(origins);
}

/** One row of the table. */
export interface Variable {
  readonly name: VariableName;
  readonly kind: VariableKind;
  /**
   * The longest value. The loader checks it before any pattern and never
   * cuts a value.
   */
  readonly maxLength: number;
  /**
   * The values of a boolean or a choice, or the words of a list, exactly as
   * written; else empty.
   */
  readonly choices: readonly string[];
  /** The value when the variable is not set, or undefined for none. */
  readonly defaultValue: string | undefined;
  /** Whether the value is a secret. */
  readonly secret: boolean;
  /** Whether, of the two servers, only a start over stdio may set it. */
  readonly stdioOnly: boolean;
  /**
   * Whether the runner of routines may set it (ADR 0033). It may not set
   * the token of the server, from a file or from the environment, nor the
   * subject of stdio, which belong to the server, but the folders of state
   * and of keys and the retention of the audit, which the runner needs as
   * a start over stdio does.
   */
  readonly runner: boolean;
}

const row = (variable: Variable): Variable =>
  Object.freeze({ ...variable, choices: Object.freeze([...variable.choices]) });

/**
 * The table, frozen, in the order of {@link variableNames}. The bound of
 * the address only keeps huge values from the parser: the check of the
 * address has its own, lower one, which a longer address reaches first.
 * The bound of the token file and of the key files is PATH_MAX on Linux, the one of the folder
 * of state lower, so that the path of an audit file in it stays below
 * PATH_MAX of macOS (ADR 0028), the one of the folder of keys lower still,
 * for the longer names of the day keys in it (ADR 0031), and the one of
 * the token the longest value a `Secret` takes.
 */
export const variables: readonly Variable[] = Object.freeze([
  row({
    name: 'ECCLIUM_CHURCHTOOLS_URL',
    kind: 'origin',
    maxLength: 2048,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: false,
  }),
  row({
    name: 'ECCLIUM_CHURCHTOOLS_TOKEN',
    kind: 'token',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: true,
    stdioOnly: true,
    runner: false,
  }),
  row({
    name: 'ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE',
    kind: 'integer',
    maxLength: 3,
    choices: [],
    defaultValue: '300',
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_READ_ONLY',
    kind: 'boolean',
    maxLength: 5,
    choices: ['true', 'false'],
    defaultValue: 'true',
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_REDACTION',
    kind: 'choice',
    maxLength: 8,
    choices: ['standard', 'off', 'strict'],
    defaultValue: 'standard',
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_PSEUDONYM_KEY_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_TOOLSETS',
    kind: 'list',
    maxLength: toolsetListLength,
    choices: [...toolsetNames, allToolsets],
    defaultValue: '',
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_STATE_DIR',
    kind: 'path',
    maxLength: maxStateDirLength,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: true,
    runner: true,
  }),
  // The folder of the day keys (ADR 0031): needed as soon as the server
  // or the runner writes, of the servers over stdio only, and like the
  // folder of state it must not lie in.
  row({
    name: 'ECCLIUM_KEYS_DIR',
    kind: 'path',
    maxLength: maxKeysDirLength,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: true,
    runner: true,
  }),
  // The folder of the kill switches (ADR 0029): over stdio by default the
  // folder stop of the folder of state, for the runner required, in its
  // container /config/stop, which comes with /config (ADR 0036). Like the
  // folder of keys, only over stdio and for the runner, which always
  // requires it.
  row({
    name: 'ECCLIUM_KILL_SWITCH_DIR',
    kind: 'path',
    maxLength: maxKillSwitchDirLength,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: true,
    runner: true,
  }),
  // The snapshots of writes (ADR 0031): on unless the operator turns them
  // off, which leaves no write that can be taken back. Their retention is
  // fixed, so there is no variable for it.
  row({
    name: 'ECCLIUM_SNAPSHOTS',
    kind: 'choice',
    maxLength: 3,
    choices: ['on', 'off'],
    defaultValue: 'on',
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // How a write gets confirmed (ADR 0029). The row holds the default over
  // stdio; over HTTP the loader takes elicitation-or-queue when the
  // variable is not set, so that the echo holds there only on purpose.
  row({
    name: 'ECCLIUM_WRITE_CONFIRMATION',
    kind: 'choice',
    maxLength: 20,
    choices: writeConfirmations,
    defaultValue: 'echo-allowed',
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The zone in which confirmations, the queue and `ecclium undo` show the
  // times of appointments and bookings; without it they show UTC. The
  // tools take UTC either way (ADR 0029).
  row({
    name: 'ECCLIUM_TIME_ZONE',
    kind: 'zone',
    maxLength: maxTimeZoneLength,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_AUDIT_RETENTION_MONTHS',
    kind: 'integer',
    maxLength: 3,
    choices: [],
    defaultValue: String(recommendedRetentionMonths),
    secret: false,
    stdioOnly: true,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_POLICY_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_MARKER_KEY_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The folder of the routines (ADR 0033). The runner and `ecclium policy
  // init --routine` load the routines; the start of the server checks the
  // form of the path.
  row({
    name: 'ECCLIUM_ROUTINES_DIR',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The file of the providers of language models (ADR 0033). The start
  // reads and checks it like the policy; the files of the keys it names
  // are read only by the composition root of the runner.
  row({
    name: 'ECCLIUM_PROVIDERS_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The folder of the token files of the accounts of the runner, one file
  // ct_token_<alias> per alias of the policy and ct_token_runner for its
  // own account (ADR 0033). A set folder is checked on disk at every start;
  // the start of the runner checks every file in it the policy names, and
  // each run and the approval of an entry of a run read the file anew.
  row({
    name: 'ECCLIUM_RUNNER_TOKENS_DIR',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The folder of the drafts of the channel file, one file per routine and
  // period, and the file of the notices after a run (ADR 0033). Only the
  // runner writes them, and it prepares the folder and the file itself, so
  // the start checks the form of the path alone, as for the routines. How
  // long a draft stays is the operator's matter (ADR 0031).
  row({
    name: 'ECCLIUM_DRAFTS_DIR',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_NOTIFY_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The metrics file of the runner, in the text format of Prometheus: per
  // routine the next run, the last success and the last status, and the
  // head of the chain of the open audit file (ADR 0028, ADR 0033). The
  // runner replaces it whole after each pass and prepares its folder as a
  // private one, so the start checks the form of the path alone.
  row({
    name: 'ECCLIUM_RUNNER_METRICS_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The file with the address of the ping of the runner, in the format of
  // Healthchecks (ADR 0009). Its path works like a secret, so the address
  // comes from a file with the checks of the token file, which only the
  // start of the runner reads; a server checks the form of the path alone.
  row({
    name: 'ECCLIUM_RUNNER_PING_URL_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The proxy of every transport of the process, http://host:port, and the
  // switch that lets the runner start without one (ADR 0035). Neither has
  // a default: the runner needs one of them, the server neither.
  row({
    name: 'ECCLIUM_EGRESS_PROXY',
    kind: 'proxy',
    maxLength: maxProxyLength,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_EGRESS',
    kind: 'choice',
    maxLength: 3,
    choices: ['off'],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  // The targets in the local network, each an origin of the configuration
  // (ADR 0035). Only `ecclium init egress` turns them into a list for the
  // proxy; every start checks that each one is an origin it knows.
  row({
    name: 'ECCLIUM_EGRESS_ALLOW_LAN',
    kind: 'targets',
    maxLength: allowLanLength,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
  row({
    name: 'ECCLIUM_STDIO_SUBJECT',
    kind: 'subject',
    maxLength: 32,
    choices: [],
    defaultValue: defaultStdioSubject,
    secret: false,
    stdioOnly: true,
    runner: false,
  }),
  row({
    name: 'ECCLIUM_LOG_LEVEL',
    kind: 'choice',
    maxLength: 5,
    choices: logLevels,
    defaultValue: 'info',
    secret: false,
    stdioOnly: false,
    runner: true,
  }),
]);

const choiceOf = (name: PlainVariableName) =>
  z.enum(variables.find((variable) => variable.name === name)?.choices ?? []);

/**
 * One schema per variable without a secret, frozen. The address goes
 * through the own check of the address, because zod would normalise it.
 * Reserved subjects are a rule of the loader, not of the schema.
 */
export const variableSchemas: Readonly<
  Record<PlainVariableName, z.ZodType<string>>
> = Object.freeze({
  ECCLIUM_CHURCHTOOLS_URL: z
    .string()
    .max(2048)
    .refine((value) => parseChurchToolsOrigin(value).ok),
  ECCLIUM_CHURCHTOOLS_TOKEN_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value)),
  ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE: z
    .string()
    .max(3)
    .refine((value) => isRequestsPerMinute(value)),
  ECCLIUM_READ_ONLY: choiceOf('ECCLIUM_READ_ONLY'),
  ECCLIUM_REDACTION: choiceOf('ECCLIUM_REDACTION'),
  ECCLIUM_PSEUDONYM_KEY_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value)),
  ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value)),
  ECCLIUM_TOOLSETS: z
    .string()
    .max(toolsetListLength)
    .refine((value) => readToolsetList(value) !== undefined),
  ECCLIUM_STATE_DIR: z
    .string()
    .min(1)
    .max(maxStateDirLength)
    .refine((value) => isNormalizedAbsolutePath(value)),
  ECCLIUM_KEYS_DIR: z
    .string()
    .min(1)
    .max(maxKeysDirLength)
    .refine((value) => isNormalizedAbsolutePath(value)),
  // The bound in bytes as well: a character outside ASCII takes more than
  // one byte in a path.
  ECCLIUM_KILL_SWITCH_DIR: z
    .string()
    .min(1)
    .max(maxKillSwitchDirLength)
    .refine(
      (value) =>
        isNormalizedAbsolutePath(value) &&
        new TextEncoder().encode(value).length <= maxKillSwitchDirLength,
    ),
  ECCLIUM_SNAPSHOTS: choiceOf('ECCLIUM_SNAPSHOTS'),
  ECCLIUM_WRITE_CONFIRMATION: choiceOf('ECCLIUM_WRITE_CONFIRMATION'),
  ECCLIUM_TIME_ZONE: z
    .string()
    .max(maxTimeZoneLength)
    .refine((value) => isTimeZone(value)),
  ECCLIUM_AUDIT_RETENTION_MONTHS: z
    .string()
    .max(3)
    .refine((value) => isRetentionMonths(value)),
  ECCLIUM_POLICY_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value)),
  ECCLIUM_MARKER_KEY_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value)),
  ECCLIUM_ROUTINES_DIR: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isNormalizedAbsolutePath(value)),
  ECCLIUM_PROVIDERS_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value)),
  ECCLIUM_RUNNER_TOKENS_DIR: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isNormalizedAbsolutePath(value)),
  ECCLIUM_DRAFTS_DIR: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isNormalizedAbsolutePath(value)),
  ECCLIUM_NOTIFY_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isNormalizedAbsolutePath(value)),
  // A name the private files take as well (files/private-files.ts), so
  // that a path the start takes is one the runner can write.
  ECCLIUM_RUNNER_METRICS_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        isNormalizedAbsolutePath(value) &&
        privateFileNamePattern.test(value.slice(value.lastIndexOf('/') + 1)),
    ),
  ECCLIUM_RUNNER_PING_URL_FILE: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value)),
  ECCLIUM_EGRESS_PROXY: z
    .string()
    .max(maxProxyLength)
    .refine((value) => {
      const checked = parseEgressProxy(value);
      return checked.ok && checked.proxy === value;
    }),
  ECCLIUM_EGRESS: choiceOf('ECCLIUM_EGRESS'),
  ECCLIUM_EGRESS_ALLOW_LAN: z
    .string()
    .max(allowLanLength)
    .refine((value) => readAllowLanList(value) !== undefined),
  ECCLIUM_STDIO_SUBJECT: z.string().max(32).regex(stdioSubjectPattern),
  ECCLIUM_LOG_LEVEL: choiceOf('ECCLIUM_LOG_LEVEL'),
});

/**
 * The variables without a secret as one strict object, for the test of
 * `.env.example`. No entry of core exports it, because a zod schema can be
 * widened after it is made. The token is not part of it, so a caller drops
 * the token key before parsing: the strict object would report it as an
 * unknown key, with the whole record as the input of the issue.
 */
export const environmentSchema = z.strictObject({
  ECCLIUM_CHURCHTOOLS_URL: variableSchemas.ECCLIUM_CHURCHTOOLS_URL.optional(),
  ECCLIUM_CHURCHTOOLS_TOKEN_FILE:
    variableSchemas.ECCLIUM_CHURCHTOOLS_TOKEN_FILE.optional(),
  ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE:
    variableSchemas.ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE.optional(),
  ECCLIUM_READ_ONLY: variableSchemas.ECCLIUM_READ_ONLY.optional(),
  ECCLIUM_REDACTION: variableSchemas.ECCLIUM_REDACTION.optional(),
  ECCLIUM_PSEUDONYM_KEY_FILE:
    variableSchemas.ECCLIUM_PSEUDONYM_KEY_FILE.optional(),
  ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE:
    variableSchemas.ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE.optional(),
  ECCLIUM_TOOLSETS: variableSchemas.ECCLIUM_TOOLSETS.optional(),
  ECCLIUM_STATE_DIR: variableSchemas.ECCLIUM_STATE_DIR.optional(),
  ECCLIUM_KEYS_DIR: variableSchemas.ECCLIUM_KEYS_DIR.optional(),
  ECCLIUM_KILL_SWITCH_DIR: variableSchemas.ECCLIUM_KILL_SWITCH_DIR.optional(),
  ECCLIUM_SNAPSHOTS: variableSchemas.ECCLIUM_SNAPSHOTS.optional(),
  ECCLIUM_WRITE_CONFIRMATION:
    variableSchemas.ECCLIUM_WRITE_CONFIRMATION.optional(),
  ECCLIUM_TIME_ZONE: variableSchemas.ECCLIUM_TIME_ZONE.optional(),
  ECCLIUM_AUDIT_RETENTION_MONTHS:
    variableSchemas.ECCLIUM_AUDIT_RETENTION_MONTHS.optional(),
  ECCLIUM_POLICY_FILE: variableSchemas.ECCLIUM_POLICY_FILE.optional(),
  ECCLIUM_MARKER_KEY_FILE: variableSchemas.ECCLIUM_MARKER_KEY_FILE.optional(),
  ECCLIUM_ROUTINES_DIR: variableSchemas.ECCLIUM_ROUTINES_DIR.optional(),
  ECCLIUM_PROVIDERS_FILE: variableSchemas.ECCLIUM_PROVIDERS_FILE.optional(),
  ECCLIUM_RUNNER_TOKENS_DIR:
    variableSchemas.ECCLIUM_RUNNER_TOKENS_DIR.optional(),
  ECCLIUM_DRAFTS_DIR: variableSchemas.ECCLIUM_DRAFTS_DIR.optional(),
  ECCLIUM_NOTIFY_FILE: variableSchemas.ECCLIUM_NOTIFY_FILE.optional(),
  ECCLIUM_RUNNER_METRICS_FILE:
    variableSchemas.ECCLIUM_RUNNER_METRICS_FILE.optional(),
  ECCLIUM_RUNNER_PING_URL_FILE:
    variableSchemas.ECCLIUM_RUNNER_PING_URL_FILE.optional(),
  ECCLIUM_EGRESS_PROXY: variableSchemas.ECCLIUM_EGRESS_PROXY.optional(),
  ECCLIUM_EGRESS: variableSchemas.ECCLIUM_EGRESS.optional(),
  ECCLIUM_EGRESS_ALLOW_LAN: variableSchemas.ECCLIUM_EGRESS_ALLOW_LAN.optional(),
  ECCLIUM_STDIO_SUBJECT: variableSchemas.ECCLIUM_STDIO_SUBJECT.optional(),
  ECCLIUM_LOG_LEVEL: variableSchemas.ECCLIUM_LOG_LEVEL.optional(),
});

/**
 * Asks whether a value fits the schema of a variable. Only the answer is
 * used, never the error of zod, which would carry the value (ADR 0055).
 *
 * @param name - A variable without a secret.
 * @param value - The value as given.
 * @returns Whether it fits.
 * @throws {TypeError} When the name is no variable without a secret.
 * @example
 * ```ts
 * fitsVariable('ECCLIUM_READ_ONLY', 'true'); // true
 * fitsVariable('ECCLIUM_READ_ONLY', 'TRUE'); // false
 * ```
 */
export function fitsVariable(name: PlainVariableName, value: string): boolean {
  if (!(plainVariableNames as readonly string[]).includes(name)) {
    throw new TypeError('Only a variable without a secret has a schema.');
  }
  // zod reads the length of any value, also of one that is no string, and
  // would run its getter, so only a string reaches it.
  return (
    typeof value === 'string' && variableSchemas[name].safeParse(value).success
  );
}
