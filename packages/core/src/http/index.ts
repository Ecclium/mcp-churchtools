/**
 * The single outbound path of core (ADR 0022, draft ADR 0009). Its HTTP
 * client will check the host allow-list before it opens a connection and be
 * the only code in the packages that opens network connections. Until it
 * follows in phase 1 the module stays empty; it exists because
 * tests/architecture/boundaries.json names the folder.
 *
 * @packageDocumentation
 */
export {};
