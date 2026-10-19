/**
 * The exit codes of the command line (ADR 0055), after sysexits.h. They
 * avoid 1, which Node.js gives a process that ends with an uncaught
 * exception, so that a crash never reads as an invalid configuration.
 *
 * @packageDocumentation
 */

/** The exit codes by meaning. */
export const exitCodes = Object.freeze({
  /** The command did its work; for `config check`, the configuration is valid. */
  ok: 0,
  /** The command line was called wrongly. */
  usage: 64,
  /** An internal error, with a fixed text and no details. */
  internal: 70,
  /** The configuration is invalid. */
  invalidConfig: 78,
  /**
   * The server over stdio ended after SIGINT: 128 and the number of the
   * signal, as a shell reports a process that the signal ended.
   */
  interrupted: 130,
  /** The server over stdio ended after SIGTERM, 128 and 15. */
  terminated: 143,
} as const);

/** An exit code of the command line. */
export type ExitCode = (typeof exitCodes)[keyof typeof exitCodes];
