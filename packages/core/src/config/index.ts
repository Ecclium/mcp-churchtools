/**
 * The configuration of the server (ADR 0055): the table of variables, the
 * codes and the loader. This entry passes on no zod schema, no pattern and
 * not the reader of the token file, and so no entry of core does: a schema
 * can be widened after it is made, and a pattern recompiled in place.
 * Inside core, the identity over stdio reads the pattern of the subject
 * from `variables.ts` directly.
 *
 * @packageDocumentation
 */
export {
  configProblemCodes,
  type ConfigProblemCode,
  configWarningCodes,
  type ConfigWarningCode,
} from './codes.js';
export {
  type ConfigProblem,
  type ConfigReport,
  type ConfigResult,
  type ConfigSources,
  type EccliumConfig,
  loadConfig,
  maxReportedProblems,
  type SettingKey,
  type SettingReport,
  type ShownValue,
  type Transport,
  type ValueOrigin,
} from './load.js';
export {
  type StateDirCode,
  stateDirCodes,
  type StateDirFileSystem,
  type StateDirStats,
} from './state-dir.js';
export {
  type TokenFileCode,
  tokenFileCodes,
  type TokenFileStats,
  type TokenFileSystem,
} from './token-file.js';
export {
  defaultStdioSubject,
  proxyVariableName,
  recommendedRetentionMonths,
  requestsPerMinuteRange,
  retentionMonthsRange,
  searchToolsVariableName,
  tlsVariableName,
  tokenVariableName,
  unsupportedVariableNames,
  type Variable,
  type VariableKind,
  type VariableName,
  variableNames,
  variablePrefix,
  variables,
} from './variables.js';
