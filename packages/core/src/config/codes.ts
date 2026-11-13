/**
 * The codes the loader of the configuration reports (ADR 0055). A code
 * names a rule and, in the report, the variable, never a value. The
 * messages of the command line and the log event `config_<code>` are made
 * from it.
 *
 * @packageDocumentation
 */
import { originCodes } from '../http/index.js';
import { policyCodes } from '../policy/file.js';
import { providersCodes } from '../providers/file.js';
import { markerKeyFileCodes } from './marker-key-file.js';
import { pingUrlFileCodes } from './ping-url-file.js';
import { pseudonymKeyFileCodes } from './pseudonym-key-file.js';
import { runnerTokenCodes } from './runner-token.js';
import {
  keysDirCodes,
  runnerTokensDirCodes,
  stateDirCodes,
} from './state-dir.js';
import { tokenFileCodes } from './token-file.js';

/** Why the configuration cannot start the server or the runner, frozen. */
export const configProblemCodes = Object.freeze([
  'unknown_variable',
  'miscased_variable',
  'unsupported_variable',
  'search_tools_replaced',
  'tls_check_disabled',
  'debug_output_enabled',
  'yaml_debug_output_enabled',
  'tls_keylog_enabled',
  'tls_trace_enabled',
  'empty_value',
  'value_too_long',
  'invalid_choice',
  'invalid_integer',
  'invalid_retention',
  'invalid_toolsets',
  'time_zone_invalid',
  'routines_dir_invalid',
  'runner_tokens_dir_invalid',
  'drafts_dir_invalid',
  'drafts_dir_overlap',
  'notify_file_invalid',
  'notify_file_overlap',
  'metrics_file_invalid',
  'metrics_file_overlap',
  // The file with the address of the ping of the runner (ADR 0009).
  ...pingUrlFileCodes,
  // The proxy of outbound connections and the switch for the runner
  // without one (ADR 0035).
  'egress_proxy_invalid',
  'egress_off_with_proxy',
  // The targets in the local network (ADR 0035).
  'egress_allow_lan_invalid',
  'egress_allow_lan_unknown',
  'url_missing',
  ...originCodes,
  'token_missing',
  'token_conflict',
  ...tokenFileCodes,
  ...pseudonymKeyFileCodes,
  'pseudonym_key_missing',
  'pseudonym_key_previous_without_current',
  'pseudonym_key_same',
  'stdio_only',
  'subject_invalid',
  'subject_reserved',
  ...stateDirCodes,
  'toolsets_without_state_dir',
  'writes_without_state_dir',
  'writes_without_stop_dir',
  // The folder of the kill switches (ADR 0029, ADR 0036).
  'kill_switch_dir_invalid',
  'kill_switch_dir_overlap',
  'kill_switch_dir_writable',
  'kill_switch_dir_required',
  ...keysDirCodes,
  'keys_dir_required',
  'keys_dir_in_state_dir',
  'state_dir_in_keys_dir',
  'redaction_strict_with_api',
  'state_dir_required',
  // The rules of the runner (ADR 0033, ADR 0034): what it needs besides
  // the server, its own account instead of the token of the server, and
  // the folder of the token files of its accounts.
  'runner_server_token',
  'runner_stdio_only',
  'runner_time_zone_required',
  'runner_policy_required',
  'runner_routines_dir_required',
  'runner_state_dir_required',
  'runner_tokens_dir_required',
  'runner_tokens_dir_in_state_dir',
  'runner_egress_required',
  ...runnerTokensDirCodes,
  ...runnerTokenCodes,
  ...policyCodes,
  ...markerKeyFileCodes,
  'marker_key_same',
  'marker_key_missing',
  'inquiries_missing',
  ...providersCodes,
] as const);

/** Why the configuration cannot start the server or the runner. */
export type ConfigProblemCode = (typeof configProblemCodes)[number];

/** What the start reports although it goes on, frozen. */
export const configWarningCodes = Object.freeze([
  'token_from_environment',
  'redaction_off',
  'pseudonym_key_change',
  'persons_toolset_enabled',
  'events_toolset_enabled',
  'api_toolset_enabled',
  'writes_enabled',
  'snapshots_off',
  'echo_over_http',
  'trust_store_extended',
  'audit_retention_short',
  'audit_retention_without_state_dir',
  'egress_off',
  'environment_proxy_ignored',
  'egress_allow_lan_unused',
] as const);

/** What the start reports although it goes on. */
export type ConfigWarningCode = (typeof configWarningCodes)[number];
