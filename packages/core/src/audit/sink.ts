/**
 * The audit sink: one audit line per event, written through the line writer
 * of the logger onto the same stream (ADR 0054). With an audit file, each
 * line goes into the file first and then as a copy onto that stream, and
 * the file is where a line counts (ADR 0028).
 *
 * @packageDocumentation
 */
import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';

import type {
  AuditEventV1,
  Clock,
  TenantId,
} from '@ecclium/mcp-churchtools-plugin-api';
import type { z } from 'zod';

import {
  createLogger,
  isUuid,
  type LineWriter,
  toTimestamp,
} from '../logger/index.js';
import {
  auditEventV1Schema,
  auditFieldSchemas as fields,
  auditLimits,
  auditPlaceholders as placeholders,
} from './schema.js';

/**
 * What a producer hands to the sink. The sink alone sets `v`, `eventId` and
 * `ts`; `seq` and `prevHash` belong to a sink that chains its events. The ID
 * of a tool call comes as an argument of its own, never as a field of the
 * draft (ADR 0054).
 */
export type AuditDraft = Omit<
  AuditEventV1,
  'v' | 'eventId' | 'ts' | 'seq' | 'prevHash'
>;

/**
 * The audit file as the sink sees it: a line writer that also tells
 * whether it can take a line now (ADR 0028).
 */
export interface AuditFileTarget extends LineWriter {
  /**
   * Tells whether the file can take a line now.
   *
   * @returns Whether the file is ready.
   */
  ready(): boolean;
}

/** Options of `record` of {@link AuditSink}. */
export interface RecordOptions {
  /**
   * Whether the result of the call goes out only when its line is
   * recorded, as for a tool with `sensitivity: special`. A line with the
   * outcome `ok` that the sink cannot record as it is then says `denied`
   * with `policy_denied` instead (ADR 0028).
   */
  readonly required?: boolean;
}

/** Options of {@link createAuditSink}. */
export interface AuditSinkOptions {
  /**
   * The line writer of the logger: for the log lines of the sink and, with
   * an audit file, for the copy of each audit line.
   */
  readonly writer: LineWriter;
  /**
   * The audit file over stdio, the target that counts when it is given.
   * Without it, the writer of the logger is the target.
   */
  readonly file?: AuditFileTarget;
  /** The time of each event. */
  readonly clock: Clock;
  /**
   * Tells whether a tool is registered, so that no tool name a client made
   * up reaches the audit.
   */
  readonly isKnownTool: (name: string) => boolean;
  /** Makes the ID of an event; `randomUUID` unless a test replaces it. */
  readonly newId?: () => string;
}

/** Records audit events. */
export interface AuditSink {
  /**
   * Writes one audit line for the event, synchronously, with an audit file
   * first into the file and then as a copy onto the stream of the logger.
   * It never throws: an invalid field is replaced or left out, and
   * reported in a log line.
   *
   * @param draft - The event without `v`, `eventId` and `ts`.
   * @param eventId - The ID the pipeline drew for a tool call and bound to
   *   the log lines of its context, so that log and audit share it. The
   *   sink checks a given ID like one of its own and also refuses the nil
   *   UUID, the placeholder of a failed ID. When the ID is missing, the
   *   sink draws one with `newId`.
   * @param options - Whether the result of the call needs its line.
   * @returns Whether the whole line reached its target, the audit file if
   *   there is one, and the sink had nothing to report. A lost copy on the
   *   stream of the logger changes nothing when there is a file.
   */
  record(draft: AuditDraft, eventId?: string, options?: RecordOptions): boolean;
  /** Whether the sink writes into an audit file. */
  readonly hasFile: boolean;
  /**
   * Tells whether the audit file can take a line now. Without a file it is
   * always false.
   *
   * @returns Whether a line could be recorded in the file.
   */
  ready(): boolean;
  /**
   * Returns how many audit lines could not be written whole into their
   * target, the audit file if there is one.
   *
   * @returns The count.
   */
  failures(): number;
}

type Json =
  | string
  | number
  | boolean
  | readonly Json[]
  | { readonly [key: string]: Json };

type Line = Record<string, Json>;

interface Report {
  readonly event: string;
  readonly count?: number;
}

const maxCount = 1_000_000;

// The outcome and code of a line whose call holds back its result.
const withheldOutcome = 'denied';
const withheldCode = 'policy_denied';

// Stands for a getter or a setter, which is never called.
const accessor: unique symbol = Symbol('accessor');

const producerKeys: readonly string[] = Object.freeze([
  'type',
  'tenantId',
  'actor',
  'mode',
  'runId',
  'routineId',
  'tool',
  'outcome',
  'confirmation',
  'policyHash',
  'provider',
  'pluginHashes',
  'dataProtectionRegime',
  'objectRefs',
  'errorCode',
  'durationMs',
]);

// Keys the sink sets itself, with the event that reports them.
const reservedKeys: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(['v', 'audit_reserved_v'] as const),
  Object.freeze(['eventId', 'audit_reserved_event_id'] as const),
  Object.freeze(['ts', 'audit_reserved_ts'] as const),
  Object.freeze(['seq', 'audit_reserved_seq'] as const),
  Object.freeze(['prevHash', 'audit_reserved_prev_hash'] as const),
]);

const knownKeys: readonly string[] = Object.freeze([
  ...producerKeys,
  ...reservedKeys.map(([key]) => key),
]);

const providerFields = Object.freeze([
  ['vendor', fields.vendor, 'audit_invalid_provider_vendor', false],
  ['model', fields.model, 'audit_invalid_provider_model', false],
  [
    'hostingCountry',
    fields.hostingCountry,
    'audit_invalid_provider_hosting_country',
    false,
  ],
  [
    'endpointHost',
    fields.endpointHost,
    'audit_invalid_provider_endpoint_host',
    false,
  ],
  ['transferBasis', fields.term, 'audit_invalid_provider_transfer_basis', true],
] as const);

// Objects without prototype: neither a key added to Object.prototype nor a
// toJSON there can change a copy or the line.
const bare = (): Line => Object.create(null) as Line;

const bareActor = (kind: string, id: string): Line => {
  const actor = bare();
  actor['kind'] = kind;
  actor['id'] = id;
  return actor;
};

// An object whose own properties can be read without running its code.
const isPlainTarget = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !isProxy(value);

// An own data property, or the marker for an accessor. Inherited properties
// do not count.
const own = (target: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(target, key);
  if (property === undefined) return undefined;
  return Object.hasOwn(property, 'value') ? property.value : accessor;
};

// zod is asked yes or no. Its error, which can hold the value, is never
// read.
const passes = (schema: z.ZodType, value: unknown): boolean => {
  try {
    return schema.safeParse(value).success;
  } catch {
    return false;
  }
};

// A value of the draft goes to zod only as a primitive. zod reads properties
// such as length of an object even after its type check failed, which would
// run a getter or a trap of the caller.
const fits = (schema: z.ZodType, value: unknown): boolean =>
  value !== accessor &&
  (value === null ||
    (typeof value !== 'object' && typeof value !== 'function')) &&
  passes(schema, value);

const unknownKeys = (target: object, known: readonly string[]): number =>
  Reflect.ownKeys(target).filter(
    (key) => typeof key !== 'string' || !known.includes(key),
  ).length;

interface Copied {
  readonly list?: string[];
  readonly count?: number;
}

// A copy of a list of strings. The length is read once and checked before
// any entry, and entries are read by index, so no iterator runs and no huge
// list is walked.
const copyList = (value: unknown, limit: number): Copied => {
  if (!isPlainTarget(value) || !Array.isArray(value)) return {};
  const length = own(value, 'length');
  if (typeof length !== 'number') return {};
  const count = Math.min(length, maxCount);
  if (length > limit) return { count };
  const list: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = own(value, String(index));
    if (typeof item !== 'string') return { count };
    list.push(item);
  }
  return { list, count };
};

// JSON by hand from checked values. JSON.stringify sees only primitives, so
// no toJSON anywhere can change the line.
const toJson = (value: Json): string => {
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${(value as readonly Json[]).map(toJson).join(',')}]`;
  }
  const object = value as Readonly<Record<string, Json>>;
  return `{${Object.keys(object)
    .map((key) => `${JSON.stringify(key)}:${toJson(object[key] ?? '')}`)
    .join(',')}}`;
};

// The fields of a line after v, eventId and ts, for a draft that cannot be
// read at all.
const fillPlaceholders = (line: Line): void => {
  line['type'] = placeholders.type;
  line['tenantId'] = placeholders.tenantId;
  line['actor'] = bareActor(placeholders.actor.kind, placeholders.actor.id);
  line['mode'] = placeholders.mode;
  line['outcome'] = placeholders.outcome;
  line['objectRefs'] = [];
  line['errorCode'] = placeholders.errorCode;
  line['durationMs'] = placeholders.durationMs;
};

// Checks the draft field by field and fills the line in the order of the
// schema. An invalid required field gets its placeholder, an invalid
// optional field is left out, and each one is reported once. Returns
// whether the tenant ID was valid.
function fill(
  draft: object,
  line: Line,
  report: (event: string, count?: number) => void,
  knows: (name: string) => boolean,
): boolean {
  let unknown = 0;
  for (const [key, event] of reservedKeys) {
    if (own(draft, key) !== undefined) report(event);
  }

  const scalar = (
    key: string,
    schema: z.ZodType,
    event: string,
    placeholder?: Json,
  ): boolean => {
    const value = own(draft, key);
    if (value === undefined && placeholder === undefined) return true;
    if (fits(schema, value)) {
      line[key] = value as Json;
      return true;
    }
    report(event);
    if (placeholder !== undefined) line[key] = placeholder;
    return false;
  };

  const list = (
    key: string,
    limit: number,
    schema: z.ZodType,
    event: string,
    required: boolean,
  ): void => {
    const value = own(draft, key);
    if (value === undefined && !required) return;
    const { list: copy, count } = copyList(value, limit);
    if (copy?.every((item) => fits(schema, item)) === true) {
      line[key] = copy;
      return;
    }
    report(event, count);
    if (required) line[key] = [];
  };

  scalar('type', fields.type, 'audit_invalid_type', placeholders.type);
  const tenantValid = scalar(
    'tenantId',
    fields.tenantId,
    'audit_invalid_tenant_id',
    placeholders.tenantId,
  );

  const actor = own(draft, 'actor');
  if (isPlainTarget(actor)) {
    const kind = own(actor, 'kind');
    const id = own(actor, 'id');
    unknown += unknownKeys(actor, ['kind', 'id']);
    const kindValid = fits(fields.actorKind, kind);
    const idValid = fits(fields.actorId, id);
    if (!kindValid) report('audit_invalid_actor_kind');
    if (!idValid) report('audit_invalid_actor_id');
    // A valid ID is never written under a kind it may not belong to.
    line['actor'] =
      kindValid && idValid
        ? bareActor(kind as string, id as string)
        : bareActor(placeholders.actor.kind, placeholders.actor.id);
  } else {
    report('audit_invalid_actor');
    line['actor'] = bareActor(placeholders.actor.kind, placeholders.actor.id);
  }

  scalar('mode', fields.mode, 'audit_invalid_mode', placeholders.mode);
  scalar('runId', fields.runId, 'audit_invalid_run_id');
  scalar('routineId', fields.routineId, 'audit_invalid_routine_id');

  const tool = own(draft, 'tool');
  if (tool !== undefined) {
    // ct_unknown is what the pipeline writes for a tool that does not
    // exist; it is valid and not asked about.
    if (
      tool === placeholders.tool ||
      (fits(fields.tool, tool) && knows(tool as string))
    ) {
      line['tool'] = tool as string;
    } else {
      report('audit_invalid_tool');
      line['tool'] = placeholders.tool;
    }
  }

  scalar(
    'outcome',
    fields.outcome,
    'audit_invalid_outcome',
    placeholders.outcome,
  );
  scalar('confirmation', fields.confirmation, 'audit_invalid_confirmation');
  scalar('policyHash', fields.hash, 'audit_invalid_policy_hash');

  const provider = own(draft, 'provider');
  if (provider !== undefined) {
    if (isPlainTarget(provider)) {
      const copy = bare();
      let valid = true;
      for (const [key, schema, event, optional] of providerFields) {
        const value = own(provider, key);
        if (optional && value === undefined) continue;
        if (fits(schema, value)) {
          copy[key] = value as Json;
        } else {
          valid = false;
          report(event);
        }
      }
      unknown += unknownKeys(
        provider,
        providerFields.map(([key]) => key),
      );
      if (valid) line['provider'] = copy;
    } else {
      report('audit_invalid_provider');
    }
  }

  list(
    'pluginHashes',
    auditLimits.pluginHashes,
    fields.hash,
    'audit_invalid_plugin_hashes',
    false,
  );
  scalar(
    'dataProtectionRegime',
    fields.term,
    'audit_invalid_data_protection_regime',
  );
  list(
    'objectRefs',
    auditLimits.objectRefs,
    fields.objectRef,
    'audit_invalid_object_refs',
    true,
  );

  // An outcome of ok has no error code; error and denied need one.
  const errorCode = own(draft, 'errorCode');
  if (line['outcome'] === 'ok') {
    if (errorCode !== undefined) report('audit_invalid_error_code');
  } else if (errorCode === undefined) {
    report('audit_missing_error_code');
    line['errorCode'] = placeholders.errorCode;
  } else if (fits(fields.errorCode, errorCode)) {
    line['errorCode'] = errorCode as string;
  } else {
    report('audit_invalid_error_code');
    line['errorCode'] = placeholders.errorCode;
  }

  scalar(
    'durationMs',
    fields.durationMs,
    'audit_invalid_duration_ms',
    placeholders.durationMs,
  );

  unknown += unknownKeys(draft, knownKeys);
  if (unknown > 0) report('audit_unknown_fields', Math.min(unknown, maxCount));
  return tenantValid;
}

/**
 * Creates the audit sink. Each record writes one line with `v`, `eventId`
 * as given or else from `newId`, `ts` from the clock and the fields of the
 * draft in a fixed order, then one log line per invalid field, with an
 * event such as `audit_invalid_tenant_id`, the code `validation` and the ID
 * of the event. Only own data properties of the draft are read; a getter, a
 * proxy, an unknown key or a value that breaks its pattern never reaches
 * the line. zod is asked only whether a value passes, never for its error,
 * which can hold the value. A line that cannot be written is counted and
 * dropped.
 *
 * With an audit file, the line goes into the file first and then as a copy
 * through the writer of the logger, and only the file decides what
 * `record` returns. With `required`, a line with the outcome `ok` says
 * `denied` with `policy_denied` as soon as the sink has something to
 * report, and the copy says so when the file did not take the line, so
 * that no line says `ok` for a result the pipeline then holds back
 * (ADR 0028).
 *
 * @param options - Writer, clock, registry check, ID source and the audit
 *   file.
 * @returns The sink, frozen.
 * @throws {TypeError} If an option is not valid, with a fixed message.
 * @example
 * ```ts
 * const audit = createAuditSink({ writer, clock: systemClock, isKnownTool });
 * audit.record({ type: 'tool_call', tenantId, actor, mode, outcome: 'ok', objectRefs: [], durationMs: 12 });
 * // A tool call: the ID its context binds to its log lines.
 * audit.record(draft, eventId);
 * ```
 */
export function createAuditSink(options: AuditSinkOptions): AuditSink {
  const { writer, clock, isKnownTool, newId = randomUUID, file } = options;
  if (
    typeof (writer as Partial<LineWriter> | null)?.write !== 'function' ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function' ||
    typeof isKnownTool !== 'function' ||
    typeof newId !== 'function' ||
    (file !== undefined &&
      (typeof (file as Partial<AuditFileTarget> | null)?.write !== 'function' ||
        typeof (file as Partial<AuditFileTarget> | null)?.ready !== 'function'))
  ) {
    throw new TypeError(
      'The audit sink needs a writer, a clock, a tool check and an ID source.',
    );
  }
  let failures = 0;

  // A write that throws counts as lost, like one that returns false.
  const send = (target: LineWriter, line: string): boolean => {
    try {
      // Only true counts, also when a writer without types answers with
      // another value.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- see above
      return target.write(line) === true;
    } catch {
      return false;
    }
  };

  // Turns a line with the outcome ok into one that says its result was held
  // back, with the error code before the duration, where the schema puts
  // it.
  const withhold = (line: Line): void => {
    const duration = line['durationMs'] ?? 0;
    Reflect.deleteProperty(line, 'durationMs');
    line['outcome'] = withheldOutcome;
    line['errorCode'] = withheldCode;
    line['durationMs'] = duration;
  };

  const knows = (name: string): boolean => {
    try {
      // Only true counts, also when a check without types answers with
      // another value.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- see above
      return isKnownTool(name) === true;
    } catch {
      return false;
    }
  };

  const record = (
    draft: AuditDraft,
    eventId?: string,
    recordOptions?: RecordOptions,
  ): boolean => {
    const reports: Report[] = [];
    const report = (event: string, count?: number): void => {
      reports.push(count === undefined ? { event } : { event, count });
    };
    // The ID of a tool call comes from the pipeline, which bound it to the
    // log lines of the call (ADR 0054). Only code that holds the sink can
    // pass it; a draft field eventId is still reserved. The nil UUID is the
    // placeholder for a failed ID, so a given one counts as invalid, as the
    // tenant context refuses it too.
    let id: unknown = eventId;
    if (id === undefined) {
      try {
        id = newId();
      } catch {
        id = undefined;
      }
    } else if (id === placeholders.eventId) {
      id = undefined;
    }
    if (!isUuid(id)) {
      id = placeholders.eventId;
      report('audit_invalid_event_id');
    }
    let ts: string | undefined;
    try {
      ts = toTimestamp(clock.now());
    } catch {
      ts = undefined;
    }
    if (ts === undefined) {
      ts = placeholders.ts;
      report('audit_invalid_ts');
    }

    const start = (): Line => {
      const line = bare();
      line['v'] = 1;
      line['eventId'] = id as string;
      line['ts'] = ts;
      return line;
    };
    let line = start();
    let tenantValid: boolean;
    try {
      if (!isPlainTarget(draft)) throw new TypeError('unreadable');
      tenantValid = fill(draft, line, report, knows);
    } catch {
      reports.push({ event: 'audit_unreadable' });
      line = start();
      fillPlaceholders(line);
      tenantValid = false;
    }
    // The schema confirms what the checks above built. If it does not, the
    // sink has a bug, and the line holds only placeholders.
    if (!passes(auditEventV1Schema, line)) {
      reports.push({ event: 'audit_schema_mismatch' });
      line = start();
      fillPlaceholders(line);
      tenantValid = false;
    }

    // A required line that the sink had to change never says ok.
    const required = recordOptions?.required === true;
    if (required && reports.length > 0 && line['outcome'] === 'ok') {
      withhold(line);
    }

    let recorded: boolean;
    if (file === undefined) {
      recorded = send(writer, toJson(line));
    } else {
      recorded = send(file, toJson(line));
      // The copy tells the client what the file says, or that the result
      // is held back when the file did not take the line.
      if (!recorded && required && line['outcome'] === 'ok') withhold(line);
      send(writer, toJson(line));
    }
    if (!recorded) failures += 1;

    if (reports.length === 0) return recorded;
    try {
      const log = createLogger({
        writer,
        clock,
        minLevel: 'error',
        bound: tenantValid
          ? { eventId: id as string, tenantId: line['tenantId'] as TenantId }
          : { eventId: id as string },
      });
      for (const { event, count } of reports) {
        const code =
          event === 'audit_schema_mismatch' ? 'internal' : 'validation';
        log.error(event, count === undefined ? { code } : { code, count });
      }
    } catch {
      // Reporting never makes the record fail.
    }
    return false;
  };

  const ready = (): boolean => {
    if (file === undefined) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- only true counts, as for the writer
      return file.ready() === true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    record,
    hasFile: file !== undefined,
    ready,
    failures: () => failures,
  });
}
