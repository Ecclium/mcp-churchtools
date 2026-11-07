// Child process for tests/scripts/smoke-write.test.mts: serves the stand-in
// of church-tools.mts on 127.0.0.1 in a process of its own. The smoke test
// runs `ecclium undo`, `queue` and `audit verify` with spawnSync, which
// blocks the event loop of the test; a stand-in in the test process could
// not answer those commands then.
//
// Two ports: TLS with the certificate of demo.example for the real server,
// which tests/fixtures/start/redirect.mts sends here, and plain HTTP for
// the reads of the guard, which the test forwards from its fetch. Both
// answer from one state. On the plain port, `/__calls` and `/__state` give
// the log and the state to the test; no request of ChurchTools has such a
// path. The first line on stdout names both ports. The process ends when
// its stdin closes, so that it never outlives the test.
import { readFileSync } from 'node:fs';
import {
  createServer as createPlainServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import process from 'node:process';

import {
  createChurchTools,
  type StandInCall,
  type StandInConfig,
} from './church-tools.mts';

const config = JSON.parse(
  process.env['STAND_IN_CONFIG'] ?? '{}',
) as StandInConfig;
const standIn = createChurchTools(config);

const reply = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  if (status === 204 || body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const handler =
  (via: StandInCall['via']) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'https://demo.example');
      if (via === 'guard' && url.pathname === '/__calls') {
        reply(response, 200, standIn.calls());
        return;
      }
      if (via === 'guard' && url.pathname === '/__state') {
        reply(response, 200, standIn.state());
        return;
      }
      const answer = standIn.respond(
        {
          method: request.method ?? 'GET',
          url,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        },
        via,
      );
      reply(response, answer.status, answer.body);
    });
  };

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

const tls = createTlsServer(
  {
    key: readFileSync(process.env['STAND_IN_KEY'] ?? ''),
    cert: readFileSync(process.env['STAND_IN_CERT'] ?? ''),
  },
  handler('server'),
);
const plain = createPlainServer(handler('guard'));
const ports = { tls: await listen(tls), plain: await listen(plain) };
process.stdout.write(`${JSON.stringify(ports)}\n`);

process.stdin.resume();
process.stdin.on('end', () => {
  tls.closeAllConnections();
  plain.closeAllConnections();
  tls.close();
  plain.close();
  process.exit(0);
});
