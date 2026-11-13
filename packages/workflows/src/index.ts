/**
 * Routines and policies with their versioned schemas, the routine engine and
 * the model provider for OpenAI-compatible APIs.
 *
 * So far: the format of routines, `routine.v1`, with its check, the check
 * of its template and the loader of a folder of routines, the adapter for
 * chat interfaces in the style of OpenAI, and the engine of a run up to
 * before its write (ADR 0033).
 *
 * @packageDocumentation
 */
export {
  checkBlockFields,
  checkRoutine,
  checkTools,
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
export {
  type AnswerCheck,
  checkAnswer,
  type FilledBlocks,
  unnamedPerson,
} from './run/answer.js';
export {
  type CheckContext,
  type ChecksResult,
  hiddenTitle,
  mainPageName,
  runChecks,
  type WikiLink,
  wikiLinksIn,
} from './run/checks.js';
export {
  executeRun,
  runLimits,
  type RunPorts,
  type RunResult,
  type RunStep,
} from './run/execute.js';
export {
  type InputResults,
  type InputsResult,
  readInputs,
  type RunRead,
  runReadLimits,
} from './run/inputs.js';
export {
  outputSpecOf,
  type RunAnswer,
  runAnswerName,
  type RunAnswerValue,
} from './run/output-spec.js';
export {
  maxRelativeDays,
  type PreparedInput,
  type PreparedRun,
  prepareRun,
  type RunPrepareCode,
  runPrepareCodes,
  type RunPrepareContext,
  type RunPrepareResult,
  type RunCredential,
  runCredentialOf,
} from './run/prepare.js';
export { renderSection } from './run/render.js';
export { accountToolsOf } from './run/account.js';
export {
  type RenderedRun,
  type RunWrite,
  type RunWriteCall,
  type RunWritePorts,
  type RunWriteResult,
  type RunWriteTarget,
  writeRun,
} from './run/write.js';
