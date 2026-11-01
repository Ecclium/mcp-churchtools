/**
 * The logger of the core: one JSON line per event, with fields from a fixed
 * list only (threat model T4, ADR 0054).
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import type {
  Clock,
  LogFields,
  Logger,
  LogValue,
  Mode,
  RedactionLevel,
  RunId,
  TenantId,
  ToolName,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  isAuditFileName,
  isBoolean,
  isErrorCode,
  isEventName,
  isHttpMethod,
  isIntegerIn,
  isMode,
  isPromptName,
  isRedactionLevel,
  isSha256,
  isTenantId,
  isToolName,
  isUuid,
  toTimestamp,
} from './fields.js';
import { isLogEvent, type LogLevel, logLevels } from './catalog.js';
import type { LineWriter } from './line-writer.js';

export { type LogLevel, logLevels } from './catalog.js';

/**
 * Fields that only the core binds to a logger, for every line it writes. A
 * call that names one of them has it dropped and counted, so that a tool
 * cannot write lines in the name of another tenant, run or tool.
 */
export interface BoundLogFields {
  /** The tenant. */
  readonly tenantId?: TenantId;
  /** The run of the runner. */
  readonly runId?: RunId;
  /** The audit event the lines belong to. */
  readonly eventId?: string;
  /** The tool. */
  readonly tool?: ToolName;
  /** How the request runs. */
  readonly mode?: Mode;
  /** The level of redaction. */
  readonly redaction?: RedactionLevel;
  /** Whether the request may only read. */
  readonly readOnly?: boolean;
}

/** Options of {@link createLogger}. */
export interface LoggerOptions {
  /** Where the lines go. */
  readonly writer: LineWriter;
  /** The time of each line. */
  readonly clock: Clock;
  /** Lines below this level are not written. */
  readonly minLevel: LogLevel;
  /** Fields for every line. */
  readonly bound?: BoundLogFields;
  /**
   * The names of the prompts a line may carry in the field `prompt`, which
   * only the composition root sets for the logger of the mount (ADR 0065).
   * A name outside this set is dropped and counted, so a tool cannot use
   * the field for text of its own. Without it the field is always dropped.
   */
  readonly prompts?: ReadonlySet<string>;
  /**
   * Whether a line may carry the anchor of the chain of an audit file in
   * `file`, `seq` and `hash`, which only the composition root sets for the
   * logger it hands the writer of the audit file (ADR 0028). Without it
   * the three fields are dropped and counted, so that no tool can write a
   * hash or a name of a file into the log. Only `true` turns it on.
   */
  readonly anchors?: boolean;
}

/**
 * The event of a line whose event name broke the pattern or is not in the
 * catalog of the core.
 */
export const replacedEventName = 'invalid_event';

/** The time of a line when the clock failed. */
export const fallbackTimestamp = '1970-01-01T00:00:00.000Z';

/** The highest count of dropped fields a line reports. */
export const maxDropped = 1_000_000;

interface Field {
  readonly name: string;
  readonly bound: boolean;
  readonly check: (value: unknown) => boolean;
}

// Every field after ts, level and event, in the order of the line. Only
// these names reach a line: none for messages, names, paths, hosts, URLs or
// other text, and neither v nor type, so that no log line passes for an
// audit line.
const fields: readonly Field[] = Object.freeze(
  [
    { name: 'tenantId', bound: true, check: isTenantId },
    { name: 'runId', bound: true, check: isUuid },
    { name: 'eventId', bound: true, check: isUuid },
    { name: 'tool', bound: true, check: isToolName },
    // The name of a prompt from the catalog, which the mount writes for a
    // request that runs no tool and has no tenant (ADR 0065).
    { name: 'prompt', bound: false, check: isPromptName },
    { name: 'code', bound: false, check: isErrorCode },
    { name: 'mode', bound: true, check: isMode },
    { name: 'redaction', bound: true, check: isRedactionLevel },
    { name: 'readOnly', bound: true, check: isBoolean },
    { name: 'durationMs', bound: false, check: isIntegerIn(0, 86_400_000) },
    { name: 'count', bound: false, check: isIntegerIn(0, 1_000_000) },
    // The method of a request on the outbound path, so that every write to
    // ChurchTools shows in the log (ADR 0072).
    { name: 'method', bound: false, check: isHttpMethod },
    { name: 'status', bound: false, check: isIntegerIn(100, 599) },
    { name: 'attempt', bound: false, check: isIntegerIn(1, 10) },
    // The anchor of the chain of an audit file, only for the logger the
    // composition root makes with anchors (ADR 0028).
    { name: 'file', bound: false, check: isAuditFileName },
    {
      name: 'seq',
      bound: false,
      check: isIntegerIn(1, Number.MAX_SAFE_INTEGER),
    },
    { name: 'hash', bound: false, check: isSha256 },
  ].map((field) => Object.freeze(field)),
);

// The fields only a logger with anchors may write.
const anchorFields: readonly string[] = Object.freeze(['file', 'seq', 'hash']);

/**
 * Every field a line may carry, in the order of the line, for the page of
 * the log lines.
 */
export const logFieldNames: readonly string[] = Object.freeze([
  'ts',
  'level',
  'event',
  ...fields.map((field) => field.name),
  'dropped',
]);

const emptyRecord = (): Record<string, LogValue> =>
  Object.create(null) as Record<string, LogValue>;

// An object whose own properties can be read without running its code: no
// proxy, and a plain object with Object.prototype or no prototype. Any other
// object, such as an error, a Map or a class instance, is refused whole.
const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null || isProxy(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// The value of an own, enumerable data property, never through a getter.
const ownValue = (target: object, name: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(target, name);
  return property?.enumerable === true && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

// The bound fields, checked once. A bad bound is a mistake in the core, so
// it throws, with a fixed message that never holds the value.
const readBound = (bound: unknown): Readonly<Record<string, LogValue>> => {
  const values = emptyRecord();
  if (bound === undefined) return Object.freeze(values);
  const fail = (): never => {
    throw new TypeError('The bound log fields are not valid.');
  };
  if (!isPlainObject(bound)) return fail();
  for (const name of Reflect.ownKeys(bound)) {
    const field = fields.find((entry) => entry.name === name);
    if (field?.bound !== true) return fail();
    // A field given as undefined counts as absent, as its type allows. A
    // getter is still a mistake.
    const property = Object.getOwnPropertyDescriptor(bound, field.name);
    if (
      property !== undefined &&
      Object.hasOwn(property, 'value') &&
      property.value === undefined
    ) {
      continue;
    }
    const value = ownValue(bound, field.name);
    if (!field.check(value)) return fail();
    values[field.name] = value as LogValue;
  }
  return Object.freeze(values);
};

// A copy of the names of the prompts, so that a later change of the set
// changes no logger. A bad set is a mistake in the core, so it throws, with
// a fixed message that never holds a value.
const readPrompts = (value: unknown): ReadonlySet<string> => {
  if (value === undefined) return new Set();
  if (!(value instanceof Set)) {
    throw new TypeError('The names of the prompts are no set.');
  }
  const names = [...(value as Set<unknown>)];
  if (!names.every(isPromptName)) {
    throw new TypeError('A name of a prompt is not valid.');
  }
  return new Set(names);
};

interface Admitted {
  readonly values: Readonly<Record<string, LogValue>>;
  readonly dropped: number;
}

// The fields of one call that may stand in a line. Every own key that does
// not make it into the line counts as dropped, also a name of a prompt that
// is not one of the logger and a field of an anchor without anchors.
const admit = (
  input: unknown,
  prompts: ReadonlySet<string>,
  anchors: boolean,
): Admitted => {
  if (input === undefined) return { values: emptyRecord(), dropped: 0 };
  try {
    if (!isPlainObject(input)) return { values: emptyRecord(), dropped: 1 };
    const values = emptyRecord();
    const keys = Reflect.ownKeys(input).length;
    let accepted = 0;
    for (const field of fields) {
      if (field.bound) continue;
      const value = ownValue(input, field.name);
      if (
        field.check(value) &&
        (field.name !== 'prompt' || prompts.has(value as string)) &&
        (anchors || !anchorFields.includes(field.name))
      ) {
        values[field.name] = value as LogValue;
        accepted += 1;
      }
    }
    return { values, dropped: keys - accepted };
  } catch {
    // Reading a module namespace before it is initialised throws.
    return { values: emptyRecord(), dropped: 1 };
  }
};

// The time of the clock, or the fallback.
const timestamp = (clock: Clock): string => {
  try {
    return toTimestamp(clock.now()) ?? fallbackTimestamp;
  } catch {
    return fallbackTimestamp;
  }
};

/**
 * Creates a logger. Each call writes one line with `ts`, `level` and
 * `event`, then the bound fields and the fields of the call in a fixed
 * order, then `dropped` if fields were dropped. A call may set only
 * `prompt`, with a name from `prompts`, `code`, `durationMs`, `count`,
 * `method`, `status` and `attempt`, and with `anchors` also `file`, `seq` and
 * `hash`; everything else is dropped and counted. An event name that
 * breaks the pattern or is not in the catalog `logEvents` becomes
 * `invalid_event`. Fields are read as own data properties of a plain
 * object, so no getter, proxy trap or coercion of the caller runs.
 *
 * The logger is frozen, its methods work detached, return nothing and never
 * throw. A call made while the same logger writes, from its clock or its
 * writer, is dropped.
 *
 * @param options - Writer, clock, lowest level and bound fields.
 * @returns The logger.
 * @throws {TypeError} If an option is not valid, with a fixed message.
 * @example
 * ```ts
 * const log = createLogger({ writer, clock: systemClock, minLevel: 'info' });
 * log.info('audit_file_closed', { count: 3 });
 * ```
 */
export function createLogger(options: LoggerOptions): Logger {
  const { writer, clock, minLevel, bound } = options;
  const minRank = logLevels.indexOf(minLevel);
  if (
    typeof (writer as Partial<LineWriter> | null)?.write !== 'function' ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function' ||
    minRank < 0
  ) {
    throw new TypeError('The logger needs a writer, a clock and a level.');
  }
  const boundValues = readBound(bound);
  const prompts = readPrompts(options.prompts);
  // Only true counts, also from a caller without types.
  const anchors = options.anchors === true;
  let busy = false;

  const log = (level: LogLevel, event: unknown, input: unknown): void => {
    if (busy) return;
    busy = true;
    try {
      const line = emptyRecord();
      line['ts'] = timestamp(clock);
      line['level'] = level;
      // Only a name of the catalog: an event made from data, by the core or
      // by a plugin, would carry that data into the log (ADR 0054).
      line['event'] =
        isEventName(event) && isLogEvent(event) ? event : replacedEventName;
      const { values, dropped } = admit(input, prompts, anchors);
      for (const field of fields) {
        const value = (field.bound ? boundValues : values)[field.name];
        if (value !== undefined) line[field.name] = value;
      }
      if (dropped > 0) line['dropped'] = Math.min(dropped, maxDropped);
      // A null-prototype object: a toJSON added to Object.prototype has no
      // effect on it.
      writer.write(JSON.stringify(line));
    } catch {
      // A logger never throws, also not when its writer does.
    } finally {
      busy = false;
    }
  };

  const at =
    (level: LogLevel) =>
    (event: string, input?: LogFields): void => {
      if (logLevels.indexOf(level) < minRank) return;
      log(level, event, input);
    };

  // The methods are frozen as well: a tool that hung a value on one could
  // pass it to the next call that shares the logger.
  return Object.freeze({
    debug: Object.freeze(at('debug')),
    info: Object.freeze(at('info')),
    warn: Object.freeze(at('warn')),
    error: Object.freeze(at('error')),
  });
}
