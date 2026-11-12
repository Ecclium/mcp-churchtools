/**
 * The policy of the server (ADR 0032): its form `policy.v1`, the policy
 * without a file, its hash, its JSON Schema and the proposals of `ecclium
 * policy init`. The loader of the configuration reads the file; this
 * entry passes on no zod schema, no pattern and neither the reader of
 * YAML nor that of the file.
 *
 * @packageDocumentation
 */
export { defaultPolicy, targetKeyOf } from './check.js';
export {
  maxPolicyFileBytes,
  type PolicyCode,
  policyCodes,
  type PolicyFileSystem,
} from './file.js';
export { policyHashOf } from './hash.js';
export {
  minProposedPerDay,
  type ProposalInput,
  type ProposedCategory,
  type ProposedTarget,
  proposedMaxPerDay,
  renderPolicyProposal,
} from './proposal.js';
export {
  renderRoutineProposal,
  type RoutineProposalInput,
  type RoutineProposalNote,
  type RoutineProposalPage,
  routineMaxPerDay,
} from './routine-proposal.js';
export {
  type InteractiveEntry,
  type InteractiveTarget,
  type ModelRedaction,
  modelRedactionLevels,
  type Policy,
  policyJsonSchema,
  policyLimits,
  type PolicyTargetKind,
  type UnattendedEntry,
  type UnattendedTarget,
} from './schema.js';
