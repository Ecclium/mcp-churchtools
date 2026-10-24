/**
 * The codes the loader of the configuration reports (ADR 0055). A code
 * names a rule and, in the report, the variable, never a value. The
 * messages of the command line and the log event `config_<code>` are made
 * from it.
 *
 * @packageDocumentation
 */
import { originCodes } from '../http/index.js';
import { stateDirCodes } from './state-dir.js';
import { tokenFileCodes } from './token-file.js';

/** Why the configuration cannot start the server, frozen. */
export const configProblemCodes = Object.freeze([
  'unknown_variable',
  'miscased_variable',
  'unsupported_variable',
  'proxy_unsupported',
  'search_tools_replaced',
  'tls_check_disabled',
  'debug_output_enabled',
  'tls_keylog_enabled',
  'tls_trace_enabled',
  'empty_value',
  'value_too_long',
  'invalid_choice',
  'invalid_integer',
  'invalid_toolsets',
  'url_missing',
  ...originCodes,
  'token_missing',
  'token_conflict',
  ...tokenFileCodes,
  'redaction_strict_unsupported',
  'stdio_only',
  'subject_invalid',
  'subject_reserved',
  ...stateDirCodes,
  'toolsets_without_state_dir',
] as const);

/** Why the configuration cannot start the server. */
export type ConfigProblemCode = (typeof configProblemCodes)[number];

/** What the start reports although it goes on, frozen. */
export const configWarningCodes = Object.freeze([
  'token_from_environment',
  'redaction_off',
  'persons_toolset_enabled',
  'trust_store_extended',
] as const);

/** What the start reports although it goes on. */
export type ConfigWarningCode = (typeof configWarningCodes)[number];
