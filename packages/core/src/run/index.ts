/**
 * The parts of a run of a routine that the core keeps for itself (ADR
 * 0033): the system text and the level of the call of the model, which
 * failures a later try may pass (ADR 0034), and the content policy for the
 * texts and the section a run writes (ADR 0030). The engine of a run in
 * the package of the workflows uses them; it never reaches the content
 * policy or the redaction itself.
 *
 * @packageDocumentation
 */
export type { ContentCheckResult } from '../content/index.js';
export {
  checkRunSection,
  checkRunText,
  escapeRunText,
  runContactKeys,
} from './content.js';
export { createRunId, runAssignmentOf } from './id.js';
export {
  isTransientRunCode,
  modelRedactionOf,
  runSystemText,
} from './model.js';
