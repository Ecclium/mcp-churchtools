/**
 * Composition root and the `ecclium` command with all its subcommands.
 *
 * As the composition root it may import every runtime package, and it
 * decides which implementation serves each port. It is published as the
 * product package, bundled except for zod and the plugin API (ADR 0022).
 *
 * @packageDocumentation
 */
// Plain texts for the generated reference, no texts of the catalog of
// messages, so they stay out of its entry (see its test).
export { variableDescriptions } from './messages/variables.js';
