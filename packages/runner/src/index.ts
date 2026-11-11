/**
 * Runs routines on schedule: one pass over the routines that are due, a
 * run by hand and a preview, each through ports that the composition root
 * of the command line builds (ADR 0033, ADR 0034). The daemon, which
 * starts a pass at each trigger, comes later.
 *
 * @packageDocumentation
 */
export {
  auditEndOf,
  type RunAuditEnd,
  type RunnerSeverity,
  runnerSeverities,
  type RunOutcome,
  severityOf,
  worseOf,
} from './outcome.js';
export {
  type DraftCall,
  type DraftResult,
  type OpenedRun,
  type OpenRunResult,
  type PassOptions,
  type PassReport,
  previewRoutine,
  type PreviewReport,
  type RoutineReport,
  type RoutineStatus,
  runByHand,
  runDue,
  type RunEndLine,
  type RunnerLock,
  type RunnerPorts,
  type RunnerSchedule,
  type RunNotice,
} from './pass.js';
