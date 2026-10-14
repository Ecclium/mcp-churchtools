/**
 * Core shared by server and runner: configuration, tenant context, the
 * ChurchTools client and the single outbound HTTP path, tool registry and
 * pipeline, redaction, write guard, policies, audit and logging.
 *
 * @packageDocumentation
 */
export {
  configProblemCodes,
  type ConfigProblem,
  type ConfigProblemCode,
  type ConfigReport,
  type ConfigResult,
  type ConfigSources,
  configWarningCodes,
  type ConfigWarningCode,
  defaultStdioSubject,
  type EccliumConfig,
  loadConfig,
  maxReportedProblems,
  proxyVariableName,
  type SettingKey,
  type SettingReport,
  type ShownValue,
  tlsVariableName,
  type TokenFileCode,
  tokenFileCodes,
  type TokenFileStats,
  type TokenFileSystem,
  tokenVariableName,
  type Transport,
  unsupportedVariableNames,
  type ValueOrigin,
  type Variable,
  type VariableKind,
  type VariableName,
  variableNames,
  variablePrefix,
  variables,
} from './config/index.js';
