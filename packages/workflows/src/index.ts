/**
 * Routines and policies with their versioned schemas, the routine engine and
 * the model provider for OpenAI-compatible APIs.
 *
 * So far: the format of routines, `routine.v1`, with its check (ADR 0033).
 *
 * @packageDocumentation
 */
export {
  checkBlockFields,
  checkRoutine,
  draftChannels,
  notifyChannels,
  routineBlocks,
  type RoutineCheckCode,
  routineCheckCodes,
  type RoutineCheckResult,
  routineFieldOf,
} from './routine/check.js';
export {
  checkSchedule,
  type ScheduleCheck,
  type ScheduleFieldName,
  scheduleFieldNames,
  type ScheduleProblem,
} from './routine/schedule.js';
export {
  type Routine,
  type RoutineBlock,
  type RoutineCheck,
  type RoutineCheckName,
  routineCheckNames,
  type RoutineField,
  type RoutineFile,
  type RoutineGenerate,
  type RoutineInput,
  routineJsonSchema,
  routineLimits,
  type RoutineOutput,
  type RoutineParamValue,
  type RoutinePeriod,
  routinePeriods,
  routineRedactionLevels,
} from './routine/schema.js';
