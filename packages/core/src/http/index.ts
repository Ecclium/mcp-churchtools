/**
 * The single outbound path of core: the HTTP transport, which checks the
 * host allow-list before it opens a connection and is the only code that
 * opens network connections at all (ADR 0022, draft ADR 0009). It follows
 * in phase 1.
 *
 * @packageDocumentation
 */
export {};
