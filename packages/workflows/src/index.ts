/**
 * Routines and policies with their versioned schemas, the routine engine and
 * the model provider for OpenAI-compatible APIs.
 *
 * So far: the format of routines, `routine.v1`, with its check, the check
 * of its template and the loader of a folder of routines, and the adapter
 * for chat interfaces in the style of OpenAI (ADR 0033).
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
  type LoadedRoutine,
  loadRoutines,
  type RoutineFileSystem,
  routineFileLimits,
  type RoutineLoadCode,
  routineLoadCodes,
  type RoutineLoadProblem,
  type RoutineLoadResult,
} from './routine/loader.js';
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
export {
  parseTemplate,
  periodTag,
  type Template,
  type TemplateCode,
  templateCodes,
  type TemplateLeaf,
  type TemplateNode,
  type TemplateResult,
} from './routine/template.js';
export {
  createOpenAiCompatibleProvider,
  openAiCompatibleLimits,
  type OpenAiCompatibleOptions,
} from './model/openai-compatible.js';
