import { loadConfig } from '@ecclium/mcp-churchtools-core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeCanary } from '../canary.js';
import {
  createChurchToolsDouble,
  doubleOrigin,
  doubleUserAgent,
} from './index.js';

// The double needs a Secret of core. Outside core, the configuration is
// the one public way to get one: over stdio it takes the token from the
// environment.

const canary = makeCanary('token');
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const double = (origin?: string) => {
  const built = createChurchToolsDouble(
    origin === undefined ? { token } : { token, origin },
  );
  open.push(built);
  return built;
};

describe('createChurchToolsDouble', () => {
  it('answers from its interceptors through the real transport', async () => {
    const built = double();
    built
      .intercept({ path: '/api/whoami', method: 'GET' })
      .reply(200, '{"data":{"id":1}}', {
        headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' },
      });
    const answer = await built.transport.get(
      new URL(`${doubleOrigin}/api/whoami`),
      { maxResponseBytes: 1024 },
    );
    expect(answer.status).toBe(200);
    expect({ ...answer.headers }).toEqual({
      'content-type': 'application/json',
    });
    built.assertNoPendingInterceptors();
    expect(built.calls()).toEqual([
      {
        method: 'GET',
        path: '/api/whoami',
        searchParams: {},
        headers: {
          authorization: `Login ${canary.value}`,
          accept: 'application/json',
          'accept-encoding': 'identity',
          'user-agent': doubleUserAgent,
        },
      },
    ]);
  });

  it('connects nowhere for a request without an interceptor', async () => {
    const built = double();
    await expect(
      built.transport.get(new URL(`${doubleOrigin}/api/whoami`), {
        maxResponseBytes: 1024,
      }),
    ).rejects.toMatchObject({ category: 'failed' });
  });

  it('keeps the checks of the transport', async () => {
    const built = double();
    await expect(
      built.transport.get(new URL('https://other.example/api'), {
        maxResponseBytes: 1024,
      }),
    ).rejects.toMatchObject({ category: 'refused' });
    expect(built.calls()).toEqual([]);
  });

  it('serves the placeholder instance unless told otherwise', () => {
    expect(doubleOrigin).toBe('https://example.church.tools');
    expect(doubleUserAgent).toBe('Ecclium/0.0.0-test');
    expect(() => double('https://demo.example/')).toThrow(TypeError);
    expect(() =>
      createChurchToolsDouble({
        token: { value: 1 } as unknown as typeof token,
      }),
    ).toThrow(TypeError);
  });

  it('gives no way to switch the network on', () => {
    const built = double();
    expect(Reflect.ownKeys(built)).toEqual([
      'transport',
      'intercept',
      'calls',
      'assertNoPendingInterceptors',
      'close',
    ]);
    expect(Object.isFrozen(built)).toBe(true);
  });
});
