/**
 * The command line `ecclium` (ADR 0055). It takes over the environment,
 * reads the arguments and runs the command; in this version the only one
 * is `ecclium config check`. Wrong calls get fixed German texts on stderr,
 * never an argument, and every exit code comes from `exit-codes.ts`.
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

const command: readonly string[] = Object.freeze(['config', 'check']);

const options = Object.freeze({
  'show-values': Object.freeze({ type: 'boolean' }),
  help: Object.freeze({ type: 'boolean', short: 'h' }),
} as const);

type Call =
  | { readonly kind: 'wrong'; readonly problem: UsageProblem }
  | { readonly kind: 'help' }
  | { readonly kind: 'check'; readonly showValues: boolean };

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
  // doubled flag would pass without this.
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) return { kind: 'wrong', problem: 'repeated' };
    seen.add(token.name);
  }
  const { positionals, values } = parsed;
  const leading =
    positionals.length <= command.length &&
    positionals.every((word, index) => word === command[index]);
  if (values.help === true) {
    return leading ? { kind: 'help' } : { kind: 'wrong', problem: 'command' };
  }
  return leading && positionals.length === command.length
    ? { kind: 'check', showValues: values['show-values'] === true }
    : { kind: 'wrong', problem: 'command' };
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
 * @param runOptions - Replacements for tests.
 * @returns The exit code.
 * @example
 * ```ts
 * process.exitCode = run(process.argv.slice(2), process.env);
 * ```
 */
export function run(
  args: readonly string[],
  environment: Record<string, string | undefined>,
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
          showValues: call.showValues,
          output,
          tokenFiles: runOptions.tokenFiles,
          load: runOptions.load,
        });
    }
  } catch {
    // The thrown value is never looked at: its message or its properties
    // could hold a value of the configuration, and a proxy would run code.
    output?.stderr(internalErrorText);
    return exitCodes.internal;
  }
}
