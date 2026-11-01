/**
 * Logger and clock that the core hands to a tool with its tenant context.
 *
 * @packageDocumentation
 */

/** A value a log line may carry: never content from ChurchTools. */
export type LogValue = string | number | boolean;

/**
 * Fields of a log line. The logger of the core writes only field names and
 * values from its allow-list and drops everything else (threat model, T4),
 * so a field here is a request, not a promise that it appears.
 */
export type LogFields = Readonly<Record<string, LogValue>>;

/**
 * Writes log lines, bound to one tenant and, in the runner, to one run.
 *
 * Tools log events, never data: no tokens, no response bodies, no personal
 * data. The core enforces that with its allow-list; the fields of a tool are
 * not trusted to follow it. The name of an event, too, must be one of the
 * catalog of the core (ADR 0054): any other name, also one of a plugin,
 * becomes `invalid_event`, with its level and its allowed fields. A way for
 * a plugin to add events of its own is not there yet.
 */
export interface Logger {
  /**
   * Logs a detail for debugging.
   *
   * @param event - Name of an event of the catalog, such as `tool_call`.
   * @param fields - Optional fields, filtered by the allow-list of the core.
   */
  debug(event: string, fields?: LogFields): void;
  /**
   * Logs a normal event.
   *
   * @param event - Name of an event of the catalog.
   * @param fields - Optional fields, filtered by the allow-list of the core.
   */
  info(event: string, fields?: LogFields): void;
  /**
   * Logs something an operator should look at.
   *
   * @param event - Name of an event of the catalog.
   * @param fields - Optional fields, filtered by the allow-list of the core.
   */
  warn(event: string, fields?: LogFields): void;
  /**
   * Logs a failure.
   *
   * @param event - Name of an event of the catalog.
   * @param fields - Optional fields, filtered by the allow-list of the core.
   */
  error(event: string, fields?: LogFields): void;
}

/**
 * The time as the core sees it. Tests replace it with a fake clock, and
 * nothing that depends on the date, such as daily budgets, reads the system
 * time on its own.
 */
export interface Clock {
  /**
   * Returns the current time.
   *
   * @returns Milliseconds since the Unix epoch. A number, not a `Date`, so
   *   that a caller cannot change a time another caller also holds.
   */
  now(): number;
}
