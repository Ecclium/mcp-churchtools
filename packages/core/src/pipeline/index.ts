/**
 * The pipeline of tools (ADR 0024). Only its factory and types leave core;
 * the read access and the raw client stay inside.
 *
 * @packageDocumentation
 */
export {
  type AdoptCall,
  type AdoptOutcome,
  type ApproveOutcome,
  type ApproveReason,
  type ConfirmationAnswer,
  type ConfirmationQuestion,
  createToolPipeline,
  type QueueCall,
  type QueueListOutcome,
  type QueueShowOutcome,
  type RejectOutcome,
  type RunCallOutcome,
  type RunCallRequest,
  type RunEndRequest,
  type RunTag,
  type RunWriteOutcome,
  type RunWriteRequest,
  type ToolOutcome,
  type ToolPipeline,
  type ToolPipelineOptions,
  type ToolRequest,
  maxAdoptionWrites,
  type UndoCall,
  type UndoOutcome,
  type UndoReason,
  type UndoSubject,
} from './pipeline.js';
export {
  type AccountRights,
  accountRightsOf,
  type RightsException,
  type RunPageRef,
} from './run-write.js';
