/**
 * MCP over HTTP: the entry of the place ingress of the server (ADR 0073),
 * the subpath ./http of the package. The place is the only code that
 * imports hono and the Hono adapter of the MCP SDK, and the only code that
 * listens on a port, with createServer of node:http.
 *
 * - `createHttpApp` builds the application: checks of `Host` and `Origin`,
 *   the sign-in, the checks of the body and the handler of the SDK.
 * - `listenHttp` builds it and binds it with the bridge of node:http, its
 *   limits and the rule for the address.
 * - `parseAllowedHosts` reads the list of hosts a request may name.
 *
 * It hands out only functions and types of its own folder, never the
 * mount, the handler or an object of the SDK, of Hono or of node:http.
 *
 * @packageDocumentation
 */
export {
  createHttpApp,
  type HttpApp,
  type HttpAppOptions,
  type HttpConnection,
  mcpPath,
} from './app.js';
export { maxHttpBodyBytes, maxHttpBodyDepth } from './body.js';
export {
  type AllowedHost,
  type AllowedHostsResult,
  loopbackHosts,
  parseAllowedHost,
  parseAllowedHosts,
} from './hosts.js';
export {
  HttpBindError,
  type HttpBindReason,
  type HttpLimits,
  type HttpListener,
  type HttpListenOptions,
  httpLimits,
  listenHttp,
  maxHttpHeaderBytes,
} from './listen.js';
