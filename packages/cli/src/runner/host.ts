/**
 * The process around `ecclium run-once` and the daemon of the runner
 * (ADR 0033): its signals, the faults nothing caught, its end and the
 * wait of the daemon between two passes. Tests replace it.
 *
 * Why a signal never cuts a write: a write that has begun in ChurchTools
 * belongs with its snapshot, the read after it, its audit line, the end of
 * its trigger and its notice. The first SIGTERM, SIGINT or SIGHUP aborts
 * reading and the model at once, since both change nothing outside, and no
 * further routine begins; a write that runs still ends (decided on
 * 10.11.2026). A second signal ends the process at once, as with the
 * server over stdio, but never while a write runs: then the process ends
 * right after it, with the pass (decided on 11.11.2026). SIGHUP is heeded
 * too, so that a terminal that closes, such as a lost SSH session, cuts no
 * write. Other signals, such as SIGKILL from `docker stop` after its grace
 * period, stop it harder. The process ends with 143 after SIGTERM, 130
 * after SIGINT and 129 after SIGHUP, before any other code.
 *
 * @packageDocumentation
 */
import { describeError } from '@ecclium/mcp-churchtools-core/composition';
import type { ErrorCode, Logger } from '@ecclium/mcp-churchtools-plugin-api';

import { type ExitCode, exitCodes } from '../exit-codes.js';

/**
 * The signals the runner heeds, frozen, each with its log line and the
 * exit code it ends with, 128 and the number of the signal. The runner
 * container contract names them (ADR 0036).
 */
export const runnerSignals = Object.freeze([
  Object.freeze({
    signal: 'SIGTERM',
    event: 'process_sigterm',
    code: exitCodes.terminated,
  } as const),
  Object.freeze({
    signal: 'SIGINT',
    event: 'process_sigint',
    code: exitCodes.interrupted,
  } as const),
  Object.freeze({
    signal: 'SIGHUP',
    event: 'process_sighup',
    code: exitCodes.hungUp,
  } as const),
]);

/** What the runner needs of its process. Tests replace it. */
export interface RunnerHost {
  /**
   * Adds a listener for a signal.
   *
   * @param signal - SIGTERM, SIGINT or SIGHUP.
   * @param listener - Runs on every delivery of the signal.
   * @returns A function that removes the listener again.
   */
  readonly onSignal: (
    signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP',
    listener: () => void,
  ) => () => void;
  /**
   * Adds a listener for an exception or a rejection that nothing caught.
   *
   * @param listener - Gets which of the two it was and the thrown value or
   *   the reason.
   * @returns A function that removes the listener again.
   */
  readonly onFault: (
    listener: (kind: 'exception' | 'rejection', value: unknown) => void,
  ) => () => void;
  /**
   * Ends the process at once.
   *
   * @param code - The exit code.
   */
  readonly exit: (code: ExitCode) => void;
  /**
   * Waits, and holds the process while it waits.
   *
   * @param ms - How long, in milliseconds.
   * @param signal - Ends the wait early.
   * @returns A promise that resolves when the time is over or the signal
   *   aborts. It never rejects.
   */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * The process itself. Only properties of the global `process` are used:
 * loading `node:process` would make fd 1 and fd 2 non-blocking
 * (ADR 0054).
 *
 * @returns The host, frozen.
 * @example
 * ```ts
 * const host = processRunnerHost();
 * ```
 */
export const processRunnerHost = (): RunnerHost =>
  Object.freeze({
    onSignal: (
      signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP',
      listener: () => void,
    ) => {
      process.on(signal, listener);
      return () => {
        process.off(signal, listener);
      };
    },
    onFault: (
      listener: (kind: 'exception' | 'rejection', value: unknown) => void,
    ) => {
      const exception = (error: unknown): void => {
        listener('exception', error);
      };
      const rejection = (reason: unknown): void => {
        listener('rejection', reason);
      };
      process.on('uncaughtException', exception);
      process.on('unhandledRejection', rejection);
      return () => {
        process.off('uncaughtException', exception);
        process.off('unhandledRejection', rejection);
      };
    },
    exit: (code: ExitCode) => {
      process.exit(code);
    },
    wait: (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
      }),
  });

/** The signals the runner heeds, while it runs. */
export interface SignalWatch {
  /** Aborted by the first signal: reading and the model, never a write. */
  readonly signal: AbortSignal;
  /**
   * The exit code of the first signal, 143 or 130, or undefined while
   * none came.
   *
   * @returns The code.
   */
  code(): ExitCode | undefined;
  /**
   * Marks a write that has begun, so that no signal cuts it.
   *
   * @returns A function that marks its end. It never throws.
   */
  writing(): () => void;
  /** Removes the listeners again. It never throws. */
  dispose(): void;
}

// The code of a thrown value. describeError never throws, except with a
// RangeError when the stack is exhausted; then the code is internal
// (ADR 0054).
const codeOf = (value: unknown): ErrorCode => {
  try {
    return describeError(value).code;
  } catch {
    return 'internal';
  }
};

/**
 * Watches the signals and the faults of the process while the runner
 * runs. A fault that nothing caught writes one fixed log line with its
 * code and ends the process with 70, because its state is unknown then.
 *
 * @param host - The process.
 * @param logger - The logger of the process, at the level info at least.
 * @param said - Called once, at the first signal, so that the command
 *   line can say on stderr what happens now.
 * @returns The watch.
 * @example
 * ```ts
 * const watch = watchSignals(host, logger, () => output.stderr(signalText));
 * try { await runDue(routines, ports, { signal: watch.signal, maxRunMs }); }
 * finally { watch.dispose(); }
 * ```
 */
export function watchSignals(
  host: RunnerHost,
  logger: Logger,
  said: () => void,
): SignalWatch {
  const controller = new AbortController();
  let first: ExitCode | undefined;
  let writes = 0;
  const onSignal =
    (
      event: 'process_sigterm' | 'process_sigint' | 'process_sighup',
      code: ExitCode,
    ) =>
    (): void => {
      logger.info(event);
      if (first === undefined) {
        first = code;
        try {
          said();
        } finally {
          controller.abort();
        }
        return;
      }
      // A second signal ends the process at once, but never a write that
      // has begun: the pass ends right after it.
      if (writes === 0) host.exit(code);
    };
  const removers = [
    ...runnerSignals.map(({ signal, event, code }) =>
      host.onSignal(signal, onSignal(event, code)),
    ),
    host.onFault((kind, value) => {
      try {
        logger.error(
          kind === 'exception'
            ? 'process_uncaught_exception'
            : 'process_unhandled_rejection',
          { code: codeOf(value) },
        );
      } finally {
        host.exit(exitCodes.internal);
      }
    }),
  ];
  return Object.freeze({
    signal: controller.signal,
    code: () => first,
    writing: () => {
      writes += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        writes -= 1;
      };
    },
    dispose: () => {
      for (const remove of removers) {
        try {
          remove();
        } catch {
          // The process ends either way.
        }
      }
    },
  });
}
