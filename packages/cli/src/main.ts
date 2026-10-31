/**
 * The command line `ecclium` (ADR 0055), for every call but
 * `ecclium stdio`, which the executable hands to the start over stdio. It
 * takes over the environment, reads the arguments and runs the command:
 * `ecclium config check`, and `ecclium audit verify` and
 * `ecclium audit show`, which read the audit files (ADR 0028). Wrong calls get
 * fixed German texts on stderr, never an argument, and every exit code
 * comes from `exit-codes.ts`.
 *
 * @packageDocumentation
 */
// parseArgs exists only in node:util, whose ES module makes fd 2
// non-blocking. This file is in the place utilModule, and the start over
// stdio never loads it (ADR 0054).
import { parseArgs } from 'node:util';
import { isProxy } from 'node:util/types';

import {
  type ConfigResult,
  type ConfigSources,
  type TokenFileSystem,
  tokenVariableName,
} from '@ecclium/mcp-churchtools-core';

import { showAudit } from './commands/audit-show.js';
import { verifyAudit } from './commands/audit-verify.js';
import { checkConfig } from './commands/config-check.js';
import { takeEnvironment } from './environment.js';
import { type ExitCode, exitCodes } from './exit-codes.js';
import {
  createOutput,
  helpLines,
  internalErrorText,
  type Output,
  usageLine,
  type UsageProblem,
  usageProblemTexts,
} from './output/index.js';
import type { WriteSyncFn } from './send.js';

/** Replacements for tests. */
export interface RunOptions {
  /** Replaces `writeSync` from `node:fs`. */
  readonly writeSync?: WriteSyncFn;
  /** Replaces the file functions for the token file. */
  readonly tokenFiles?: TokenFileSystem;
  /** Replaces the loader. */
  readonly load?: (sources: ConfigSources) => ConfigResult;
}

/** A command: its words and the options it takes besides the help. */
interface Command {
  readonly words: readonly string[];
  readonly options: readonly string[];
}

const commands: readonly Command[] = Object.freeze(
  [
    { words: ['config', 'check'], options: ['show-values'] },
    { words: ['audit', 'verify'], options: ['log'] },
    { words: ['audit', 'show'], options: ['object', 'since', 'until'] },
  ].map((entry) =>
    Object.freeze({
      words: Object.freeze(entry.words),
      options: Object.freeze(entry.options),
    }),
  ),
);

const options = Object.freeze({
  'show-values': Object.freeze({ type: 'boolean' }),
  help: Object.freeze({ type: 'boolean', short: 'h' }),
  // Several logs, such as rotated ones (ADR 0028).
  log: Object.freeze({ type: 'string', multiple: true }),
  object: Object.freeze({ type: 'string' }),
  since: Object.freeze({ type: 'string' }),
  until: Object.freeze({ type: 'string' }),
} as const);

// The only option that may stand more than once.
const repeatable: readonly string[] = Object.freeze(['log']);

type Call =
  | { readonly kind: 'wrong'; readonly problem: UsageProblem }
  | { readonly kind: 'help' }
  | { readonly kind: 'check'; readonly showValues: boolean }
  | { readonly kind: 'verify'; readonly logs: readonly string[] }
  | {
      readonly kind: 'show';
      readonly object: string | undefined;
      readonly since: string | undefined;
      readonly until: string | undefined;
    };

// The kind of a refused call, from the code of the error of parseArgs
// alone: its message repeats the argument, which can hold a token.
const problemOf = (error: unknown): UsageProblem | undefined => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  switch (code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return 'option';
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return 'value';
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return 'command';
    default:
      return undefined;
  }
};

const readCall = (args: readonly string[]): Call => {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    const problem = problemOf(error);
    if (problem === undefined) throw error;
    return { kind: 'wrong', problem };
  }
  // parseArgs takes a repeated option and keeps the last one, so -hh and a
  // doubled flag would pass without this. Only the logs add up.
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name) && !repeatable.includes(token.name)) {
      return { kind: 'wrong', problem: 'repeated' };
    }
    seen.add(token.name);
  }
  const { positionals, values } = parsed;
  const leads = (entry: Command): boolean =>
    positionals.length <= entry.words.length &&
    positionals.every((word, index) => word === entry.words[index]);
  if (values.help === true) {
    return commands.some(leads)
      ? { kind: 'help' }
      : { kind: 'wrong', problem: 'command' };
  }
  const chosen = commands.find(
    (entry) => leads(entry) && positionals.length === entry.words.length,
  );
  if (chosen === undefined) return { kind: 'wrong', problem: 'command' };
  // An option of another command is refused like an unknown one.
  for (const name of seen) {
    if (!chosen.options.includes(name)) {
      return { kind: 'wrong', problem: 'option' };
    }
  }
  switch (chosen.words.join(' ')) {
    case 'audit verify':
      return { kind: 'verify', logs: values.log ?? [] };
    case 'audit show':
      return {
        kind: 'show',
        object: values.object,
        since: values.since,
        until: values.until,
      };
    default:
      return { kind: 'check', showValues: values['show-values'] === true };
  }
};

/**
 * Runs the command line. It removes the token from the environment first,
 * so that child processes and other code no longer see it, and catches
 * everything: an internal error gives one fixed line on stderr and the
 * exit code 70, never a stack or a message.
 *
 * @param args - The arguments after the name of the program.
 * @param environment - The environment of the process, which loses the
 *   token.
 * @param execArgv - The options Node.js was started with, which the check
 *   of the configuration reads for the options of TLS.
 * @param runOptions - Replacements for tests.
 * @returns The exit code.
 * @example
 * ```ts
 * process.exitCode = run(process.argv.slice(2), environment, process.execArgv);
 * ```
 */
export function run(
  args: readonly string[],
  environment: Record<string, string | undefined>,
  execArgv: readonly string[],
  runOptions: RunOptions = {},
): ExitCode {
  let output: Output | undefined;
  try {
    output = createOutput(
      runOptions.writeSync === undefined
        ? {}
        : { writeSync: runOptions.writeSync },
    );
    const taken = takeEnvironment(environment, [tokenVariableName]);
    const call = readCall(args);
    switch (call.kind) {
      case 'wrong':
        output.stderr(usageProblemTexts[call.problem]);
        output.stderr(usageLine);
        return exitCodes.usage;
      case 'help':
        for (const line of helpLines) output.stdout(line);
        return exitCodes.ok;
      case 'check':
        return checkConfig({
          environment: taken,
          execArgv,
          showValues: call.showValues,
          output,
          tokenFiles: runOptions.tokenFiles,
          load: runOptions.load,
        });
      case 'verify':
        return verifyAudit({ environment: taken, logs: call.logs, output });
      case 'show':
        return showAudit({
          environment: taken,
          object: call.object,
          since: call.since,
          until: call.until,
          output,
        });
    }
  } catch {
    // The thrown value is never looked at: its message or its properties
    // could hold a value of the configuration, and a proxy would run code.
    output?.stderr(internalErrorText);
    return exitCodes.internal;
  }
}
