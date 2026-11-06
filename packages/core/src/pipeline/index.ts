/**
 * The pipeline of tools (ADR 0024). Only its factory and types leave core;
 * the read access and the raw client stay inside.
 *
 * @packageDocumentation
 */
export {
  type ApproveOutcome,
  type ApproveReason,
  type ConfirmationAnswer,
  type ConfirmationQuestion,
  createToolPipeline,
  type QueueCall,
  type QueueListOutcome,
  type QueueShowOutcome,
  type RejectOutcome,
  type ToolOutcome,
  type ToolPipeline,
  type ToolPipelineOptions,
  type ToolRequest,
  type UndoCall,
  type UndoOutcome,
  type UndoReason,
  type UndoSubject,
} from './pipeline.js';
