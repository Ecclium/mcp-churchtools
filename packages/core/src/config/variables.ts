/**
 * The table of the configuration variables of phase 1 (ADR 0055). The
 * loader, `ecclium config check`, the messages and the test of
 * `.env.example` all read it, so a variable is added in one place.
 *
 * @packageDocumentation
 */
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { parseChurchToolsOrigin } from '../http/index.js';
import { logLevels } from '../logger/index.js';

/** The prefix of every variable. The loader recognises it in any case. */
export const variablePrefix = 'ECCLIUM_';

/** The names of the variables, frozen, in the order of the table. */
export const variableNames = Object.freeze([
  'ECCLIUM_CHURCHTOOLS_URL',
  'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
  'ECCLIUM_CHURCHTOOLS_TOKEN',
  'ECCLIUM_READ_ONLY',
  'ECCLIUM_REDACTION',
  'ECCLIUM_SEARCH_TOOLS',
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
  'ECCLIUM_TOOLSETS',
  'ECCLIUM_WRITE_CONFIRMATION',
  'ECCLIUM_STATE_DIR',
  'ECCLIUM_EGRESS',
  'ECCLIUM_EGRESS_ALLOW_LAN',
  'ECCLIUM_ALLOWED_HOSTS',
] as const);

/**
 * The variable for a proxy of outbound connections. It stops the start
 * until an explicit proxy comes with ADR 0035.
 */
export const proxyVariableName = 'ECCLIUM_EGRESS_PROXY';

/**
 * One of the two variables without the prefix that the loader reads. With
 * the value 0, Node.js would check no certificate of ChurchTools.
 */
export const tlsVariableName = 'NODE_TLS_REJECT_UNAUTHORIZED';

/**
 * The other variable without the prefix that the loader reads. It switches
 * on the debug output of Node.js modules, which goes to stderr past the
 * logger: undici writes the address, path and query of each request, the
 * section `stream` the first bytes of every chunk of an answer and of the
 * input over stdio, `net` the host (ADR 0056). Which sections exist changes
 * with every release, so the loader refuses any section.
 */
export const debugVariableName = 'NODE_DEBUG';

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

/** How the loader reads the value of a variable. */
export type VariableKind =
  'origin' | 'path' | 'token' | 'boolean' | 'choice' | 'subject';

/** One row of the table. */
export interface Variable {
  readonly name: VariableName;
  readonly kind: VariableKind;
  /**
   * The longest value. The loader checks it before any pattern and never
   * cuts a value.
   */
  readonly maxLength: number;
  /** The values of a boolean or a choice, exactly as written; else empty. */
  readonly choices: readonly string[];
  /** The value when the variable is not set, or undefined for none. */
  readonly defaultValue: string | undefined;
  /** Whether the value is a secret. */
  readonly secret: boolean;
  /** Whether only a start over stdio may set the variable at all. */
  readonly stdioOnly: boolean;
}

const row = (variable: Variable): Variable =>
  Object.freeze({ ...variable, choices: Object.freeze([...variable.choices]) });

/**
 * The table, frozen, in the order of {@link variableNames}. The bound of
 * the address only keeps huge values from the parser: the check of the
 * address has its own, lower one, which a longer address reaches first.
 * The bound of the path is PATH_MAX on Linux, and the one of the token the
 * longest value a `Secret` takes.
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
  }),
  row({
    name: 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
    kind: 'path',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: false,
    stdioOnly: false,
  }),
  row({
    name: 'ECCLIUM_CHURCHTOOLS_TOKEN',
    kind: 'token',
    maxLength: 4096,
    choices: [],
    defaultValue: undefined,
    secret: true,
    stdioOnly: true,
  }),
  row({
    name: 'ECCLIUM_READ_ONLY',
    kind: 'boolean',
    maxLength: 5,
    choices: ['true', 'false'],
    defaultValue: 'true',
    secret: false,
    stdioOnly: false,
  }),
  row({
    name: 'ECCLIUM_REDACTION',
    kind: 'choice',
    maxLength: 8,
    choices: ['standard', 'off', 'strict'],
    defaultValue: 'standard',
    secret: false,
    stdioOnly: false,
  }),
  row({
    name: 'ECCLIUM_SEARCH_TOOLS',
    kind: 'boolean',
    maxLength: 5,
    choices: ['true', 'false'],
    defaultValue: 'false',
    secret: false,
    stdioOnly: false,
  }),
  row({
    name: 'ECCLIUM_STDIO_SUBJECT',
    kind: 'subject',
    maxLength: 32,
    choices: [],
    defaultValue: defaultStdioSubject,
    secret: false,
    stdioOnly: true,
  }),
  row({
    name: 'ECCLIUM_LOG_LEVEL',
    kind: 'choice',
    maxLength: 5,
    choices: logLevels,
    defaultValue: 'info',
    secret: false,
    stdioOnly: false,
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
  ECCLIUM_READ_ONLY: choiceOf('ECCLIUM_READ_ONLY'),
  ECCLIUM_REDACTION: choiceOf('ECCLIUM_REDACTION'),
  ECCLIUM_SEARCH_TOOLS: choiceOf('ECCLIUM_SEARCH_TOOLS'),
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
  ECCLIUM_READ_ONLY: variableSchemas.ECCLIUM_READ_ONLY.optional(),
  ECCLIUM_REDACTION: variableSchemas.ECCLIUM_REDACTION.optional(),
  ECCLIUM_SEARCH_TOOLS: variableSchemas.ECCLIUM_SEARCH_TOOLS.optional(),
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
