/**
 * The catalog of every log line that the code of Ecclium writes: the name
 * of its event, its level and the fields a call may set (ADR 0054). The
 * logger writes no other event. A name outside the catalog becomes
 * `invalid_event`, so that no name made from data reaches a line, also not
 * from a plugin. A test of the architecture reads every call of a logger in
 * the code of the packages and fails on a line without an entry, at
 * another level or with a field its entry does not name, and on an entry
 * that no code names.
 *
 * @packageDocumentation
 */

/** The levels, from the least to the most severe. */
export const logLevels = Object.freeze([
  'debug',
  'info',
  'warn',
  'error',
] as const);

/** A level of a log line. */
export type LogLevel = (typeof logLevels)[number];

/**
 * A field that a call of the logger may set. The core binds the other
 * fields of a line, such as `tenantId` and `tool`, to the logger itself.
 */
export type LogCallField =
  | 'prompt'
  | 'code'
  | 'durationMs'
  | 'count'
  | 'method'
  | 'status'
  | 'attempt'
  | 'file'
  | 'seq'
  | 'hash';

/** What the catalog says about one event. */
export interface LogEventEntry {
  /** The level its line has. */
  readonly level: LogLevel;
  /** The fields a call may set, in the order of the line; often fewer. */
  readonly fields: readonly LogCallField[];
}

const entry = (
  level: LogLevel,
  ...fields: readonly LogCallField[]
): LogEventEntry => Object.freeze({ level, fields: Object.freeze(fields) });

// Every event of one family gets the same entry. The names stay written
// out, so that each one is found by a search and the types below are
// closed lists.
const family = <const Names extends readonly string[]>(
  names: Names,
  shared: LogEventEntry,
): { readonly [Name in Names[number]]: LogEventEntry } =>
  Object.fromEntries(names.map((name) => [name, shared])) as {
    readonly [Name in Names[number]]: LogEventEntry;
  };

// An answer of ChurchTools with a status other than that of success, 200
// for a read and for changing a page, 201 for creating one, per operation.
const statusEvents = Object.freeze([
  'churchtools_agenda_status',
  'churchtools_appointment_status',
  'churchtools_appointments_status',
  'churchtools_bookings_status',
  'churchtools_calendars_status',
  'churchtools_event_assignments_status',
  'churchtools_event_status',
  'churchtools_events_status',
  'churchtools_group_members_status',
  'churchtools_group_status',
  'churchtools_groups_status',
  'churchtools_operation_status',
  'churchtools_permissions_status',
  'churchtools_person_groups_status',
  'churchtools_person_status',
  'churchtools_persons_status',
  'churchtools_resource_types_status',
  'churchtools_resources_status',
  'churchtools_search_status',
  'churchtools_service_groups_status',
  'churchtools_services_status',
  'churchtools_song_status',
  'churchtools_songs_status',
  'churchtools_whoami_status',
  'churchtools_wiki_categories_status',
  'churchtools_wiki_page_create_status',
  'churchtools_wiki_page_status',
  'churchtools_wiki_page_update_status',
  'churchtools_wiki_pages_status',
  'churchtools_wiki_search_status',
] as const);

// An answer of success that the client does not take, per operation.
const refusedEvents = Object.freeze([
  'churchtools_agenda_refused',
  'churchtools_appointment_refused',
  'churchtools_appointments_refused',
  'churchtools_bookings_refused',
  'churchtools_calendars_refused',
  'churchtools_event_assignments_refused',
  'churchtools_event_refused',
  'churchtools_events_refused',
  'churchtools_group_members_refused',
  'churchtools_group_refused',
  'churchtools_groups_refused',
  'churchtools_operation_answer_refused',
  'churchtools_permissions_refused',
  'churchtools_person_groups_refused',
  'churchtools_person_refused',
  'churchtools_persons_refused',
  'churchtools_resource_types_refused',
  'churchtools_resources_refused',
  'churchtools_search_refused',
  'churchtools_service_groups_refused',
  'churchtools_services_refused',
  'churchtools_song_refused',
  'churchtools_songs_refused',
  'churchtools_whoami_refused',
  'churchtools_wiki_categories_refused',
  'churchtools_wiki_page_create_refused',
  'churchtools_wiki_page_refused',
  'churchtools_wiki_pages_refused',
  'churchtools_wiki_search_refused',
] as const);

// A 404 of an operation that reads or writes one object by its ID.
const missingEvents = Object.freeze([
  'churchtools_agenda_missing',
  'churchtools_appointment_missing',
  'churchtools_event_assignments_missing',
  'churchtools_event_missing',
  'churchtools_group_members_missing',
  'churchtools_group_missing',
  'churchtools_operation_missing',
  'churchtools_person_groups_missing',
  'churchtools_person_missing',
  'churchtools_song_missing',
  'churchtools_wiki_page_create_missing',
  'churchtools_wiki_page_missing',
  'churchtools_wiki_page_update_missing',
] as const);

// A search term that the client refuses before it asks ChurchTools.
const termEvents = Object.freeze([
  'churchtools_groups_term_refused',
  'churchtools_persons_term_refused',
] as const);

// A failure on the outbound path, `http_<category>` (ADR 0056).
const httpFailureEvents = Object.freeze([
  'http_aborted',
  'http_connect',
  'http_encoding',
  'http_failed',
  'http_interrupted',
  'http_redirect',
  'http_refused',
  'http_status',
  'http_timeout',
  'http_tls',
  'http_too_large',
] as const);

// A value of a producer that the sink of the audit does not take, or the
// line it could not build (ADR 0028). The line of the audit then holds a
// placeholder.
const auditSinkEvents = Object.freeze([
  'audit_invalid_actor',
  'audit_invalid_actor_id',
  'audit_invalid_actor_kind',
  'audit_invalid_confirmation',
  'audit_invalid_data_protection_regime',
  'audit_invalid_duration_ms',
  'audit_invalid_error_code',
  'audit_invalid_event_id',
  'audit_invalid_mode',
  'audit_invalid_object_refs',
  'audit_invalid_object_refs_omitted',
  'audit_invalid_outcome',
  'audit_invalid_plugin_hashes',
  'audit_invalid_policy_hash',
  'audit_invalid_provider',
  'audit_invalid_provider_endpoint_host',
  'audit_invalid_provider_hosting_country',
  'audit_invalid_provider_model',
  'audit_invalid_provider_transfer_basis',
  'audit_invalid_provider_vendor',
  'audit_invalid_routine_id',
  'audit_invalid_run_id',
  'audit_invalid_tenant_id',
  'audit_invalid_tool',
  'audit_invalid_ts',
  'audit_invalid_type',
  'audit_missing_error_code',
  'audit_reserved_event_id',
  'audit_reserved_prev_hash',
  'audit_reserved_seq',
  'audit_reserved_ts',
  'audit_reserved_v',
  'audit_reserved_withheld_after_read',
  'audit_schema_mismatch',
  'audit_unknown_fields',
  'audit_unreadable',
] as const);

/**
 * Every event with its entry, frozen. The keys are the only events a line
 * may name, apart from `invalid_event`, which the logger writes in place of
 * any other name.
 */
export const logEvents = Object.freeze({
  // The pipeline of the tools (ADR 0024, ADR 0063, ADR 0069).
  tool_call: entry('info', 'code', 'durationMs'),
  tool_output_invalid: entry('warn'),
  tool_pseudonym_failed: entry('warn'),
  tool_boundary_failed: entry('warn'),
  tool_result_too_large: entry('warn'),
  audit_withheld: entry('warn', 'code'),
  pseudonym_keys_unavailable: entry('warn'),
  read_budget_exhausted: entry('warn'),
  read_budget_unavailable: entry('warn'),
  // The escape hatch (ADR 0067).
  read_search_refused: entry('warn', 'code'),
  read_names_refused: entry('warn', 'code'),
  read_operation_refused: entry('warn', 'code'),
  read_operation_collision: entry('warn', 'code'),
  read_operation_too_large: entry('warn', 'code'),
  // The mount and the prompts (ADR 0024, ADR 0065).
  mcp_validator_refused: entry('error'),
  mcp_server_error: entry('error'),
  mcp_call_failed: entry('error'),
  mcp_stdio_error: entry('error'),
  prompt_served: entry('info', 'prompt'),
  prompt_refused: entry('warn', 'prompt', 'code'),
  prompt_unknown: entry('warn'),
  // The client of ChurchTools (ADR 0022, ADR 0064).
  churchtools_context_mismatch: entry('error', 'code'),
  churchtools_throttled: entry('warn', 'code'),
  ...family(statusEvents, entry('warn', 'code', 'status')),
  ...family(refusedEvents, entry('warn', 'code')),
  ...family(missingEvents, entry('warn', 'code', 'status')),
  ...family(termEvents, entry('warn', 'code')),
  churchtools_whoami_anonymous: entry('warn', 'code'),
  churchtools_permissions_unknown: entry('warn'),
  churchtools_read_input_refused: entry('warn', 'code'),
  churchtools_wiki_input_refused: entry('warn', 'code'),
  churchtools_wiki_write_input_refused: entry('warn', 'code'),
  churchtools_event_input_refused: entry('warn', 'code'),
  churchtools_calendar_input_refused: entry('warn', 'code'),
  churchtools_song_input_refused: entry('warn', 'code'),
  churchtools_search_input_refused: entry('warn', 'code'),
  churchtools_search_term_refused: entry('warn', 'code'),
  churchtools_appointments_foreign: entry('warn', 'code'),
  churchtools_appointment_foreign: entry('warn', 'code'),
  churchtools_bookings_foreign: entry('warn', 'code'),
  churchtools_wiki_search_foreign: entry('warn', 'code'),
  churchtools_search_foreign: entry('warn', 'code'),
  churchtools_operation_unknown: entry('warn', 'code'),
  churchtools_operation_refused: entry('warn', 'code'),
  churchtools_operation_input_refused: entry('warn', 'code'),
  churchtools_operation_too_large: entry('warn', 'code'),
  // The outbound path (ADR 0056), with the method of each request (ADR 0072).
  http_response: entry('info', 'durationMs', 'method', 'status'),
  ...family(httpFailureEvents, entry('warn', 'code', 'durationMs', 'method')),
  // The sink of the audit and the audit file (ADR 0028).
  ...family(auditSinkEvents, entry('error', 'code', 'count')),
  audit_chain_anchor: entry('info', 'file', 'seq', 'hash'),
  audit_file_closed: entry('info', 'count'),
  audit_files_deleted: entry('info', 'count'),
  audit_files_not_deleted: entry('warn', 'count'),
  // The process of `ecclium stdio` (ADR 0053).
  stdio_start_failed: entry('error', 'code'),
  stdio_closed: entry('info', 'count'),
  process_uncaught_exception: entry('error', 'code'),
  process_unhandled_rejection: entry('error', 'code'),
  process_sigterm: entry('info'),
  process_sigint: entry('info'),
});

/** The name of an event of the catalog. */
export type LogEventName = keyof typeof logEvents;

/** An answer of ChurchTools with a status other than that of success. */
export type ChurchToolsStatusEvent = (typeof statusEvents)[number];

/** An answer of success that the client does not take. */
export type ChurchToolsRefusedEvent = (typeof refusedEvents)[number];

/** A 404 of an operation that reads or writes one object by its ID. */
export type ChurchToolsMissingEvent = (typeof missingEvents)[number];

/** A search term that the client refuses. */
export type ChurchToolsTermEvent = (typeof termEvents)[number];

/** A failure on the outbound path. */
export type HttpFailureEvent = (typeof httpFailureEvents)[number];

/** A value or a line that the sink of the audit does not take. */
export type AuditSinkEvent = (typeof auditSinkEvents)[number];

/**
 * Tells whether a value is the name of an event of the catalog, compared
 * exactly. Inherited names such as `toString` are none.
 *
 * @param value - Any value.
 * @returns Whether it is one.
 * @example
 * ```ts
 * isLogEvent('tool_call'); // true
 * isLogEvent('person_12'); // false
 * ```
 */
export function isLogEvent(value: unknown): value is LogEventName {
  return typeof value === 'string' && Object.hasOwn(logEvents, value);
}
