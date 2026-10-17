/**
 * The pipeline of tools (ADR 0024). Only its factory and types leave core;
 * the read access and the raw client stay inside.
 *
 * @packageDocumentation
 */
export {
  createToolPipeline,
  type ToolOutcome,
  type ToolPipeline,
  type ToolPipelineOptions,
  type ToolRequest,
} from './pipeline.js';
