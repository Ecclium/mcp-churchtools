// Runs in its own Vitest process, started by tests/http-transport-tls.test.mts,
// once as it is and once with NODE_TLS_REJECT_UNAUTHORIZED=0. Nothing
// trusts the certificate of the server here.
import { inspect } from 'node:util';

import { assertNoCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  canary,
  logged,
  origin,
  throughProxy,
  throughServer,
} from './server.mts';

describe('a transport against a certificate nothing trusts', () => {
  it('refuses the connection with the category tls', async () => {
    const { transport } = throughServer('a', (_, response) => {
      response.end('never');
    });
    const error: unknown = await transport
      .get(new URL(`${origin}/api/whoami`), { maxResponseBytes: 64 })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toMatchObject({ category: 'tls', code: 'network' });
    assertNoCanary(
      inspect(error, { depth: null, showHidden: true }),
      [canary],
      'error',
    );
    assertNoCanary(logged, [canary], 'log');
    expect(logged.map((line) => line.event)).toEqual(['http_tls']);
    await transport.close();
  });
});

// Through a proxy as well (ADR 0035): the tunnel puts TLS to the origin
// under the same explicit check, whatever NODE_TLS_REJECT_UNAUTHORIZED
// says.
describe('a transport through a proxy against a certificate nothing trusts', () => {
  it('refuses the connection inside the tunnel with the category tls', async () => {
    const { transport, close } = await throughProxy('a', (_, response) => {
      response.end('never');
    });
    const error: unknown = await transport
      .get(new URL(`${origin}/api/whoami`), { maxResponseBytes: 64 })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toMatchObject({ category: 'tls', code: 'network' });
    await transport.destroy();
    await close();
  });
});
