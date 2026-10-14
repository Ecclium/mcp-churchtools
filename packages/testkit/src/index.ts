/**
 * Test helpers: request handlers for a simulated ChurchTools, synthetic
 * fixtures, a mock model provider and a fake clock. Only tests use this
 * package: other packages may depend on it as a devDependency only, so it
 * is never shipped (ADR 0022).
 *
 * @packageDocumentation
 */
export {
  assertNoCanary,
  assertPlanted,
  findCanaries,
  makeCanaries,
  makeCanary,
  makeControlValue,
  type Canary,
  type CanaryFinding,
  type CanaryKind,
  type CanarySet,
} from './canary.js';
