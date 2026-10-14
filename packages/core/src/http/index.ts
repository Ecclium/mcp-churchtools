/**
 * The single outbound path of core (ADR 0022, draft ADR 0009). Its HTTP
 * client will check the host allow-list before it opens a connection and be
 * the only code in the packages that opens network connections. It follows
 * in phase 1.
 *
 * Other modules reach the outbound path only through this entry point. It
 * passes on {@link Secret}, but not `revealSecret`: only modules inside this
 * folder turn a secret back into its value (ADR 0054).
 *
 * @packageDocumentation
 */
export { Secret } from './secret.js';
