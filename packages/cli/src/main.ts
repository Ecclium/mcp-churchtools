/**
 * The command line `ecclium` (ADR 0055), for every call but
 * `ecclium stdio`, which the executable hands to the start over stdio. It
 * takes over the environment, reads the arguments and runs the command:
 * `ecclium config check`, `ecclium audit verify` and `ecclium audit show`,
 * which read the audit files (ADR 0028), `ecclium policy init`
 * (ADR 0032), `ecclium undo` and `ecclium queue list`, `show`, `approve`
 * and `reject` (ADR 0029, ADR 0031), `ecclium run-once` with `--due`, a
 * routine or a routine and `--preview`, and the daemon `ecclium runner`
 * (ADR 0033, ADR 0034). Wrong calls get fixed German texts on stderr,
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
import type { PolicyInitOptions } from './policy/init.js';
import { policyInitCallProblem } from './policy/call.js';
import { policyInitCallTexts } from './policy/texts.js';
import type { WriteSyncFn } from './send.js';
import type { QueueOptions } from './queue/queue.js';
import type { RunnerDaemonOptions } from './runner/daemon.js';
import type { RunOnceOptions } from './runner/run-once.js';
import type { UndoOptions } from './undo/undo.js';

/** Replacements for tests. */
export interface RunOptions {
  /** Replaces `writeSync` from `node:fs`. */
  readonly writeSync?: WriteSyncFn;
  /** Replaces the file functions for the token file. */
  readonly tokenFiles?: TokenFileSystem;
  /** Replaces the loader. */
  readonly load?: (sources: ConfigSources) => ConfigResult;
  /** Replacements for `policy init`, such as the test double of ChurchTools. */
  readonly policyInit?: Pick<
    PolicyInitOptions,
    'load' | 'writeSync' | 'createTransport'
  >;
  /** Replacements for `undo`, such as the test double of ChurchTools. */
  readonly undo?: Pick<UndoOptions, 'load' | 'writeSync' | 'createTransport'>;
  /** Replacements for `queue`, such as the test double of ChurchTools. */
  readonly queue?: Pick<QueueOptions, 'load' | 'writeSync' | 'createTransport'>;
  /** Replacements for `run-once`, such as the doubles of ChurchTools and a model. */
  readonly runOnce?: Omit<
    RunOnceOptions,
    'environment' | 'execArgv' | 'mode' | 'output'
  >;
  /** Replacements for `runner`, such as the doubles and the process. */
  readonly runner?: Omit<
    RunnerDaemonOptions,
    'environment' | 'execArgv' | 'output'
  >;
}

/**
 * A command: its words, the options it takes besides the help, and
 * whether one argument follows its words, such as the ID of `undo`.
 */
interface Command {
  readonly words: readonly string[];
  readonly options: readonly string[];
  readonly argument: boolean;
}

const commands: readonly Command[] = Object.freeze(
  [
    { words: ['config', 'check'], options: ['show-values', 'runner'] },
    { words: ['audit', 'verify'], options: ['log'] },
    {
      words: ['audit', 'show'],
      options: ['object', 'run', 'since', 'until'],
    },
    {
      words: ['policy', 'init'],
      options: ['interactive', 'routine', 'credential'],
    },
    { words: ['undo'], options: ['overwrite'], argument: true },
    // Without the ID of a write only with --run, for every write of a run.
    { words: ['undo'], options: ['run', 'overwrite'] },
    { words: ['queue', 'list'], options: [] },
    { words: ['queue', 'show'], options: [], argument: true },
    { words: ['queue', 'approve'], options: [], argument: true },
    { words: ['queue', 'reject'], options: [], argument: true },
    // Without a routine only with --due, with one by hand or as a preview.
    { words: ['run-once'], options: ['due'] },
    { words: ['run-once'], options: ['preview'], argument: true },
    { words: ['runner'], options: [] },
  ].map((entry) =>
    Object.freeze({
      words: Object.freeze(entry.words),
      options: Object.freeze(entry.options),
      argument: entry.argument === true,
    }),
  ),
);

const options = Object.freeze({
  'show-values': Object.freeze({ type: 'boolean' }),
  help: Object.freeze({ type: 'boolean', short: 'h' }),
  // Several logs, such as rotated ones (ADR 0028).
  log: Object.freeze({ type: 'string', multiple: true }),
  object: Object.freeze({ type: 'string' }),
  run: Object.freeze({ type: 'string' }),
  since: Object.freeze({ type: 'string' }),
  until: Object.freeze({ type: 'string' }),
  interactive: Object.freeze({ type: 'boolean' }),
  routine: Object.freeze({ type: 'string' }),
  credential: Object.freeze({ type: 'string' }),
  overwrite: Object.freeze({ type: 'boolean' }),
  runner: Object.freeze({ type: 'boolean' }),
  due: Object.freeze({ type: 'boolean' }),
  preview: Object.freeze({ type: 'boolean' }),
} as const);

// The only option that may stand more than once.
const repeatable: readonly string[] = Object.freeze(['log']);

type Call =
  | { readonly kind: 'wrong'; readonly problem: UsageProblem }
  | { readonly kind: 'help' }
  | {
      readonly kind: 'check';
      readonly showValues: boolean;
      readonly runner: boolean;
    }
  | { readonly kind: 'verify'; readonly logs: readonly string[] }
  | {
      readonly kind: 'show';
      readonly object: string | undefined;
      readonly run: string | undefined;
      readonly since: string | undefined;
      readonly until: string | undefined;
    }
  | {
      readonly kind: 'init';
      readonly interactive: boolean;
      readonly routine: string | undefined;
      readonly credential: string | undefined;
    }
  | {
      readonly kind: 'undo';
      /** The ID of one write, or the ID of a run with `--run`. */
      readonly target:
        { readonly eventId: string } | { readonly runId: string };
      readonly overwrite: boolean;
    }
  | {
      readonly kind: 'queue';
      readonly action: 'list' | 'show' | 'approve' | 'reject';
      readonly queueId: string | undefined;
    }
  | { readonly kind: 'run'; readonly mode: RunOnceOptions['mode'] }
  | { readonly kind: 'daemon' };

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
  // The argument of a command is never compared with its words.
  const leads = (entry: Command): boolean =>
    positionals.length <= entry.words.length + (entry.argument ? 1 : 0) &&
    entry.words.every(
      (word, index) =>
        index >= positionals.length || word === positionals[index],
    );
  if (values.help === true) {
    return commands.some(leads)
      ? { kind: 'help' }
      : { kind: 'wrong', problem: 'command' };
  }
  const chosen = commands.find(
    (entry) =>
      leads(entry) &&
      positionals.length === entry.words.length + (entry.argument ? 1 : 0),
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
        run: values.run,
        since: values.since,
        until: values.until,
      };
    case 'policy init':
      return {
        kind: 'init',
        interactive: values.interactive === true,
        routine: values.routine,
        credential: values.credential,
      };
    case 'undo': {
      const eventId = positionals[1];
      if (eventId !== undefined) {
        return {
          kind: 'undo',
          target: { eventId },
          overwrite: values.overwrite === true,
        };
      }
      // Without the ID of a write, a run must be named.
      return values.run === undefined
        ? { kind: 'wrong', problem: 'command' }
        : {
            kind: 'undo',
            target: { runId: values.run },
            overwrite: values.overwrite === true,
          };
    }
    case 'queue list':
      return { kind: 'queue', action: 'list', queueId: undefined };
    case 'queue show':
      return { kind: 'queue', action: 'show', queueId: positionals[2] };
    case 'queue approve':
      return { kind: 'queue', action: 'approve', queueId: positionals[2] };
    case 'queue reject':
      return { kind: 'queue', action: 'reject', queueId: positionals[2] };
    case 'run-once': {
      const routineId = positionals[1];
      if (routineId !== undefined) {
        return {
          kind: 'run',
          mode: {
            kind: values.preview === true ? 'preview' : 'manual',
            routineId,
          },
        };
      }
      // Without a routine, a pass over the due ones must be asked for.
      return values.due === true
        ? { kind: 'run', mode: { kind: 'due' } }
        : { kind: 'wrong', problem: 'command' };
    }
    case 'runner':
      return { kind: 'daemon' };
    default:
      return {
        kind: 'check',
        showValues: values['show-values'] === true,
        runner: values.runner === true,
      };
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
 * @returns The exit code, or for `policy init`, `undo`, `queue`,
 *   `run-once` and `runner`, which build the pipeline, a promise of it.
 * @example
 * ```ts
 * process.exitCode = await run(process.argv.slice(2), environment, process.execArgv);
 * ```
 */
export function run(
  args: readonly string[],
  environment: Record<string, string | undefined>,
  execArgv: readonly string[],
  runOptions: RunOptions = {},
): ExitCode | Promise<ExitCode> {
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
      case 'check': {
        if (call.runner) {
          // Loaded only for this check: it loads and prepares the routines.
          const out = output;
          return import('./runner/check.js')
            .then(({ checkRunnerConfig }) =>
              checkRunnerConfig({
                environment: taken,
                execArgv,
                showValues: call.showValues,
                output: out,
                ...(runOptions.load === undefined
                  ? {}
                  : { load: runOptions.load }),
              }),
            )
            .catch(() => {
              out.stderr(internalErrorText);
              return exitCodes.internal;
            });
        }
        return checkConfig({
          environment: taken,
          execArgv,
          showValues: call.showValues,
          output,
          tokenFiles: runOptions.tokenFiles,
          load: runOptions.load,
        });
      }
      case 'verify':
        return verifyAudit({ environment: taken, logs: call.logs, output });
      case 'show':
        return showAudit({
          environment: taken,
          object: call.object,
          run: call.run,
          since: call.since,
          until: call.until,
          output,
        });
      case 'init': {
        // Checked before the import, so that a wrong call loads nothing.
        const problem = policyInitCallProblem(call);
        if (problem !== undefined) {
          output.stderr(policyInitCallTexts[problem]);
          if (!problem.endsWith('_invalid')) output.stderr(usageLine);
          return exitCodes.usage;
        }
        // Loaded only for this command: it builds the transport, whose
        // undici the other commands never need.
        const out = output;
        return import('./policy/init.js')
          .then(({ initPolicy }) =>
            initPolicy({
              environment: taken,
              execArgv,
              interactive: call.interactive,
              routine: call.routine,
              credential: call.credential,
              output: out,
              ...runOptions.policyInit,
            }),
          )
          .catch(() => {
            // As below: the thrown value is never looked at.
            out.stderr(internalErrorText);
            return exitCodes.internal;
          });
      }
      case 'undo': {
        // Loaded only for this command, like `policy init`: it builds the
        // transport, and it writes.
        const out = output;
        return import('./undo/undo.js')
          .then(({ undoWrite }) =>
            undoWrite({
              environment: taken,
              execArgv,
              ...call.target,
              overwrite: call.overwrite,
              output: out,
              ...runOptions.undo,
            }),
          )
          .catch(() => {
            out.stderr(internalErrorText);
            return exitCodes.internal;
          });
      }
      case 'queue': {
        // Loaded only for this command, like `undo`: it builds the
        // pipeline over the folders of the server.
        const out = output;
        return import('./queue/queue.js')
          .then(({ runQueue }) =>
            runQueue({
              environment: taken,
              execArgv,
              action: call.action,
              ...(call.queueId === undefined ? {} : { queueId: call.queueId }),
              output: out,
              ...runOptions.queue,
            }),
          )
          .catch(() => {
            out.stderr(internalErrorText);
            return exitCodes.internal;
          });
      }
      case 'run': {
        // Loaded only for this command: it builds the pipelines, the
        // models and the runner.
        const out = output;
        const mode = call.mode;
        return import('./runner/run-once.js')
          .then(({ runOnce }) =>
            runOnce({
              ...runOptions.runOnce,
              environment: taken,
              execArgv,
              mode,
              output: out,
            }),
          )
          .catch(() => {
            out.stderr(internalErrorText);
            return exitCodes.internal;
          });
      }
      case 'daemon': {
        // Loaded only for this command, like `run-once`.
        const out = output;
        return import('./runner/daemon.js')
          .then(({ runDaemon }) =>
            runDaemon({
              ...runOptions.runner,
              environment: taken,
              execArgv,
              output: out,
            }),
          )
          .catch(() => {
            out.stderr(internalErrorText);
            return exitCodes.internal;
          });
      }
    }
  } catch {
    // The thrown value is never looked at: its message or its properties
    // could hold a value of the configuration, and a proxy would run code.
    output?.stderr(internalErrorText);
    return exitCodes.internal;
  }
}
