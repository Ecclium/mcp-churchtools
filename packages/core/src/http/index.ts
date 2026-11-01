/**
 * The single outbound path of core (ADR 0022, ADR 0056). Its HTTP
 * transport checks every target against its one origin before it opens a
 * connection, and it is the only code in the packages that opens network
 * connections. The check of the configured address is here as well,
 * because the allow-list holds exactly the origin it gives (ADR 0055).
 *
 * Other modules of core reach the outbound path only through this entry
 * point. It passes on {@link Secret}, the type of the transport and its
 * error with the category, which the escape hatch reads to tell an answer
 * that is too large from other failures (ADR 0067). It passes on neither
 * `revealSecret`, which only modules inside this folder use (ADR 0054),
 * nor a way to build a transport: only the composition root builds one,
 * through the subpath `./http` of core (ADR 0056).
 *
 * @packageDocumentation
 */
export { type FailureCategory, HttpTransportError } from './failure.js';
export {
  type OriginCode,
  originCodes,
  type OriginResult,
  parseChurchToolsOrigin,
} from './origin.js';
export { Secret } from './secret.js';
export type {
  HttpRequestOptions,
  HttpResponse,
  HttpTransport,
  HttpWriteOptions,
} from './transport.js';
