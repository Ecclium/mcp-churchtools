/**
 * Composition root and the `ecclium` command with all its subcommands.
 *
 * As the composition root it may import every runtime package, and it
 * decides which implementation serves each port. It is published as the
 * product package, bundled except for zod and the plugin API (ADR 0022).
 *
 * @packageDocumentation
 */
export {};
