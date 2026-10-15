/**
 * Messages of the command line for operators, in German, on stdout and
 * stderr. The stdio mode never reaches this module, because stdout belongs
 * to the MCP protocol there (ADR 0053).
 *
 * @packageDocumentation
 */
export {
  createOutput,
  maxOutputLength,
  type Output,
  type OutputOptions,
} from './write.js';
export { renderConfigReport, type ReportOptions } from './report.js';
export {
  helpLines,
  internalErrorText,
  usageLine,
  type UsageProblem,
  usageProblemTexts,
} from './usage.js';
