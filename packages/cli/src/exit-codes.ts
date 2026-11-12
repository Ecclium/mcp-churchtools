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
  /**
   * The data is wrong: for `audit verify`, a chain or an anchor of the
   * audit files does not agree (ADR 0028); for `ecclium undo`, someone
   * changed the page since the write (ADR 0031); for `ecclium run-once`,
   * a run ended for good on its data or the answer of its model.
   */
  dataError: 65,
  /**
   * The input is missing, such as the folder `audit`, a log or the folder
   * of the routines.
   */
  noInput: 66,
  /**
   * A service the command needs did not answer as needed: for
   * `policy init`, ChurchTools gave no names of the targets or pages.
   */
  unavailable: 69,
  /** An internal error, with a fixed text and no details. */
  internal: 70,
  /**
   * A file could not be read or written whole: for `ecclium undo`, the
   * line in the audit file or the snapshot of the undo (ADR 0031); for
   * `ecclium run-once`, a draft or a notice of a run or the metrics file.
   */
  ioError: 74,
  /**
   * A later call may pass (EX_TEMPFAIL): for `ecclium run-once`, a run
   * failed on a passing fault, the memory of runs did not answer, writes
   * of the process are halted, or another process holds the routine of a
   * run by hand (ADR 0034); for the daemon, writes of the process are
   * halted, so that a restart lifts the halt (ADR 0029).
   */
  tempFail: 75,
  /**
   * The command may not do what it was asked: for `ecclium undo`, writing
   * is off, switched off or blocked, the account lacks a right, its token
   * is refused, the page is no Markdown page, or the clock differs from
   * ChurchTools (ADR 0031); for `ecclium run-once`, a kill switch, the
   * policy, a right or the sign-in refused a run.
   */
  noPermission: 77,
  /**
   * The configuration is invalid; for `ecclium run-once`, also when a
   * routine does not start.
   */
  invalidConfig: 78,
  /**
   * `ecclium run-once` or the daemon ended after SIGHUP, such as when its
   * terminal closed: 128 and 1.
   */
  hungUp: 129,
  /**
   * The server over stdio, `ecclium run-once` or the daemon ended after
   * SIGINT: 128 and the number of the signal, as a shell reports a process
   * that the signal ended.
   */
  interrupted: 130,
  /**
   * The server over stdio, `ecclium run-once` or the daemon ended after
   * SIGTERM, 128 and 15.
   */
  terminated: 143,
} as const);

/** An exit code of the command line. */
export type ExitCode = (typeof exitCodes)[keyof typeof exitCodes];
