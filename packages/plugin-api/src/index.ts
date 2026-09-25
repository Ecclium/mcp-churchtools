/**
 * Contract between the core and its plugins: tenant context, tool contract
 * and audit event.
 *
 * Published separately, with its own semantic version, so that a plugin can
 * be built against this package alone. It imports no other workspace package
 * and keeps no module-level state: every plugin brings its own copy, and all
 * copies must still agree on brands and registries.
 * Exports carry explicit types (isolatedDeclarations), so the published API
 * is visible in the source and cannot change through inference elsewhere
 * (ADR 0022).
 *
 * @packageDocumentation
 */
export {};
