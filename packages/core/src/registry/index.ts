/**
 * The registry of tools: the checks of every tool, the host plugins add
 * their tools to and the frozen catalog the pipeline runs (ADR 0024).
 *
 * @packageDocumentation
 */
export { descriptionBudget, untrustedWarning } from './description.js';
export {
  type RefusalReason,
  refusalReasons,
  RegistryRefusal,
} from './refusal.js';
export {
  type CatalogEntry,
  type CatalogOptions,
  createToolCatalog,
  type ToolCatalog,
} from './registry.js';
export type {
  LeafType,
  ObjectJsonSchema,
  OutputShape,
  ShapeNode,
  ShapePresence,
} from './schema.js';
