// A TLS server in memory for the fixtures of tests/http-transport-tls.test.mts.
// The transport gets one end of a pair of streams as its socket; this end
// serves TLS and HTTP on the other, so no port opens and no name resolves.
// Key and certificate come from the folder the parent test names in
// HTTP_FIXTURE_DIR; nothing of them lies in the repository.
import { readFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { duplexPair } from 'node:stream';
import { createSecureContext, TLSSocket } from 'node:tls';

import type { Logger, LogFields } from '@ecclium/mcp-churchtools-plugin-api';
import type { Canary } from '@ecclium/mcp-churchtools-testkit';

import { Secret } from '../../../packages/core/src/http/secret.ts';
import {
  createAgent,
  createTransport,
  type HttpTransport,
  type TransportLimits,
  transportLimits,
} from '../../../packages/core/src/http/transport.ts';

const folder = process.env.HTTP_FIXTURE_DIR ?? '';
if (folder === '') throw new Error('HTTP_FIXTURE_DIR is not set');

/** The origin of every transport here; certificate a names it. */
export const origin = 'https://demo.example';

/** The User-Agent of every transport here. */
export const userAgent = 'Ecclium/0.0.0-test';

/** The token of the transports, a canary the parent test made. */
export const canary: Canary = Object.freeze({
  kind: 'token',
  value: process.env.HTTP_FIXTURE_TOKEN ?? '',
  cores: Object.freeze((process.env.HTTP_FIXTURE_CORES ?? '').split(',')),
  minFragment: 8,
});
const token = new Secret(canary.value);

/** What a server saw. */
export interface Seen {
  /** The protocol the TLS handshake agreed on. */
  alpn: string | false | null | undefined;
}

/** Lines the transport logged. */
export const logged: { event: string; fields: LogFields | undefined }[] = [];

const record = (event: string, fields?: LogFields): void => {
  logged.push({ event, fields });
};

const logger: Logger = Object.freeze({
  debug: record,
  info: record,
  warn: record,
  error: record,
});

/**
 * Builds a transport whose every connection goes to a server in memory
 * with the given certificate.
 *
 * @param name - Which key and certificate the server shows, a or b.
 * @param handler - Answers the requests.
 * @param limits - Limits other than those of production.
 * @param poolLimits - Limits of the pool alone, over those of the
 *   transport, so that a case can tell the pool from the transport.
 * @returns The transport and what the server saw.
 */
export function throughServer(
  name: 'a' | 'b',
  handler: RequestListener,
  limits: Partial<TransportLimits> = {},
  poolLimits: Partial<TransportLimits> = {},
): { transport: HttpTransport; seen: Seen } {
  const secureContext = createSecureContext({
    key: readFileSync(join(folder, `${name}.key`)),
    cert: readFileSync(join(folder, `${name}.crt`)),
  });
  const server = createServer(handler);
  const seen: Seen = { alpn: undefined };
  const merged = { ...transportLimits, ...limits };
  const agent = createAgent({ ...merged, ...poolLimits }, () => {
    const [client, other] = duplexPair();
    const tls = new TLSSocket(other, {
      isServer: true,
      secureContext,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    tls.on('secure', () => {
      seen.alpn = tls.alpnProtocol;
    });
    tls.on('error', () => undefined);
    server.emit('connection', tls);
    return client as unknown as Socket;
  });
  const transport = createTransport(agent, {
    origin,
    token,
    userAgent,
    logger,
    clock: { now: () => Date.now() },
    limits: merged,
  });
  return { transport, seen };
}
