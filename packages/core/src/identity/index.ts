/**
 * Identities and resolvers (ADR 0037): of a start over stdio (ADR 0055)
 * and of a sign-in with a static bearer token over HTTP (ADR 0074), and
 * the fixed reasons to refuse a sign-in.
 *
 * @packageDocumentation
 */
export { createBearerTenantResolver } from './bearer.js';
export {
  isSignInRefusal,
  presentedCredential,
  type SignInRefusal,
  signInRefusals,
  type SignInResult,
} from './refusals.js';
export { createStdioIdentity, createStdioTenantResolver } from './stdio.js';
